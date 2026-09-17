// One live voice conversation between the author and the Gemini Live agent.
//
// The browser talks to Gemini directly over a WebSocket using a single-use
// token minted by our server (POST /api/live/token). The token locks the model,
// instructions, and tools, so this file only moves audio and runs tool calls.

import { GoogleGenAI, type LiveServerMessage, type Session } from '@google/genai';
import { MicCapture, PcmPlayer, INPUT_SAMPLE_RATE } from './audio';
import { VoiceToolRunner, type VoiceEditorApi } from './tools';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'working' | 'reconnecting' | 'error';

export interface VoiceSessionEvents {
  onState(state: VoiceState, detail?: string): void;
  onLevel(level: number): void;
  onTranscript(speaker: 'author' | 'agent', text: string, final: boolean): void;
}

export interface VoiceSessionOptions {
  slug: string;
  shareToken: string;
  getAuthorActor(): string;
  editor: VoiceEditorApi;
  events: VoiceSessionEvents;
}

interface TokenGrant {
  token: string;
  model: string;
  config: Record<string, unknown>;
  actor: string;
}

const MAX_RECONNECT_ATTEMPTS = 3;

export class VoiceSessionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class VoiceSession {
  private readonly mic = new MicCapture();
  private readonly player: PcmPlayer;
  private session: Session | null = null;
  private tools: VoiceToolRunner | null = null;
  private resumeHandle: string | null = null;
  private state: VoiceState = 'idle';
  private stopped = false;
  private reconnecting = false;
  private agentSpeaking = false;
  private pendingToolCalls = 0;

  constructor(private readonly options: VoiceSessionOptions) {
    this.player = new PcmPlayer((speaking) => {
      this.agentSpeaking = speaking;
      this.refreshState();
    });
  }

  getState(): VoiceState {
    return this.state;
  }

  isMuted(): boolean {
    return this.mic.isMuted();
  }

  setMuted(muted: boolean): void {
    this.mic.setMuted(muted);
  }

