// The voice control: one button that becomes a small status pill while a
// conversation is live. It stays out of the way of the document; the agent's
// work shows up in the text as suggestions, not in this panel.

import { VoiceSession, type VoiceState } from './session';
import type { VoiceEditorApi } from './tools';
import { VoiceTape, type TapeMode } from './tape';

interface LiveStatus {
  configured: boolean;
  model: string;
}

export interface VoicePanelOptions {
  getSlug(): string | null;
  getShareToken(): string | null;
  getApiBase(): string;
  getAuthorActor(): string;
  editor: VoiceEditorApi;
}

const STATE_LABEL: Record<VoiceState, string> = {
  idle: 'Talk to edit',
  connecting: 'Connecting',
  listening: 'Listening',
  speaking: 'Speaking',
  working: 'Editing',
  reconnecting: 'Reconnecting',
  error: 'Voice unavailable',
};

const TAPE_MODE: Record<VoiceState, TapeMode> = {
  idle: 'off',
  connecting: 'connecting',
  listening: 'listening',
  speaking: 'speaking',
  working: 'working',
  reconnecting: 'connecting',
  error: 'off',
};

const MIC_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const MUTED_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.5 2.6M12 18v3M4 4l16 16"/></svg>';
const END_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const STYLE = `
.voice-dock {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  z-index: 9000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-family: var(--pl-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  pointer-events: none;
}
.voice-dock > * { pointer-events: auto; }
.voice-pill {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 5px;
  border-radius: 999px;
  background: var(--pl-ink, #15171C);
  color: var(--pl-text-on-ink, #F4F5F7);
  box-shadow: var(--pl-shadow-float, 0 1px 2px rgba(21, 23, 28, 0.2), 0 8px 28px rgba(21, 23, 28, 0.18));
}
.voice-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 38px;
  min-width: 38px;
  padding: 0 10px;
  border-radius: 999px;
  cursor: pointer;
  color: inherit;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.005em;
  transition: background 120ms ease;
}
.voice-btn:hover { background: rgba(255, 255, 255, 0.1); }
.voice-btn:focus-visible { outline: 2px solid var(--pl-human-on-ink, #8FB0FF); outline-offset: 2px; }
.voice-btn[disabled] { cursor: default; opacity: 0.55; }
.voice-btn[disabled]:hover { background: none; }
.voice-main { padding: 0 14px 0 12px; }
.voice-end:hover { background: rgba(255, 138, 138, 0.16); color: var(--pl-danger-on-ink, #FF8A8A); }

/* Idle: a microphone. Live: a dot in the colour of whoever has the floor
   (blue for the author, orange for the agent), so the microphone icon appears
   once, on the mute button. */
.voice-orb {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.voice-dock[data-live="true"] .voice-orb svg { display: none; }
.voice-dock[data-live="true"] .voice-orb::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pl-text-on-ink-muted, #A9AFBA);
  transition: background 200ms ease;
}
.voice-dock[data-floor="human"] .voice-orb::before { background: var(--pl-human-on-ink, #8FB0FF); }
.voice-dock[data-floor="agent"] .voice-orb::before { background: var(--pl-agent-on-ink, #FF9A52); }
.voice-dock[data-muted="true"] .voice-orb::before {
  background: none;
  box-shadow: inset 0 0 0 1.5px var(--pl-text-on-ink-muted, #A9AFBA);
}
.voice-dock[data-state="connecting"] .voice-orb::before,
.voice-dock[data-state="reconnecting"] .voice-orb::before,
.voice-dock[data-state="working"] .voice-orb::before {
  animation: voice-pulse 1.1s ease-in-out infinite;
}
@keyframes voice-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
.voice-label { min-width: 68px; }
.voice-dock[data-live="false"] .voice-label { min-width: 0; }
.voice-time {
  color: var(--pl-text-on-ink-muted, #A9AFBA);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.voice-tape {
  display: block;
  width: 168px;
  height: 28px;
  margin: 0 8px 0 0;
  padding-left: 10px;
  box-sizing: content-box;
  border-left: 1px solid var(--pl-line-on-ink, rgba(255, 255, 255, 0.14));
}
.voice-dock[data-live="false"] .voice-tape,
.voice-dock[data-live="false"] .voice-time { display: none; }

/* What is being said, and by whom. */
.voice-caption {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: baseline;
  box-sizing: border-box;
  width: min(560px, calc(100vw - 32px));
  padding: 10px 14px 10px 13px;
  border-radius: var(--pl-radius-card, 14px);
  border-left: 3px solid var(--voice-who, transparent);
  background: var(--pl-ink, #15171C);
  color: var(--pl-text-on-ink, #F4F5F7);
  font-size: 15px;
  line-height: 1.45;
  text-align: left;
  box-shadow: var(--pl-shadow-float, 0 1px 2px rgba(21, 23, 28, 0.2), 0 8px 28px rgba(21, 23, 28, 0.18));
  animation: voice-caption-in 200ms cubic-bezier(0.2, 0, 0, 1);
}
@keyframes voice-caption-in {
  from { opacity: 0; transform: translateY(4px); }
}
.voice-caption[hidden] { display: none; }
.voice-caption[data-speaker="author"] { --voice-who: var(--pl-human-on-ink, #8FB0FF); }
.voice-caption[data-speaker="agent"] { --voice-who: var(--pl-agent-on-ink, #FF9A52); }
.voice-caption[data-tone="error"] { --voice-who: var(--pl-danger-on-ink, #FF8A8A); }
.voice-caption-who { color: var(--voice-who); font-size: 12px; font-weight: 600; white-space: nowrap; }
@media (max-width: 480px) {
  .voice-tape { width: 88px; }
  .voice-time { display: none; }
  .voice-label { min-width: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .voice-orb::before { transition: none; animation: none !important; }
  .voice-caption { animation: none; }
}
@media print { .voice-dock { display: none; } }
`;

