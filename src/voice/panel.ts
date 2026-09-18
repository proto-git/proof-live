// The voice control: one button that becomes a small status pill while a
// conversation is live. It stays out of the way of the document; the agent's
// work shows up in the text as suggestions, not in this panel.

import { VoiceSession, type VoiceState } from './session';
import type { VoiceEditorApi } from './tools';

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
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  pointer-events: none;
}
.voice-dock > * { pointer-events: auto; }
.voice-pill {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px;
  border-radius: 999px;
  background: #16181d;
  color: #f4f5f7;
  box-shadow: 0 6px 24px rgba(12, 14, 20, 0.22), 0 1px 2px rgba(12, 14, 20, 0.3);
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
.voice-btn:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 2px; }
.voice-btn[disabled] { cursor: default; opacity: 0.55; }
.voice-btn[disabled]:hover { background: none; }
.voice-main { padding: 0 16px 0 12px; }
.voice-orb {
  position: relative;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}
.voice-orb::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--voice-accent, transparent);
  opacity: 0.28;
  transform: scale(var(--voice-level, 1));
  transition: transform 90ms linear, background 200ms ease;
}
.voice-dock[data-state="listening"] { --voice-accent: #6ee7b7; }
.voice-dock[data-state="speaking"] { --voice-accent: #a5b4fc; }
.voice-dock[data-state="working"] { --voice-accent: #fcd34d; }
.voice-dock[data-state="connecting"] .voice-orb::before,
.voice-dock[data-state="reconnecting"] .voice-orb::before,
.voice-dock[data-state="working"] .voice-orb::before {
  background: var(--voice-accent, #9aa3b2);
  animation: voice-pulse 1.1s ease-in-out infinite;
}
@keyframes voice-pulse {
  0%, 100% { transform: scale(0.85); opacity: 0.2; }
  50% { transform: scale(1.35); opacity: 0.4; }
}
.voice-caption {
  max-width: min(560px, calc(100vw - 48px));
  padding: 8px 14px;
  border-radius: 12px;
  background: rgba(22, 24, 29, 0.92);
  color: #f4f5f7;
  font-size: 14px;
  line-height: 1.45;
  text-align: center;
  box-shadow: 0 6px 24px rgba(12, 14, 20, 0.18);
}
.voice-caption[hidden] { display: none; }
.voice-caption[data-speaker="author"] { color: #c9ced8; font-style: italic; }
.voice-caption[data-tone="error"] { background: #7f1d1d; }
@media (prefers-reduced-motion: reduce) {
  .voice-orb::before { transition: none; animation: none !important; }
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

    const pill = document.createElement('div');
    pill.className = 'voice-pill';

    this.mainButton.className = 'voice-btn voice-main';
    this.mainButton.type = 'button';
    const orb = document.createElement('span');
    orb.className = 'voice-orb';
    orb.innerHTML = MIC_ICON;
    this.mainButton.append(orb, this.mainLabel);
    this.mainButton.addEventListener('click', () => void this.handleMainClick());

    this.muteButton.className = 'voice-btn';
    this.muteButton.type = 'button';
    this.muteButton.addEventListener('click', () => this.toggleMute());

    this.endButton.className = 'voice-btn';
    this.endButton.type = 'button';
    this.endButton.innerHTML = END_ICON;
    this.endButton.setAttribute('aria-label', 'End voice session');
    this.endButton.title = 'End voice session';
    this.endButton.addEventListener('click', () => void this.end());

    pill.append(this.mainButton, this.muteButton, this.endButton);
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
  }

  private render(state: VoiceState, detail?: string): void {
    this.dock.dataset.state = state;
    const live = state !== 'idle' && state !== 'error';
    this.mainLabel.textContent = STATE_LABEL[state];
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
  }

  private renderLevel(level: number): void {
    // Speech RMS sits around 0.02 to 0.2; map that onto a gentle 1x to 1.7x swell.
    const scale = 1 + Math.min(0.7, level * 5);
    this.dock.style.setProperty('--voice-level', scale.toFixed(2));
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
    this.caption.textContent = text;
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
