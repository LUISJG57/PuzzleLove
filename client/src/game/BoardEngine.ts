import Konva from 'konva';
import {
  computeLayout,
  generatePieceShapes,
  neighborsOf,
  type GroupMove,
  type PieceShape,
  type PuzzleLayout,
  type PuzzleMeta,
  type PuzzleState,
  type SnapEvent,
} from '@puzzlelove/shared';
import { sounds } from '../audio/sounds';
import { GLOW_MARGIN, pieceBox, renderGlow, renderPieces } from './pieceRender';

// Needed so two-finger pinch keeps receiving events while something is being dragged.
Konva.hitOnDragEnabled = true;

export interface EngineCallbacks {
  grab(groupId: number): Promise<boolean>;
  move(groupId: number, x: number, y: number): void;
  release(groupId: number, x: number, y: number): void;
  cursor(x: number, y: number): void;
  progress(connected: number, total: number): void;
  view(x: number, y: number, scale: number): void;
}

export interface RemoteCursor {
  id: string;
  x: number;
  y: number;
  name: string;
  color: string;
}

interface GroupEntry {
  id: number;
  node: Konva.Group;
  pieces: number[];
  lockedColor: string | null;
  target: { x: number; y: number } | null;
}

interface CursorEntry {
  node: Konva.Group;
  label: Konva.Text;
  tag: Konva.Tag;
  target: { x: number; y: number };
}

/** Short-lived visual effect that follows the group of `anchorPiece`. */
interface Fx {
  node: Konva.Shape;
  anchorPiece: number;
  lx: number;
  ly: number;
  age: number;
  life: number;
  update(fx: Fx, t: number): void;
}

const MIN_SCALE = 0.08;
const MAX_SCALE = 4;
const MOVE_SEND_MS = 40;
const CURSOR_SEND_MS = 90;
const LIFT_SHADOW_MAX_PIECES = 30;

export class BoardEngine {
  private stage: Konva.Stage;
  private bgLayer = new Konva.Layer({ listening: false });
  private pieceLayer = new Konva.Layer();
  private fxLayer = new Konva.Layer({ listening: false });
  private cursorLayer = new Konva.Layer({ listening: false });
  private anim: Konva.Animation;

  private meta: PuzzleMeta | null = null;
  private layout: PuzzleLayout | null = null;
  private shapes: PieceShape[] = [];
  private image: HTMLImageElement | null = null;
  private glowCache = new Map<number, HTMLCanvasElement>();
  private groups = new Map<number, GroupEntry>();
  private pieceToGroup = new Map<number, GroupEntry>();
  private silhouette: Konva.Group | null = null;
  private silhouetteVisible = true;
  private cursors = new Map<string, CursorEntry>();
  private fx: Fx[] = [];
  private timeouts: number[] = [];

  private dragging: number | null = null;
  private lastMoveSent = 0;
  private lastCursorSent = 0;
  private pinch: { dist: number; center: { x: number; y: number } } | null = null;
  private viewAnim: number | null = null;
  private completed = false;
  private destroyed = false;

  constructor(
    private readonly container: HTMLDivElement,
    private readonly cb: EngineCallbacks,
  ) {
    this.stage = new Konva.Stage({
      container,
      width: container.clientWidth,
      height: container.clientHeight,
      draggable: true,
    });
    this.stage.add(this.bgLayer, this.pieceLayer, this.fxLayer, this.cursorLayer);
    this.anim = new Konva.Animation((frame) => this.step(frame?.timeDiff ?? 16), [
      this.pieceLayer,
      this.fxLayer,
      this.cursorLayer,
    ]);
    this.anim.start();
    this.bindStageEvents();
  }

  // ------------------------------------------------------------------ setup