const CAPTION_LINGER_MS = 4500;
const MAX_CAPTION_CHARS = 220;

export class VoicePanel {
  private readonly dock = document.createElement('div');
  private readonly mainButton = document.createElement('button');
  private readonly mainLabel = document.createElement('span');
  private readonly muteButton = document.createElement('button');
  private readonly endButton = document.createElement('button');
  private readonly caption = document.createElement('div');
  private readonly captionWho = document.createElement('span');
  private readonly captionBody = document.createElement('span');
  private readonly time = document.createElement('span');
  private readonly tapeCanvas = document.createElement('canvas');
  private readonly tape = new VoiceTape(this.tapeCanvas, (floor) => {
    this.dock.dataset.floor = floor;
  });
  private liveSince: number | null = null;
  private clock: number | null = null;
  private session: VoiceSession | null = null;
  private captionSpeaker: 'author' | 'agent' | null = null;
  private captionText = '';
  private captionTimer: number | null = null;
  private status: LiveStatus | null = null;

  constructor(private readonly options: VoicePanelOptions) {}

  async mount(): Promise<void> {
    this.status = await fetch(`${this.options.getApiBase()}/live/status`)
      .then((response) => (response.ok ? (response.json() as Promise<LiveStatus>) : null))
      .catch(() => null);
    // No voice routes on this server: leave the editor exactly as it was.
    if (!this.status) return;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.dock.className = 'voice-dock';
    this.dock.setAttribute('role', 'region');
    this.dock.setAttribute('aria-label', 'Voice editing');

    this.caption.className = 'voice-caption';
    this.caption.hidden = true;
    this.caption.setAttribute('aria-live', 'polite');
    this.captionWho.className = 'voice-caption-who';
    this.caption.append(this.captionWho, this.captionBody);

    const pill = document.createElement('div');
    pill.className = 'voice-pill';

    this.mainButton.className = 'voice-btn voice-main';
    this.mainButton.type = 'button';
    const orb = document.createElement('span');
    orb.className = 'voice-orb';
    orb.innerHTML = MIC_ICON;
    this.mainLabel.className = 'voice-label';
    this.time.className = 'voice-time';
    this.mainButton.append(orb, this.mainLabel, this.time);
    this.mainButton.addEventListener('click', () => void this.handleMainClick());

    // Decorative: the state label and the caption carry the meaning.
    this.tapeCanvas.className = 'voice-tape';
    this.tapeCanvas.setAttribute('aria-hidden', 'true');

    this.muteButton.className = 'voice-btn';
    this.muteButton.type = 'button';
    this.muteButton.addEventListener('click', () => this.toggleMute());

    this.endButton.className = 'voice-btn voice-end';
    this.endButton.type = 'button';
    this.endButton.innerHTML = END_ICON;
    this.endButton.setAttribute('aria-label', 'End voice session');
    this.endButton.title = 'End voice session';
    this.endButton.addEventListener('click', () => void this.end());

    pill.append(this.mainButton, this.tapeCanvas, this.muteButton, this.endButton);
    this.dock.append(this.caption, pill);
    document.body.appendChild(this.dock);

    // Typed turns for testing without a microphone:
    //   window.__proofVoice.sendText('make this paragraph shorter')
    // Only works while a voice session is live.
    (window as unknown as { __proofVoice?: unknown }).__proofVoice = {
      sendText: (text: string) => this.session?.sendText(text) ?? false,
      getState: () => this.session?.getState() ?? 'idle',
    };

    this.render('idle');
    if (!this.status.configured) {
      this.mainButton.disabled = true;
      this.mainButton.title = 'Set GEMINI_API_KEY on the server to turn on voice editing';
      this.mainLabel.textContent = 'Voice not configured';
    }
  }

