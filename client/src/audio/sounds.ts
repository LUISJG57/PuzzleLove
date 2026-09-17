/**
 * All sounds are synthesized with the Web Audio API, so there are no audio files to license
 * or download. The snap is a short wooden "tock": a resonant body tone, a bright click
 * transient and a low thump, with slightly random pitch so repeated snaps don't sound robotic.
 */
import { readBool, safeSet } from '../lib/player';

const MUTE_KEY = 'pl.muted';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = readBool(MUTE_KEY, false);

  /** Must be called from a user gesture at least once (browsers block autoplay). */
  unlock() {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    safeSet(MUTE_KEY, muted ? '1' : '0');
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    const master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(comp).connect(ctx.destination);

    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.25), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.noise = buf;
    return ctx;
  }

  private ready() {
    if (this.muted) return null;
    const ctx = this.ensure();
    if (!ctx || !this.master || ctx.state !== 'running') return null;
    return { ctx, out: this.master };
  }

  private tone(freq: number, start: number, decay: number, gain: number, type: OscillatorType = 'sine', attack = 0.002) {
    const r = this.ready();
    if (!r) return;
    const { ctx, out } = r;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
    osc.connect(g).connect(out);
    osc.start(start);
    osc.stop(start + attack + decay + 0.05);
  }

  private noiseBurst(start: number, duration: number, freq: number, q: number, gain: number) {
    const r = this.ready();
    if (!r || !this.noise) return;
    const { ctx, out } = r;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    src.connect(bp).connect(g).connect(out);
    src.start(start);
    src.stop(start + duration + 0.02);
  }

  /** Soft tick when picking up a piece. */
  grab() {
    const r = this.ready();
    if (!r) return;
    const t = r.ctx.currentTime;
    this.noiseBurst(t, 0.025, 3800, 2, 0.06);
    this.tone(1400 + Math.random() * 200, t, 0.03, 0.03, 'triangle');
  }

  /** Wooden snap when pieces connect. `intensity` 0..1 (remote players are quieter). */
  snap(intensity = 1, pieces = 1) {
    const r = this.ready();
    if (!r) return;
    const t = r.ctx.currentTime;
    const v = Math.max(0.15, Math.min(1, intensity));
    const pitch = 620 + Math.random() * 180 - Math.min(pieces, 20) * 4;
    this.noiseBurst(t, 0.018, 2600, 1.4, 0.45 * v);
    this.tone(pitch, t, 0.09, 0.5 * v, 'triangle');
    this.tone(pitch * 2.76, t, 0.04, 0.16 * v, 'sine');
    this.tone(150, t, 0.08, 0.35 * v, 'sine');
    // A tiny second knock makes it feel like the piece settles in.
    this.noiseBurst(t + 0.045, 0.012, 3200, 1.6, 0.14 * v);
    this.tone(pitch * 1.5, t + 0.045, 0.035, 0.1 * v, 'triangle');
  }

  /** Marimba-style arpeggio plus a shimmer for completing the puzzle. */
  win() {
    const r = this.ready();
    if (!r) return;
    const t = r.ctx.currentTime + 0.05;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98];
    notes.forEach((f, i) => {
      const s = t + i * 0.09;
      this.tone(f, s, 0.7, 0.28, 'sine', 0.004);
      this.tone(f * 4, s, 0.12, 0.05, 'sine', 0.002);
    });
    const chord = t + notes.length * 0.09 + 0.08;
    [1046.5, 1318.5, 1567.98, 2093].forEach((f) => this.tone(f, chord, 1.6, 0.12, 'sine', 0.01));
    for (let i = 0; i < 10; i++) {
      this.tone(2600 + Math.random() * 2400, chord + 0.1 + i * 0.07, 0.25, 0.03, 'sine');
    }
  }
}

export const sounds = new SoundEngine();