  load(meta: PuzzleMeta, image: HTMLImageElement, state: PuzzleState, locks: Record<number, string>, colorOf: (id: string) => string) {
    this.clearPuzzle();
    this.meta = meta;
    this.image = image;
    this.layout = computeLayout(meta);
    this.shapes = generatePieceShapes(meta, this.layout);
    this.completed = !!state.completedAt;
    const layout = this.layout;
    const { canvases } = renderPieces(image, layout, this.shapes);

    this.silhouette = new Konva.Group({ visible: this.silhouetteVisible && !this.completed });
    this.silhouette.add(
      new Konva.Rect({
        x: -6,
        y: -6,
        width: layout.width + 12,
        height: layout.height + 12,
        fill: 'rgba(255,255,255,0.75)',
        stroke: '#cfcfdc',
        strokeWidth: 2,
        dash: [10, 8],
        cornerRadius: 10,
      }),
      new Konva.Image({ image, x: 0, y: 0, width: layout.width, height: layout.height, opacity: 0.16 }),
    );
    this.bgLayer.add(this.silhouette);

    for (const g of state.groups) {
      const node = new Konva.Group({ x: g.x, y: g.y, draggable: !this.completed });
      const entry: GroupEntry = { id: g.id, node, pieces: [...g.pieces], lockedColor: null, target: null };
      for (const pid of g.pieces) {
        const shape = this.shapes[pid];
        const box = pieceBox(shape, layout);
        const img = new Konva.Image({
          image: canvases[pid],
          x: box.x,
          y: box.y,
          width: box.w,
          height: box.h,
          name: 'piece',
          id: `p${pid}`,
          perfectDrawEnabled: false,
        });
        img.hitFunc((ctx, konvaShape) => {
          const p = shape.path;
          ctx.beginPath();
          ctx.moveTo(p.from.x - box.x, p.from.y - box.y);
          for (const s of p.segs) {
            ctx.bezierCurveTo(s.c1.x - box.x, s.c1.y - box.y, s.c2.x - box.x, s.c2.y - box.y, s.to.x - box.x, s.to.y - box.y);
          }
          ctx.closePath();
          ctx.fillStrokeShape(konvaShape);
        });
        node.add(img);
        this.pieceToGroup.set(pid, entry);
      }
      this.bindGroupEvents(entry);
      this.groups.set(g.id, entry);
      this.pieceLayer.add(node);
    }

    // Smaller groups on top so single pieces are never hidden under big clusters.
    [...this.groups.values()]
      .sort((a, b) => b.pieces.length - a.pieces.length)
      .forEach((e) => e.node.moveToTop());

    for (const [gid, by] of Object.entries(locks)) this.lock(Number(gid), colorOf(by));

    if (this.completed) this.showFinishedImage(false);
    this.emitProgress();
    this.bgLayer.batchDraw();
    this.pieceLayer.batchDraw();
    this.fitView(false);
  }

  private clearPuzzle() {
    for (const t of this.timeouts) clearTimeout(t);
    this.timeouts = [];
    for (const f of this.fx) f.node.destroy();
    this.fx = [];
    this.pieceLayer.destroyChildren();
    this.bgLayer.destroyChildren();
    this.fxLayer.destroyChildren();
    this.groups.clear();
    this.pieceToGroup.clear();
    this.glowCache.clear();
    this.dragging = null;
    this.silhouette = null;
  }

  destroy() {
    this.destroyed = true;
    this.clearPuzzle();
    if (this.viewAnim) cancelAnimationFrame(this.viewAnim);
    this.anim.stop();
    this.stage.destroy();
  }

  resize(width: number, height: number) {
    this.stage.size({ width, height });
    this.emitView();
  }

  setSilhouetteVisible(visible: boolean) {
    this.silhouetteVisible = visible;
    if (this.silhouette && !this.completed) {
      this.silhouette.visible(visible);
      this.bgLayer.batchDraw();
    }
  }

  // ------------------------------------------------------------------ input