  // Call from a click handler: the browser requires a user gesture for both the
  // microphone prompt and audio playback.
  async start(): Promise<void> {
    this.stopped = false;
    this.setState('connecting');
    try {
      await this.player.resume();
      const grant = await this.requestToken();
      this.tools = new VoiceToolRunner({
        slug: this.options.slug,
        shareToken: this.options.shareToken,
        actor: grant.actor,
        getAuthorActor: this.options.getAuthorActor,
        editor: this.options.editor,
      });
      await this.connect(grant);
      await this.mic.start((pcm, level) => {
        this.options.events.onLevel(level);
        if (!pcm || !this.session || this.reconnecting) return;
        this.session.sendRealtimeInput({
          audio: { data: pcm, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` },
        });
      });
      this.refreshState();
    } catch (error) {
      await this.teardown();
      this.setState('error', describeStartError(error));
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.teardown();
    this.setState('idle');
  }

  private async teardown(): Promise<void> {
    await this.mic.stop().catch(() => undefined);
    try {
      this.session?.close();
    } catch {
      // socket already closed
    }
    this.session = null;
    await this.player.close().catch(() => undefined);
    this.pendingToolCalls = 0;
    this.agentSpeaking = false;
  }

  private async requestToken(): Promise<TokenGrant> {
    const response = await fetch('/api/live/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-share-token': this.options.shareToken },
      body: JSON.stringify({ slug: this.options.slug, resumeHandle: this.resumeHandle }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
      throw new VoiceSessionError(body.error || 'Could not start a voice session', body.code || 'LIVE_TOKEN_FAILED');
    }
    return (await response.json()) as TokenGrant;
  }

  private async connect(grant: TokenGrant): Promise<void> {
    // Ephemeral tokens are only honoured on the v1alpha surface.
    const ai = new GoogleGenAI({ apiKey: grant.token, httpOptions: { apiVersion: 'v1alpha' } });
    this.session = await ai.live.connect({
      model: grant.model,
      config: grant.config,
      callbacks: {
        onmessage: (message) => this.handleMessage(message),
        onerror: (event) => console.error('[voice] socket error', event),
        onclose: () => {
          if (!this.stopped && !this.reconnecting) void this.reconnect('connection closed');
        },
      },
    });
  }

  private handleMessage(message: LiveServerMessage): void {
    const handle = message.sessionResumptionUpdate;
    if (handle?.resumable && handle.newHandle) this.resumeHandle = handle.newHandle;

    if (message.goAway) {
      void this.reconnect('server is rotating the connection');
      return;
    }

    if (message.toolCall?.functionCalls?.length) {
      void this.runToolCalls(message.toolCall.functionCalls);
    }

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) this.player.flush();

    for (const part of content.modelTurn?.parts ?? []) {
      const data = part.inlineData?.data;
      if (data) this.player.enqueue(data);
    }

    if (content.inputTranscription?.text) {
      // The author has started a new turn, so the agent's next suggestions
      // form a new batch for "accept" and "try again".
      this.tools?.endBatch();
      this.options.events.onTranscript('author', content.inputTranscription.text, false);
    }
    if (content.outputTranscription?.text) {
      this.options.events.onTranscript('agent', content.outputTranscription.text, false);
    }
    if (content.turnComplete) {
      this.options.events.onTranscript('agent', '', true);
    }
  }

  // Calls in one message run in order: "reject the last one, then suggest a new
  // version" only makes sense sequentially. run() never rejects; failures come
  // back as { error } so the model can recover out loud.
  private async runToolCalls(calls: NonNullable<LiveServerMessage['toolCall']>['functionCalls']): Promise<void> {
    const tools = this.tools;
    if (!calls || !tools) return;
    this.pendingToolCalls += calls.length;
    this.refreshState();

    const functionResponses = [];
    for (const call of calls) {
      const response = await tools.run(call.name ?? '', (call.args ?? {}) as Record<string, unknown>);
      functionResponses.push({ id: call.id, name: call.name, response });
    }

    this.pendingToolCalls = Math.max(0, this.pendingToolCalls - calls.length);
    this.session?.sendToolResponse({ functionResponses });
    this.refreshState();
  }

  // Connections last about ten minutes. When the server warns us (goAway) or
  // the socket drops, open a new one with the resumption handle so the
  // conversation carries on with its context intact.
  private async reconnect(reason: string): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    this.setState('reconnecting', reason);

    const previous = this.session;
    this.session = null;

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        const grant = await this.requestToken();
        await this.connect(grant);
        try {
          previous?.close();
        } catch {
          // already closed
        }
        this.reconnecting = false;
        this.refreshState();
        return;
      } catch (error) {
        console.warn(`[voice] reconnect attempt ${attempt} failed`, error);
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        if (this.stopped) return;
      }
    }

    this.reconnecting = false;
    await this.teardown();
    this.setState('error', 'Lost the voice connection. Start again to continue.');
  }

  private refreshState(): void {
    if (this.stopped || this.reconnecting || this.state === 'error') return;
    if (!this.session) return;
    if (this.pendingToolCalls > 0) this.setState('working');
    else if (this.agentSpeaking) this.setState('speaking');
    else this.setState('listening');
  }

  private setState(state: VoiceState, detail?: string): void {
    this.state = state;
    this.options.events.onState(state, detail);
  }
}

function describeStartError(error: unknown): string {
  if (error instanceof VoiceSessionError) {
    if (error.code === 'LIVE_NOT_CONFIGURED') return 'Voice is not set up on this server yet.';
    if (error.code === 'LIVE_FORBIDDEN' || error.code === 'LIVE_AUTH_REQUIRED') {
      return 'Voice editing needs an edit link for this document.';
    }
    return error.message;
  }
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
    return 'Microphone access was blocked. Allow it in the address bar and try again.';
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return 'No microphone was found.';
  }
  return 'Could not start voice. Check the console for details.';
}