  private async handleMainClick(): Promise<void> {
    if (this.session && this.session.getState() !== 'error') return;

    const slug = this.options.getSlug();
    const shareToken = this.options.getShareToken();
    if (!slug || !shareToken) {
      this.showCaption('agent', 'Voice editing needs an edit link for this document.', 'error');
      return;
    }

    this.session = new VoiceSession({
      slug,
      shareToken,
      getApiBase: this.options.getApiBase,
      getAuthorActor: this.options.getAuthorActor,
      editor: this.options.editor,
      events: {
        onState: (state, detail) => this.render(state, detail),
        onLevel: (level) => this.renderLevel(level),
        onTranscript: (speaker, text, final) => this.renderTranscript(speaker, text, final),
      },
    });

    // start() reports failures through onState; swallow the rejection so the
    // page-level unhandled rejection banner does not fire as well.
    await this.session.start().catch(() => undefined);
  }

  private async end(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.stop().catch(() => undefined);
    this.render('idle');
    this.hideCaption();
  }

  private toggleMute(): void {
    if (!this.session) return;
    this.session.setMuted(!this.session.isMuted());
    this.renderMute();
    // The label is the only place a muted microphone is spelled out.
    this.render((this.dock.dataset.state as VoiceState) || 'idle');
  }

  private render(state: VoiceState, detail?: string): void {
    this.dock.dataset.state = state;
    const live = state !== 'idle' && state !== 'error';
    const muted = live && (this.session?.isMuted() ?? false);
    this.dock.dataset.live = String(live);
    this.mainLabel.textContent = muted && state === 'listening' ? 'Muted' : STATE_LABEL[state];
    this.tape.setMode(live ? TAPE_MODE[state] : 'off');
    this.renderClock(live);
    this.mainButton.setAttribute('aria-label', live ? `Voice editing: ${STATE_LABEL[state]}` : 'Start voice editing');
    this.muteButton.hidden = !live;
    this.endButton.hidden = !live;
    this.muteButton.style.display = live ? '' : 'none';
    this.endButton.style.display = live ? '' : 'none';
    this.renderMute();
    if (!live) this.renderLevel(0);

    if (state === 'error') {
      this.session = null;
      this.showCaption('agent', detail || 'Voice is unavailable right now.', 'error');
      this.mainLabel.textContent = 'Try voice again';
    }
  }

  private renderMute(): void {
    const muted = this.session?.isMuted() ?? false;
    this.muteButton.innerHTML = muted ? MUTED_ICON : MIC_ICON;
    this.muteButton.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
    this.muteButton.setAttribute('aria-pressed', String(muted));
    this.muteButton.title = muted ? 'Unmute microphone' : 'Mute microphone';
    this.dock.dataset.muted = String(muted);
    this.tape.setMuted(muted);
  }

  // Microphone RMS from the capture worklet, about ten times a second.
  private renderLevel(level: number): void {
    this.tape.setAuthorLevel(level);
  }

  // How long the conversation has been live.
  private renderClock(live: boolean): void {
    if (!live) {
      if (this.clock !== null) window.clearInterval(this.clock);
      this.clock = null;
      this.liveSince = null;
      this.time.textContent = '';
      return;
    }
    if (this.clock !== null) return;
    this.liveSince = Date.now();
    const tick = () => {
      const seconds = Math.floor((Date.now() - (this.liveSince ?? Date.now())) / 1000);
      this.time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    };
    tick();
    this.clock = window.setInterval(tick, 1000);
  }

  private renderTranscript(speaker: 'author' | 'agent', text: string, final: boolean): void {
    if (final) {
      this.scheduleCaptionHide();
      return;
    }
    if (!text) return;
    if (speaker !== this.captionSpeaker) {
      this.captionSpeaker = speaker;
      this.captionText = '';
    }
    this.captionText = (this.captionText + text).slice(-MAX_CAPTION_CHARS);
    this.showCaption(speaker, this.captionText.trimStart());
    this.scheduleCaptionHide();
  }

  private showCaption(speaker: 'author' | 'agent', text: string, tone?: 'error'): void {
    this.caption.hidden = false;
    this.caption.dataset.speaker = speaker;
    if (tone) this.caption.dataset.tone = tone;
    else delete this.caption.dataset.tone;
    this.captionWho.textContent = tone === 'error' ? 'Voice' : speaker === 'author' ? 'You' : 'Agent';
    this.captionBody.textContent = text;
    if (tone === 'error') this.scheduleCaptionHide(8000);
  }

  private scheduleCaptionHide(delay = CAPTION_LINGER_MS): void {
    if (this.captionTimer !== null) window.clearTimeout(this.captionTimer);
    this.captionTimer = window.setTimeout(() => this.hideCaption(), delay);
  }

  private hideCaption(): void {
    this.caption.hidden = true;
    this.captionSpeaker = null;
    this.captionText = '';
  }
}