  private bindStageEvents() {
    const stage = this.stage;

    stage.on('dragmove', (e) => {
      if (e.target === stage) this.emitView();
    });

    stage.on('wheel', (e) => {
      e.evt.preventDefault();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const factor = Math.exp(-e.evt.deltaY * (e.evt.ctrlKey ? 0.01 : 0.0015));
      this.zoomAt(pointer, stage.scaleX() * factor);
    });

    stage.on('touchmove', (e) => {
      const touches = e.evt.touches;
      if (touches.length !== 2 || this.dragging !== null) return;
      e.evt.preventDefault();
      if (stage.isDragging()) stage.stopDrag();
      const rect = this.container.getBoundingClientRect();
      const p1 = { x: touches[0].clientX - rect.left, y: touches[0].clientY - rect.top };
      const p2 = { x: touches[1].clientX - rect.left, y: touches[1].clientY - rect.top };
      const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (!this.pinch) {
        this.pinch = { dist, center };
        return;
      }
      const old = stage.scaleX();
      const pointTo = { x: (center.x - stage.x()) / old, y: (center.y - stage.y()) / old };
      const scale = clamp(old * (dist / this.pinch.dist), MIN_SCALE, MAX_SCALE);
      const dx = center.x - this.pinch.center.x;
      const dy = center.y - this.pinch.center.y;
      stage.scale({ x: scale, y: scale });
      stage.position({ x: center.x - pointTo.x * scale + dx, y: center.y - pointTo.y * scale + dy });
      this.pinch = { dist, center };
      this.emitView();
    });

    stage.on('touchend touchcancel', () => {
      this.pinch = null;
    });

    stage.on('mousemove touchmove', () => {
      const now = performance.now();
      if (now - this.lastCursorSent < CURSOR_SEND_MS) return;
      const pos = stage.getRelativePointerPosition();
      if (!pos) return;
      this.lastCursorSent = now;
      this.cb.cursor(pos.x, pos.y);
    });

    stage.on('pointerdown', () => sounds.unlock());
  }

  private bindGroupEvents(entry: GroupEntry) {
    const node = entry.node;

    node.on('dragstart', () => {
      if (this.pinch || entry.lockedColor || this.completed) {
        node.stopDrag();
        return;
      }
      this.dragging = entry.id;
      entry.target = null;
      node.moveToTop();
      this.setLift(entry, 'rgba(0,0,0,0.35)');
      sounds.grab();
      const start = { x: node.x(), y: node.y() };
      this.cb.grab(entry.id).then((ok) => {
        if (ok || this.groups.get(entry.id) !== entry || this.destroyed) return;
        if (node.isDragging()) node.stopDrag();
        if (this.dragging === entry.id) this.dragging = null;
        this.setLift(entry, null);
        node.to({ x: start.x, y: start.y, duration: 0.2, easing: Konva.Easings.EaseOut });
      });
    });

    node.on('dragmove', () => {
      if (this.dragging !== entry.id) return;
      const now = performance.now();
      if (now - this.lastMoveSent >= MOVE_SEND_MS) {
        this.lastMoveSent = now;
        this.cb.move(entry.id, node.x(), node.y());
      }
    });

    node.on('dragend', () => {
      if (this.dragging !== entry.id) return;
      this.dragging = null;
      this.setLift(entry, null);
      this.cb.release(entry.id, node.x(), node.y());
    });
  }

  private setLift(entry: GroupEntry, color: string | null) {
    const pieces = entry.node.find<Konva.Image>('.piece');
    const useShadow = pieces.length <= LIFT_SHADOW_MAX_PIECES;
    for (const img of pieces) {
      if (color && useShadow) {
        img.shadowColor(color);
        img.shadowBlur(color.startsWith('rgba(0') ? 14 : 12);
        img.shadowOffset(color.startsWith('rgba(0') ? { x: 3, y: 5 } : { x: 0, y: 0 });
        img.shadowOpacity(color.startsWith('rgba(0') ? 0.5 : 1);
        img.shadowEnabled(true);
      } else {
        img.shadowEnabled(false);
      }
    }
    entry.node.opacity(color && !useShadow && !color.startsWith('rgba(0') ? 0.85 : 1);
  }

  // ------------------------------------------------------------------ view

