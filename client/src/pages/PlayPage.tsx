import confetti from 'canvas-confetti';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { io, type Socket } from 'socket.io-client';
import {
  GLOBAL_ROOM,
  type ClientToServerEvents,
  type CompletedEvent,
  type JoinError,
  type PlayerInfo,
  type RoomMeta,
  type RoomSnapshot,
  type ServerToClientEvents,
} from '@puzzlelove/shared';
import { sounds } from '../audio/sounds';
import {
  IconClock,
  IconFit,
  IconGhost,
  IconImage,
  IconLink,
  IconMinus,
  IconMute,
  IconPlus,
  IconPuzzle,
  IconUsers,
  IconVolume,
} from '../components/Icons';
import { LanguageSwitch } from '../components/LanguageSwitch';
import { NameDialog } from '../components/NameDialog';
import { VictoryOverlay, formatDuration } from '../components/VictoryOverlay';
import { BoardEngine } from '../game/BoardEngine';
import { loadPlayer, readBool, safeSet, type LocalPlayer } from '../lib/player';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function PlayPage() {
  const { slug } = useParams();
  const room = slug ?? GLOBAL_ROOM;
  const [player, setPlayer] = useState<LocalPlayer | null>(loadPlayer);
  const [editing, setEditing] = useState(false);

  if (!player || editing) {
    return (
      <NameDialog
        initial={player}
        onDone={(p) => {
          setPlayer(p);
          setEditing(false);
        }}
      />
    );
  }
  return <Game key={`${room}|${player.name}|${player.color}`} room={room} player={player} onEditName={() => setEditing(true)} />;
}

interface GameProps {
  room: string;
  player: LocalPlayer;
  onEditName: () => void;
}

