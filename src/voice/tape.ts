// The tape in the voice dock: a short scrolling record of who has been talking.
// Blue bars are the author, orange bars are the agent, a travelling segment
// means the agent is editing (or the session is still connecting).
//
// It only draws. Levels come in from outside: the author's from the capture
// worklet's RMS (about ten a second), the agent's from whatever the caller
// passes to setAgentLevelSource.

export type TapeMode = 'off' | 'connecting' | 'listening' | 'speaking' | 'working';
export type TapeFloor = 'human' | 'agent' | 'quiet';

interface Bar {
  v: number;
  who: TapeFloor;
}

const BAR_PX = 3;
const GAP_PX = 2;
const PUSH_MS = 50;
const FADE_BARS = 10;
// Below this (after the decibel mapping) the author counts as quiet.
const SPEECH_FLOOR = 0.12;
const REDUCED_SEGMENTS = 5;
const REDUCED_REFRESH_MS = 250;

// RMS to 0..1 on a decibel scale: -50 dBFS is silence, -10 dBFS is full height.
// A linear map clips on a loud talker and barely moves for a quiet one.
export function levelToUnit(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms + 1e-5);
  return Math.max(0, Math.min(1, (db + 50) / 40));
}

export class VoiceTape {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly reducedMotion: boolean;
  private bars: Bar[] = [];
  private capacity = 0;
  private mode: TapeMode = 'off';
  private muted = false;
  private authorTarget = 0;
  private author = 0;
  private agent = 0;
  private peak: Bar = { v: 0, who: 'quiet' };
  private lastPush = 0;
  private lastReducedDraw = 0;
  private raf: number | null = null;
  private floor: TapeFloor = 'quiet';
  private agentLevelSource: (() => number) | null = null;
  private colors = { human: '#8FB0FF', agent: '#FF9A52', quiet: 'rgba(255, 255, 255, 0.28)' };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFloorChange: (floor: TapeFloor) => void,
  ) {
    this.ctx = canvas.getContext('2d');
    this.reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Measured agent loudness (RMS, 0..1). Without one, agent bars are drawn at
  // a plausible height while the agent is speaking.
  setAgentLevelSource(source: (() => number) | null): void {
    this.agentLevelSource = source;
  }

  setAuthorLevel(rms: number): void {
    this.authorTarget = levelToUnit(rms);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  setMode(mode: TapeMode): void {
    if (mode === this.mode) return;
    const wasOff = this.mode === 'off';
    this.mode = mode;
    if (mode === 'off') {
      this.stop();
      return;
    }
    if (wasOff) this.start();
  }

  private start(): void {
    this.readColors();
    this.resize();
    this.bars = [];
    this.author = 0;
    this.agent = 0;
    this.lastPush = 0;
    if (this.raf === null) this.raf = requestAnimationFrame(this.frame);
  }

  private stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.bars = [];
    this.authorTarget = 0;
    this.setFloor('quiet');
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private readColors(): void {
    const style = getComputedStyle(this.canvas);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    this.colors = {
      human: read('--pl-human-on-ink', this.colors.human),
      agent: read('--pl-agent-on-ink', this.colors.agent),
      quiet: this.colors.quiet,
    };
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth || 168;
    const height = this.canvas.clientHeight || 28;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.capacity = Math.max(8, Math.floor((width + GAP_PX) / (BAR_PX + GAP_PX)));
  }

  private setFloor(floor: TapeFloor): void {
    if (floor === this.floor) return;
    this.floor = floor;
    this.onFloorChange(floor);
  }

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    // The dock changes width between phone and desktop layouts.
    if ((this.canvas.clientWidth || 168) !== Math.round(this.canvas.width / (window.devicePixelRatio || 1))) this.resize();

    // Fast attack, slow release, so ten readings a second draw as speech rather than steps.
    const authorTarget = this.muted ? 0 : this.authorTarget;
    this.author += (authorTarget - this.author) * (authorTarget > this.author ? 0.5 : 0.12);

    let agentTarget = 0;
    if (this.mode === 'speaking') {
      agentTarget = this.agentLevelSource
        ? levelToUnit(this.safeAgentLevel())
        : 0.42 + 0.2 * Math.sin(now / 90) + 0.14 * Math.sin(now / 37);
    }
    this.agent += (agentTarget - this.agent) * (agentTarget > this.agent ? 0.5 : 0.12);

    // The author wins a shared bar: talking over the agent is the event that matters.
    let current: Bar = { v: 0.04, who: 'quiet' };
    if (this.author > SPEECH_FLOOR) current = { v: this.author, who: 'human' };
    else if (this.mode === 'speaking' && this.agent > 0.05) current = { v: this.agent, who: 'agent' };
    const rank = { quiet: 0, agent: 1, human: 2 };
    if (rank[current.who] > rank[this.peak.who] || (current.who === this.peak.who && current.v > this.peak.v)) {
      this.peak = current;
    }

    if (current.who !== 'quiet') this.setFloor(current.who);
    else if (this.mode === 'speaking' || this.mode === 'working') this.setFloor('agent');
    else if (this.mode === 'listening') this.setFloor('human');
    else this.setFloor('quiet');

    if (this.reducedMotion) {
      if (now - this.lastReducedDraw >= REDUCED_REFRESH_MS) {
        this.lastReducedDraw = now;
        this.drawMeter(this.peak);
        this.peak = { v: 0, who: 'quiet' };
      }
      return;
    }

    const sweeping = this.mode === 'connecting' || this.mode === 'working';
    if (!sweeping && !this.muted && now - this.lastPush >= PUSH_MS) {
      this.lastPush = now;
      this.bars.push(this.peak);
      if (this.bars.length > this.capacity) this.bars.splice(0, this.bars.length - this.capacity);
      this.peak = { v: 0, who: 'quiet' };
    }
    if (sweeping) this.drawSweep(now);
    else this.drawBars();
  };

  // A failed reading must never reach the audio path; treat it as silence.
  private safeAgentLevel(): number {
    try {
      const level = this.agentLevelSource?.() ?? 0;
      return Number.isFinite(level) ? level : 0;
    } catch {
      return 0;
    }
  }

  private bar(x: number, half: number, height: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const top = height / 2 - half;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, top, BAR_PX, half * 2, BAR_PX / 2);
    else ctx.rect(x, top, BAR_PX, half * 2);
    ctx.fill();
  }

  private drawBars(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const width = this.canvas.clientWidth || 168;
    const height = this.canvas.clientHeight || 28;
    ctx.clearRect(0, 0, width, height);
    // Newest bar on the right; the oldest few fade out on the left.
    const offset = this.capacity - this.bars.length;
    for (let slot = 0; slot < this.capacity; slot++) {
      const bar = slot >= offset ? this.bars[slot - offset] : { v: 0.04, who: 'quiet' as TapeFloor };
      const fade = slot < FADE_BARS ? 0.25 + (0.75 * slot) / FADE_BARS : 1;
      ctx.globalAlpha = fade * (this.muted ? 0.4 : 1);
      ctx.fillStyle = this.colors[bar.who];
      this.bar(slot * (BAR_PX + GAP_PX), Math.max(1, bar.v * (height / 2 - 1)), height);
    }
    ctx.globalAlpha = 1;
  }

  // A pencil moving along a line: the agent is writing, or the line is still being set up.
  private drawSweep(now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const width = this.canvas.clientWidth || 168;
    const height = this.canvas.clientHeight || 28;
    ctx.clearRect(0, 0, width, height);
    const head = ((now % 1400) / 1400) * (this.capacity + 6) - 3;
    for (let slot = 0; slot < this.capacity; slot++) {
      const distance = Math.abs(slot - head);
      const lit = Math.max(0, 1 - distance / 3);
      ctx.globalAlpha = 0.3 + 0.7 * lit;
      ctx.fillStyle = lit > 0 && this.mode === 'working' ? this.colors.agent : lit > 0 ? '#FFFFFF' : this.colors.quiet;
      this.bar(slot * (BAR_PX + GAP_PX), 1 + lit * 5, height);
    }
    ctx.globalAlpha = 1;
  }

  // Reduced motion: five still segments, lit by loudness, a few times a second.
  private drawMeter(bar: Bar): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const width = this.canvas.clientWidth || 168;
    const height = this.canvas.clientHeight || 28;
    ctx.clearRect(0, 0, width, height);
    const gap = 4;
    const segment = (width - gap * (REDUCED_SEGMENTS - 1)) / REDUCED_SEGMENTS;
    const who = bar.who !== 'quiet' ? bar.who : this.floor;
    const talking = this.mode === 'listening' || this.mode === 'speaking';
    const lit = this.muted || !talking || bar.who === 'quiet' ? 0 : Math.ceil(bar.v * REDUCED_SEGMENTS);
    for (let i = 0; i < REDUCED_SEGMENTS; i++) {
      ctx.fillStyle = i < lit && who !== 'quiet' ? this.colors[who] : this.colors.quiet;
      ctx.beginPath();
      ctx.rect(i * (segment + gap), height / 2 - 3, segment, 6);
      ctx.fill();
    }
  }
}