  private zoomAt(pointer: { x: number; y: number }, nextScale: number) {
    const stage = this.stage;
    const old = stage.scaleX();
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const world = { x: (pointer.x - stage.x()) / old, y: (pointer.y - stage.y()) / old };
    stage.scale({ x: scale, y: scale });
    stage.position({ x: pointer.x - world.x * scale, y: pointer.y - world.y * scale });
    this.emitView();
  }

  zoomBy(factor: number) {
    this.zoomAt({ x: this.stage.width() / 2, y: this.stage.height() / 2 }, this.stage.scaleX() * factor);
  }

  private emitView() {
    const s = this.stage.scaleX();
    for (const c of this.cursors.values()) c.node.scale({ x: 1 / s, y: 1 / s });
    this.cb.view(this.stage.x(), this.stage.y(), s);
    this.cursorLayer.batchDraw();
  }

  fitView(animate = true) {
    if (!this.layout) return;
    const { width: W, height: H } = this.layout;
    let minX = -10;
    let minY = -10;
    let maxX = W + 10;
    let maxY = H + 10;
    if (!this.completed) {
      for (const e of this.groups.values()) {
        const r = e.node.getClientRect({ relativeTo: this.pieceLayer, skipShadow: true });
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width);
        maxY = Math.max(maxY, r.y + r.height);
      }
    }
    const sw = this.stage.width();
    const sh = this.stage.height();
    const topInset = 64;
    const scale = clamp(Math.min(sw / (maxX - minX), (sh - topInset) / (maxY - minY)) * 0.92, MIN_SCALE, MAX_SCALE);
    const x = sw / 2 - ((minX + maxX) / 2) * scale;
    const y = topInset / 2 + sh / 2 - ((minY + maxY) / 2) * scale;
    this.animateView(x, y, scale, animate ? 450 : 0);
  }

  private animateView(x: number, y: number, scale: number, duration: number) {
    if (this.viewAnim) cancelAnimationFrame(this.viewAnim);
    const stage = this.stage;
    if (duration <= 0) {
      stage.position({ x, y });
      stage.scale({ x: scale, y: scale });
      this.emitView();
      return;
    }
    const from = { x: stage.x(), y: stage.y(), s: stage.scaleX() };
    const start = performance.now();
    const frame = (now: number) => {
      if (this.destroyed) return;
      const t = Math.min(1, (now - start) / duration);
      const k = 1 - Math.pow(1 - t, 3);
      stage.position({ x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k });
      const s = from.s + (scale - from.s) * k;
      stage.scale({ x: s, y: s });
      this.emitView();
      this.viewAnim = t < 1 ? requestAnimationFrame(frame) : null;
    };
    this.viewAnim = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ network updates

  applyMoves(moves: GroupMove[]) {
    for (const m of moves) {
      const e = this.groups.get(m.g);
      if (!e || this.dragging === m.g) continue;
      e.target = { x: m.x, y: m.y };
    }
  }

  lock(groupId: number, color: string) {
    const e = this.groups.get(groupId);
    if (!e) return;
    e.lockedColor = color;
    e.node.draggable(false);
    e.node.moveToTop();
    this.setLift(e, color);
  }

  unlock(groupId: number, x: number, y: number) {
    const e = this.groups.get(groupId);
    if (!e || this.dragging === groupId) return;
    if (e.lockedColor) {
      e.lockedColor = null;
      this.setLift(e, null);
    }
    e.node.draggable(!this.completed);
    e.target = { x, y };
  }

  snap(ev: SnapEvent, mine: boolean) {
    const survivor = this.groups.get(ev.groupId);
    if (!survivor || !this.layout) return;
    const movedPieces: number[] = [];
    const existing = new Set(survivor.pieces);

    for (const gid of [ev.groupId, ...ev.removed]) {
      const e = this.groups.get(gid);
      if (!e) continue;
      if (e.node.isDragging()) e.node.stopDrag();
      if (this.dragging === gid) this.dragging = null;
      const dx = e.node.x() - ev.x;
      const dy = e.node.y() - ev.y;
      for (const img of e.node.find<Konva.Image>('.piece')) {
        const pid = Number(img.id().slice(1));
        const box = pieceBox(this.shapes[pid], this.layout);
        if (gid !== ev.groupId) {
          img.moveTo(survivor.node);
          movedPieces.push(pid);
        }
        // Start from where the piece was on screen and glide into place.
        img.position({ x: box.x + dx, y: box.y + dy });
        img.to({ x: box.x, y: box.y, duration: 0.14, easing: Konva.Easings.EaseOut });
      }
      if (gid !== ev.groupId) {
        e.node.destroy();
        this.groups.delete(gid);
      }
    }

    survivor.node.position({ x: ev.x, y: ev.y });
    survivor.pieces = [...ev.pieces];
    survivor.target = null;
    survivor.lockedColor = null;
    survivor.node.draggable(!this.completed);
    for (const pid of ev.pieces) this.pieceToGroup.set(pid, survivor);
    this.setLift(survivor, null);
    survivor.node.moveToTop();

    // Effects: glow the pieces that just joined and sparkle along the new seams.
    const joined = ev.removed.length > 0 ? (movedPieces.length <= survivor.pieces.length / 2 ? movedPieces : [...existing]) : ev.pieces;
    const t = window.setTimeout(() => {
      if (this.destroyed || !this.layout) return;
      joined.slice(0, 40).forEach((pid) => this.addGlow(pid, 0));
      this.sparkleSeams(joined, ev.frame && ev.removed.length === 0);
      sounds.snap(mine ? 1 : 0.45, ev.pieces.length);
    }, 120);
    this.timeouts.push(t);
    this.emitProgress();
  }

  complete() {
    if (!this.layout) return;
    this.completed = true;
    const entry = [...this.groups.values()][0];
    if (!entry) return;
    if (entry.node.isDragging()) entry.node.stopDrag();
    this.dragging = null;
    entry.node.draggable(false);
    entry.node.to({ x: 0, y: 0, duration: 0.6, easing: Konva.Easings.EaseInOut });
    this.emitProgress();

    const t = window.setTimeout(() => {
      if (this.destroyed || !this.layout || !this.meta) return;
      this.silhouette?.visible(false);
      this.bgLayer.batchDraw();
      this.fitView(true);
      const { cols } = this.meta;
      entry.pieces.forEach((pid) => {
        const row = Math.floor(pid / cols);
        const col = pid % cols;
        this.addGlow(pid, (row + col) * 0.05);
      });
      this.showFinishedImage(true);
    }, 650);
    this.timeouts.push(t);
  }

  /** Fades in the full image over the pieces so the finished puzzle looks seamless, then sweeps a shine. */
  private showFinishedImage(animate: boolean) {
    if (!this.layout || !this.image) return;
    const { width: W, height: H } = this.layout;
    const full = new Konva.Image({ image: this.image, x: 0, y: 0, width: W, height: H, opacity: animate ? 0 : 1, listening: false });
    this.pieceLayer.add(full);
    const frame = new Konva.Rect({
      x: 0,
      y: 0,
      width: W,
      height: H,
      stroke: 'rgba(255,255,255,0.9)',
      strokeWidth: 3,
      shadowColor: '#000',
      shadowBlur: 30,
      shadowOpacity: 0.25,
      cornerRadius: 2,
      listening: false,
    });
    this.pieceLayer.add(frame);
    if (!animate) return;
    frame.opacity(0);
    const delay = (this.meta ? this.meta.rows + this.meta.cols : 10) * 50 + 200;
    const t = window.setTimeout(() => {
      if (this.destroyed) return;
      full.to({ opacity: 1, duration: 0.8, easing: Konva.Easings.EaseInOut });
      frame.to({ opacity: 1, duration: 0.8 });
      this.addShine(W, H);
    }, delay);
    this.timeouts.push(t);
  }

  private addShine(W: number, H: number) {
    const band = W * 0.35;
    const shine = new Konva.Rect({
      x: -band,
      y: 0,
      width: band,
      height: H,
      listening: false,
      globalCompositeOperation: 'lighter',
      fillLinearGradientStartPoint: { x: 0, y: 0 },
      fillLinearGradientEndPoint: { x: band, y: 0 },
      fillLinearGradientColorStops: [0, 'rgba(255,255,255,0)', 0.5, 'rgba(255,255,255,0.45)', 1, 'rgba(255,255,255,0)'],
    });
    const clip = new Konva.Group({ clipX: 0, clipY: 0, clipWidth: W, clipHeight: H, listening: false });
    clip.add(shine);
    this.fxLayer.add(clip);
    shine.to({
      x: W,
      duration: 1.1,
      easing: Konva.Easings.EaseInOut,
      onFinish: () => clip.destroy(),
    });
  }

  // ------------------------------------------------------------------ cursors

  setCursors(list: RemoteCursor[]) {
    const s = this.stage.scaleX();
    for (const c of list) {
      let entry = this.cursors.get(c.id);
      if (!entry) {
        const node = new Konva.Group({ x: c.x, y: c.y, scale: { x: 1 / s, y: 1 / s } });
        const arrow = new Konva.Path({
          data: 'M0 0 L0 17 L4.5 13 L7.5 20 L10.5 18.7 L7.6 12 L13 12 Z',
          fill: c.color,
          stroke: '#fff',
          strokeWidth: 1.5,
          shadowColor: '#000',
          shadowBlur: 3,
          shadowOpacity: 0.25,
        });
        const label = new Konva.Label({ x: 12, y: 18 });
        const tag = new Konva.Tag({ fill: c.color, cornerRadius: 6 });
        const text = new Konva.Text({ text: c.name, fontFamily: 'Nunito, sans-serif', fontStyle: '800', fontSize: 12, fill: '#fff', padding: 4 });
        label.add(tag, text);
        node.add(arrow, label);
        this.cursorLayer.add(node);
        entry = { node, label: text, tag, target: { x: c.x, y: c.y } };
        this.cursors.set(c.id, entry);
      }
      entry.target = { x: c.x, y: c.y };
      if (entry.label.text() !== c.name) entry.label.text(c.name);
    }
  }

  removeCursor(id: string) {
    const c = this.cursors.get(id);
    if (!c) return;
    c.node.destroy();
    this.cursors.delete(id);
  }

  // ------------------------------------------------------------------ effects

  private addGlow(pid: number, delaySec: number) {
    if (!this.layout) return;
    let canvas = this.glowCache.get(pid);
    if (!canvas) {
      canvas = renderGlow(this.shapes[pid], this.layout);
      this.glowCache.set(pid, canvas);
    }
    const box = pieceBox(this.shapes[pid], this.layout);
    const node = new Konva.Image({ image: canvas, opacity: 0, listening: false });
    this.fxLayer.add(node);
    this.fx.push({
      node,
      anchorPiece: pid,
      lx: box.x - GLOW_MARGIN,
      ly: box.y - GLOW_MARGIN,
      age: -delaySec,
      life: 0.75,
      update: (f, t) => {
        f.node.visible(f.age >= 0);
        f.node.opacity(t < 0.2 ? t / 0.2 : Math.max(0, 1 - (t - 0.2) / 0.8));
      },
    });
  }

  private sparkleSeams(joined: number[], frameSnap: boolean) {
    if (!this.layout || !this.meta) return;
    const { cellW, cellH } = this.layout;
    const s = Math.min(cellW, cellH);
    const joinedSet = new Set(joined);
    const points: { pid: number; x: number; y: number }[] = [];
    for (const pid of joined) {
      const shape = this.shapes[pid];
      const cx = shape.x + cellW / 2;
      const cy = shape.y + cellH / 2;
      if (frameSnap) {
        points.push({ pid, x: cx, y: cy });
        continue;
      }
      for (const n of neighborsOf(pid, this.meta.rows, this.meta.cols)) {
        if (joinedSet.has(n) || this.pieceToGroup.get(n) !== this.pieceToGroup.get(pid)) continue;
        const ns = this.shapes[n];
        points.push({ pid, x: (cx + ns.x + cellW / 2) / 2, y: (cy + ns.y + cellH / 2) / 2 });
      }
    }
    for (const p of points.slice(0, 10)) {
      const ring = new Konva.Circle({ radius: 1, stroke: '#ffd166', strokeWidth: Math.max(2, s * 0.03), listening: false });
      this.fxLayer.add(ring);
      this.fx.push({
        node: ring,
        anchorPiece: p.pid,
        lx: p.x,
        ly: p.y,
        age: 0,
        life: 0.5,
        update: (f, t) => {
          (f.node as Konva.Circle).radius(1 + s * 0.5 * easeOut(t));
          f.node.opacity(1 - t);
        },
      });
      const count = 7;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.6;
        const speed = s * (0.35 + Math.random() * 0.45);
        const dot = new Konva.Star({
          numPoints: 4,
          innerRadius: s * 0.012,
          outerRadius: s * (0.03 + Math.random() * 0.025),
          fill: i % 2 ? '#fff4c2' : '#ffc94d',
          listening: false,
        });
        this.fxLayer.add(dot);
        const ox = p.x;
        const oy = p.y;
        this.fx.push({
          node: dot,
          anchorPiece: p.pid,
          lx: ox,
          ly: oy,
          age: 0,
          life: 0.55 + Math.random() * 0.2,
          update: (f, t) => {
            const d = speed * easeOut(t);
            f.lx = ox + Math.cos(angle) * d;
            f.ly = oy + Math.sin(angle) * d;
            f.node.rotation(t * 180);
            f.node.opacity(1 - t);
            f.node.scale({ x: 1 - t * 0.5, y: 1 - t * 0.5 });
          },
        });
      }
    }
  }

  // ------------------------------------------------------------------ frame loop

  private step(dtMs: number): boolean {
    const dt = Math.min(dtMs, 100) / 1000;
    let changed = false;
    const k = 1 - Math.exp(-dt * 16);

    for (const e of this.groups.values()) {
      if (!e.target) continue;
      const nx = e.node.x() + (e.target.x - e.node.x()) * k;
      const ny = e.node.y() + (e.target.y - e.node.y()) * k;
      if (Math.hypot(e.target.x - nx, e.target.y - ny) < 0.3) {
        e.node.position(e.target);
        e.target = null;
      } else {
        e.node.position({ x: nx, y: ny });
      }
      changed = true;
    }

    const kc = 1 - Math.exp(-dt * 12);
    for (const c of this.cursors.values()) {
      const dx = c.target.x - c.node.x();
      const dy = c.target.y - c.node.y();
      if (Math.abs(dx) + Math.abs(dy) < 0.2) continue;
      c.node.position({ x: c.node.x() + dx * kc, y: c.node.y() + dy * kc });
      changed = true;
    }

    if (this.fx.length > 0) {
      changed = true;
      this.fx = this.fx.filter((f) => {
        f.age += dt;
        if (f.age >= f.life) {
          f.node.destroy();
          return false;
        }
        const t = Math.max(0, f.age) / f.life;
        f.update(f, t);
        const g = this.pieceToGroup.get(f.anchorPiece);
        if (g) f.node.position({ x: g.node.x() + f.lx, y: g.node.y() + f.ly });
        return true;
      });
    }

    // Konva tweens redraw their own layers; only redraw here when something moved.
    return changed;
  }

  private emitProgress() {
    if (!this.meta) return;
    const total = this.meta.rows * this.meta.cols;
    let connected = 0;
    for (const e of this.groups.values()) if (e.pieces.length > 1) connected += e.pieces.length;
    this.cb.progress(this.completed ? total : connected, total);
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function easeOut(t: number) {
  return 1 - Math.pow(1 - t, 3);
}