function Game({ room, player, onEditName }: GameProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<BoardEngine | null>(null);
  const socketRef = useRef<ClientSocket | null>(null);
  const playersRef = useRef(new Map<string, PlayerInfo>());
  const queueRef = useRef<(() => void)[] | null>(null);
  const loadIdRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);

  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [joinError, setJoinError] = useState<JoinError | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [meta, setMeta] = useState<RoomMeta | null>(null);
  const [players, setPlayers] = useState<PlayerInfo[]>([]);
  const [progress, setProgress] = useState({ connected: 0, total: 0 });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedDuration, setFinishedDuration] = useState<number | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [completed, setCompleted] = useState<CompletedEvent | null>(null);
  const [showVictory, setShowVictory] = useState(false);
  const [showPlayers, setShowPlayers] = useState(false);
  const [showReference, setShowReference] = useState(() => readBool('pl.reference', false));
  const [silhouette, setSilhouette] = useState(() => readBool('pl.silhouette', true));
  const [muted, setMuted] = useState(sounds.muted);
  const [copied, setCopied] = useState(false);
  const [showHint, setShowHint] = useState(() => !readBool('pl.hintSeen', false));

  const syncPlayers = useCallback(() => setPlayers([...playersRef.current.values()]), []);

  const markStarted = useCallback((at: number) => {
    if (startedAtRef.current !== null) return;
    startedAtRef.current = at;
    setStartedAt(at);
  }, []);

  // Board engine lifecycle.
  useEffect(() => {
    const container = containerRef.current!;
    const engine = new BoardEngine(container, {
      grab: (groupId) =>
        new Promise((resolve) => {
          const socket = socketRef.current;
          if (!socket?.connected) return resolve(false);
          socket.timeout(5000).emit('group:grab', { groupId }, (err: Error | null, ok: boolean) => {
            if (!err && ok) markStarted(Date.now());
            resolve(!err && ok);
          });
        }),
      move: (g, x, y) => socketRef.current?.volatile.emit('group:move', { g, x, y }),
      release: (g, x, y) => socketRef.current?.emit('group:release', { g, x, y }),
      cursor: (x, y) => socketRef.current?.volatile.emit('cursor', { x, y }),
      progress: (connected, total) => setProgress({ connected, total }),
      view: (x, y, scale) => {
        const size = 26 * scale;
        container.style.backgroundSize = `${size}px ${size}px`;
        container.style.backgroundPosition = `${x}px ${y}px`;
      },
    });
    engineRef.current = engine;
    if (import.meta.env.DEV) (window as unknown as { __engine?: BoardEngine }).__engine = engine;
    const ro = new ResizeObserver(() => engine.resize(container.clientWidth, container.clientHeight));
    ro.observe(container);
    return () => {
      ro.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, [markStarted]);

  // Socket lifecycle.
  useEffect(() => {
    const socket: ClientSocket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    const players = playersRef.current;
    const colorOf = (id: string) => players.get(id)?.color ?? '#94a3b8';

    /** Runs now, or after the current puzzle finishes loading so no update is lost. */
    const whenLoaded = (fn: () => void) => {
      if (queueRef.current) queueRef.current.push(fn);
      else fn();
    };

    const loadSnapshot = async (snap: RoomSnapshot) => {
      const loadId = ++loadIdRef.current;
      queueRef.current = [];
      players.clear();
      for (const p of snap.players) players.set(p.id, p);
      syncPlayers();
      setMeta(snap.meta);
      const offset = snap.serverNow - Date.now();
      setClockOffset(offset);
      startedAtRef.current = snap.state.startedAt;
      setStartedAt(snap.state.startedAt);
      setFinishedDuration(
        snap.state.completedAt && snap.state.startedAt ? snap.state.completedAt - snap.state.startedAt : null,
      );
      setCompleted(null);
      setShowVictory(false);

      const img = new Image();
      img.src = snap.meta.imageUrl;
      try {
        await img.decode();
      } catch {
        if (loadId === loadIdRef.current) {
          setJoinError('invalid');
          setStatus('error');
        }
        return;
      }
      if (loadId !== loadIdRef.current || !engineRef.current) return;
      engineRef.current.load(snap.meta, img, snap.state, snap.locks, colorOf);
      engineRef.current.setSilhouetteVisible(readBool('pl.silhouette', true));
      const queued = queueRef.current ?? [];
      queueRef.current = null;
      queued.forEach((fn) => fn());
      setStatus('ready');
    };

    socket.on('connect', () => {
      setReconnecting(false);
      socket.emit('room:join', { room, name: player.name, color: player.color, clientId: player.clientId }, (res) => {
        if (res.ok) {
          setJoinError(null);
          void loadSnapshot(res.snapshot);
        } else {
          setJoinError(res.error);
          setStatus('error');
          socket.disconnect();
        }
      });
    });
    socket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') setReconnecting(true);
    });

    socket.on('room:snapshot', (snap) => void loadSnapshot(snap));
    socket.on('player:joined', (p) => {
      players.set(p.id, p);
      syncPlayers();
    });
    socket.on('player:left', (id) => {
      players.delete(id);
      syncPlayers();
      whenLoaded(() => engineRef.current?.removeCursor(id));
    });
    socket.on('group:locked', ({ groupId, by }) => {
      markStarted(Date.now());
      whenLoaded(() => engineRef.current?.lock(groupId, colorOf(by)));
    });
    socket.on('group:unlocked', ({ groupId, x, y }) => whenLoaded(() => engineRef.current?.unlock(groupId, x, y)));
    socket.on('groups:moved', (moves) => whenLoaded(() => engineRef.current?.applyMoves(moves)));
    socket.on('group:snapped', (ev) => {
      markStarted(Date.now());
      whenLoaded(() => engineRef.current?.snap(ev, ev.by === socket.id));
    });
    socket.on('cursors:moved', (list) =>
      whenLoaded(() => {
        const visible = [];
        for (const c of list) {
          const p = players.get(c.id);
          if (p && c.id !== socket.id) visible.push({ ...c, name: p.name, color: p.color });
        }
        engineRef.current?.setCursors(visible);
      }),
    );
    socket.on('puzzle:completed', (data) =>
      whenLoaded(() => {
        engineRef.current?.complete();
        setFinishedDuration(data.durationMs);
        setCompleted(data);
        window.setTimeout(() => sounds.win(), 500);
        window.setTimeout(() => celebrate(), 900);
        window.setTimeout(() => setShowVictory(true), 2200);
      }),
    );

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [room, player, syncPlayers, markStarted]);

  useEffect(() => {
    engineRef.current?.setSilhouetteVisible(silhouette);
    safeSet('pl.silhouette', silhouette ? '1' : '0');
  }, [silhouette]);

  useEffect(() => {
    safeSet('pl.reference', showReference ? '1' : '0');
  }, [showReference]);

  useEffect(() => {
    if (!showHint || status !== 'ready') return;
    const id = window.setTimeout(() => dismissHint(), 9000);
    return () => clearTimeout(id);
  }, [showHint, status]);

  const dismissHint = () => {
    setShowHint(false);
    safeSet('pl.hintSeen', '1');
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      window.prompt(t('play.copyLink'), window.location.href);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const toggleMute = () => {
    sounds.unlock();
    sounds.setMuted(!muted);
    setMuted(!muted);
  };

  if (status === 'error') {
    const message =
      joinError === 'not_found'
        ? t('play.notFound')
        : joinError === 'full'
          ? t('play.full')
          : joinError === 'no_puzzle'
            ? t('play.noPuzzle')
            : t('play.genericError');
    return (
      <div className="center-page">
        <div className="card message-card">
          <div className="big-emoji" aria-hidden="true">
            🧩
          </div>
          <p>{message}</p>
          <div className="row gap">
            <a className="btn primary" href="/">
              {t('play.goGlobal')}
            </a>
            <Link className="btn" to="/new">
              {t('play.createRoom')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const isGlobal = meta?.isGlobal ?? room === GLOBAL_ROOM;
  const shownPlayers = players.slice(0, 50);

  return (
    <div className="play">
      <div ref={containerRef} className="board" />

      <header className="hud hud-top">
        <div className="pill brand-pill">
          <a href="/" className="brand">
            <span aria-hidden="true">🧩</span>
            <span className="brand-name">PuzzleLove</span>
          </a>
          <span className="divider" />
          <span className="room-label">{isGlobal ? t('play.global') : t('play.private')}</span>
          {!isGlobal && (
            <button type="button" className="icon-btn" onClick={copyLink} title={t('play.copyLink')} aria-label={t('play.copyLink')}>
              <IconLink />
            </button>
          )}
        </div>

        <div className="pill stats-pill">
          <span className="stat" title={t('play.pieces', { connected: progress.connected, total: progress.total })}>
            <IconPuzzle />
            <span>
              {progress.connected}/{progress.total}
            </span>
          </span>
          <span className="stat">
            <IconClock />
            <Timer startedAt={startedAt} finishedDuration={finishedDuration} offset={clockOffset} />
          </span>
          <div className="players-anchor">
            <button
              type="button"
              className={`icon-btn with-label ${showPlayers ? 'active' : ''}`}
              onClick={() => setShowPlayers((v) => !v)}
              aria-expanded={showPlayers}
              title={t('play.players', { count: players.length })}
            >
              <IconUsers />
              <span>{players.length}</span>
            </button>
            {showPlayers && (
              <div className="card players-panel">
                <div className="field-label">{t('play.players', { count: players.length })}</div>
                <ul>
                  {shownPlayers.map((p) => {
                    const me = p.id === socketRef.current?.id;
                    return (
                      <li key={p.id}>
                        <span className="dot" style={{ background: p.color }} />
                        {me ? (
                          <button type="button" className="link-btn" onClick={onEditName}>
                            {p.name} <span className="muted">({t('play.you')}) ✎</span>
                          </button>
                        ) : (
                          <span>{p.name}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {players.length > shownPlayers.length && <div className="muted small">+{players.length - shownPlayers.length}</div>}
              </div>
            )}
          </div>
          <LanguageSwitch />
        </div>
      </header>

      <div className="hud hud-bottom">
        {isGlobal && (
          <Link className="btn primary create-btn" to="/new">
            <IconPlus />
            <span>{t('play.createRoom')}</span>
          </Link>
        )}
        <div className="pill toolbar">
          <ToolButton active={showReference} label={t('play.reference')} onClick={() => setShowReference((v) => !v)}>
            <IconImage />
          </ToolButton>
          <ToolButton active={silhouette} label={t('play.silhouette')} onClick={() => setSilhouette((v) => !v)}>
            <IconGhost />
          </ToolButton>
          <span className="divider" />
          <ToolButton label="-" onClick={() => engineRef.current?.zoomBy(1 / 1.25)}>
            <IconMinus />
          </ToolButton>
          <ToolButton label={t('play.fit')} onClick={() => engineRef.current?.fitView(true)}>
            <IconFit />
          </ToolButton>
          <ToolButton label="+" onClick={() => engineRef.current?.zoomBy(1.25)}>
            <IconPlus />
          </ToolButton>
          <span className="divider" />
          <ToolButton label={muted ? t('play.unmute') : t('play.mute')} onClick={toggleMute}>
            {muted ? <IconMute /> : <IconVolume />}
          </ToolButton>
        </div>
      </div>

      {showReference && meta && (
        <button type="button" className="card reference" onClick={() => setShowReference(false)} aria-label={t('common.close')}>
          <img src={meta.imageUrl} alt={t('play.reference')} />
        </button>
      )}

      {copied && <div className="toast">{t('play.copied')}</div>}
      {status === 'ready' && showHint && (
        <button type="button" className="toast hint" onClick={dismissHint}>
          {t('play.hint')}
        </button>
      )}
      {(status === 'connecting' || reconnecting) && (
        <div className="loading-overlay">
          <div className="spinner" />
          <span>{reconnecting ? t('play.reconnecting') : t('play.connecting')}</span>
        </div>
      )}

      {completed && showVictory && (
        <VictoryOverlay
          data={completed}
          isGlobal={isGlobal}
          clockOffset={clockOffset}
          myClientId={player.clientId}
          onClose={() => setShowVictory(false)}
          onAgain={() => socketRef.current?.emit('puzzle:restart')}
        />
      )}
    </div>
  );
}

function ToolButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? 'active' : ''}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function Timer({ startedAt, finishedDuration, offset }: { startedAt: number | null; finishedDuration: number | null; offset: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (finishedDuration !== null || startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt, finishedDuration]);
  if (finishedDuration !== null) return <span>{formatDuration(finishedDuration)}</span>;
  if (startedAt === null) return <span>0:00</span>;
  return <span>{formatDuration(now + offset - startedAt)}</span>;
}

function celebrate() {
  const colors = ['#f43f5e', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'];
  const end = Date.now() + 1800;
  confetti({ particleCount: 140, spread: 100, origin: { y: 0.6 }, colors, zIndex: 34 });
  const frame = () => {
    confetti({ particleCount: 4, angle: 60, spread: 60, origin: { x: 0, y: 0.7 }, colors, zIndex: 34 });
    confetti({ particleCount: 4, angle: 120, spread: 60, origin: { x: 1, y: 0.7 }, colors, zIndex: 34 });
    if (Date.now() < end) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
