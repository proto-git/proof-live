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
  // Base URL of the document server's API, for example "https://host/api".
  // The editor bundle can be hosted on a different origin than the server.
  getApiBase(): string;
  getAuthorActor(): string;
  editor: VoiceEditorApi;
  events: VoiceSessionEvents;
}

export interface TokenGrant {
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

// Thrown inside start() and reconnect() when the author stopped or restarted
// while an await was pending. It is control flow, never shown to the author.
class StartCancelled extends Error {}

// The parts of the Gemini socket this file uses.
export type LiveSocket = Pick<Session, 'sendRealtimeInput' | 'sendToolResponse' | 'sendClientContent' | 'close'>;

export interface LiveSocketCallbacks {
  onmessage(message: LiveServerMessage): void;
  onclose(): void;
}

// Everything that touches the browser or the network, so the session's
// lifecycle (stop during startup, socket rotation) can be tested without either.
export interface VoiceSessionDeps {
  createMic(): Pick<MicCapture, 'start' | 'stop' | 'setMuted' | 'isMuted'>;
  createPlayer(onSpeakingChange: (speaking: boolean) => void): Pick<PcmPlayer, 'resume' | 'enqueue' | 'flush' | 'close'>;
  openSocket(grant: TokenGrant, callbacks: LiveSocketCallbacks): Promise<LiveSocket>;
  fetch: typeof fetch;
  delay(ms: number): Promise<void>;
}

const browserDeps: VoiceSessionDeps = {
  createMic: () => new MicCapture(),
  createPlayer: (onSpeakingChange) => new PcmPlayer(onSpeakingChange),
  openSocket: (grant, callbacks) => {
    // Ephemeral tokens are only honoured on the v1alpha surface.
    const ai = new GoogleGenAI({ apiKey: grant.token, httpOptions: { apiVersion: 'v1alpha' } });
    return ai.live.connect({
      model: grant.model,
      config: grant.config,
      callbacks: {
        onmessage: callbacks.onmessage,
        onerror: (event) => console.error('[voice] socket error', event),
        onclose: callbacks.onclose,
      },
    });
  },
  fetch: (input, init) => fetch(input, init),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function closeQuietly(socket: LiveSocket | null): void {
  try {
    socket?.close();
  } catch {
    // already closed
  }
}

export class VoiceSession {
  private readonly mic: ReturnType<VoiceSessionDeps['createMic']>;
  private readonly player: ReturnType<VoiceSessionDeps['createPlayer']>;
  private session: LiveSocket | null = null;
  private tools: VoiceToolRunner | null = null;
  private resumeHandle: string | null = null;
  private state: VoiceState = 'idle';
  private stopped = false;
  private reconnecting = false;
  private agentSpeaking = false;
  private pendingToolCalls = 0;
  private toolQueue: Promise<void> = Promise.resolve();
  // Bumped by every start() and stop(). Async work captures the value it began
  // under and abandons itself if the author has since stopped or restarted.
  private epoch = 0;
  // Identifies the socket whose callbacks are honoured. A socket that has been
  // replaced (or stopped) still fires message and close events afterwards.
  private connectionSeq = 0;
  private activeConnection = 0;

  constructor(
    private readonly options: VoiceSessionOptions,
    private readonly deps: VoiceSessionDeps = browserDeps,
  ) {
    this.mic = deps.createMic();
    this.player = deps.createPlayer((speaking) => {
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

  // A typed turn on the live conversation. The agent answers it exactly as it
  // would a spoken one, which lets the whole path (model, tools, editor) be
  // exercised without a microphone.
  sendText(text: string): boolean {
    if (!this.session || this.reconnecting || !text.trim()) return false;
    this.tools?.endBatch();
    this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
    return true;
  }

  // Call from a click handler: the browser requires a user gesture for both the
  // microphone prompt and audio playback.
  //
  // Startup has several slow awaits (token, socket, and the microphone
  // permission prompt, which can sit open for a long time). The author can press
  // End during any of them, so each step re-checks that this start is still the
  // current one before acquiring the next resource.
  async start(): Promise<void> {
    const epoch = ++this.epoch;
    this.stopped = false;
    this.reconnecting = false;
    this.setState('connecting');
    try {
      await this.player.resume();
      this.assertCurrent(epoch);
      const grant = await this.requestToken();
      this.assertCurrent(epoch);
      this.tools = new VoiceToolRunner({
        slug: this.options.slug,
        shareToken: this.options.shareToken,
        apiBase: this.options.getApiBase(),
        actor: grant.actor,
        getAuthorActor: this.options.getAuthorActor,
        editor: this.options.editor,
      });
      await this.connect(grant, epoch);
      await this.mic.start((pcm, level) => {
        this.options.events.onLevel(level);
        if (!pcm || !this.session || this.reconnecting) return;
        this.session.sendRealtimeInput({
          audio: { data: pcm, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` },
        });
      });
      if (epoch !== this.epoch) {
        // stop() ran while the permission prompt was open and found no stream to
        // release. Release it now so the microphone is never live without controls.
        await this.mic.stop().catch(() => undefined);
        throw new StartCancelled();
      }
      this.refreshState();
    } catch (error) {
      // A cancelled start was already torn down and set to idle by stop(). That
      // includes a rejection from a pending await (token, socket, microphone)
      // that lands after stop() without passing through assertCurrent().
      if (error instanceof StartCancelled || epoch !== this.epoch) return;
      await this.teardown();
      this.setState('error', describeStartError(error));
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.epoch++;
    this.stopped = true;
    this.reconnecting = false;
    this.activeConnection = 0;
    await this.teardown();
    this.setState('idle');
  }

  private assertCurrent(epoch: number): void {
    if (epoch !== this.epoch) throw new StartCancelled();
  }

  private async teardown(): Promise<void> {
    await this.mic.stop().catch(() => undefined);
    closeQuietly(this.session);
    this.session = null;
    await this.player.close().catch(() => undefined);
    this.pendingToolCalls = 0;
    this.agentSpeaking = false;
  }

  private async requestToken(): Promise<TokenGrant> {
    const response = await this.deps.fetch(`${this.options.getApiBase()}/live/token`, {
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

  // Opens a socket and, if this start is still current, makes it the active one
  // and retires the socket it replaces. The previous socket stays active (and
  // keeps serving tool calls) until the new one is ready.
  private async connect(grant: TokenGrant, epoch: number): Promise<void> {
    const connectionId = ++this.connectionSeq;
    const socket = await this.deps.openSocket(grant, {
      onmessage: (message) => {
        if (connectionId === this.activeConnection) this.handleMessage(message);
      },
      onclose: () => {
        // Only the active socket closing unexpectedly means the conversation
        // dropped. A socket we replaced or stopped closes as a matter of course.
        if (connectionId !== this.activeConnection) return;
        if (!this.stopped && !this.reconnecting) void this.reconnect('connection closed');
      },
    });

    if (epoch !== this.epoch) {
      closeQuietly(socket);
      throw new StartCancelled();
    }

    const previous = this.session;
    this.session = socket;
    this.activeConnection = connectionId;
    closeQuietly(previous);
  }

  private handleMessage(message: LiveServerMessage): void {
    const handle = message.sessionResumptionUpdate;
    if (handle?.resumable && handle.newHandle) this.resumeHandle = handle.newHandle;

    if (message.goAway) {
      void this.reconnect('server is rotating the connection');
      return;
    }

    if (message.toolCall?.functionCalls?.length) {
      // One queue for the whole conversation. Calls can arrive in separate
      // messages while an earlier batch is still waiting on the server, and
      // "reject, then suggest again" must never overlap with what came before.
      const calls = message.toolCall.functionCalls;
      this.toolQueue = this.toolQueue.then(() => this.runToolCalls(calls)).catch((error) => {
        console.error('[voice] tool queue failed', error);
      });
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
  //
  // The old socket stays assigned to this.session for the duration, so a stop()
  // in the middle of a reconnect still closes it. connect() swaps it out only
  // once the replacement is ready. If the author stops or restarts meanwhile,
  // the epoch no longer matches and this attempt abandons itself without
  // touching flags that now belong to a newer start.
  private async reconnect(reason: string): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    const epoch = this.epoch;
    this.reconnecting = true;
    this.setState('reconnecting', reason);

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      try {
        const grant = await this.requestToken();
        this.assertCurrent(epoch);
        await this.connect(grant, epoch);
        this.reconnecting = false;
        this.refreshState();
        return;
      } catch (error) {
        if (error instanceof StartCancelled || epoch !== this.epoch) return;
        console.warn(`[voice] reconnect attempt ${attempt} failed`, error);
        await this.deps.delay(500 * attempt);
        if (epoch !== this.epoch) return;
      }
    }

    this.reconnecting = false;
    this.activeConnection = 0;
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
    // A silent agent and a dropped call sound the same. This line tells them apart.
    if (state !== this.state) console.log('[voice] state', state, detail ?? '');
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
