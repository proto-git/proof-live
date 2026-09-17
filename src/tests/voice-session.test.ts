// Voice session lifecycle: what happens when the author stops mid-startup, and
// when Gemini rotates the socket. These are timing bugs that only show up with
// slow awaits, so every dependency here is a fake the test resolves by hand.
// Run with: npx tsx src/tests/voice-session.test.ts

import { VoiceSession, type LiveSocket, type LiveSocketCallbacks, type VoiceSessionDeps, type VoiceState } from '../voice/session.ts';
import type { VoiceEditorApi } from '../voice/tools.ts';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  got      ${a}`);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Lets every already-resolved promise continuation run.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface FakeSocket extends LiveSocket {
  id: number;
  closed: boolean;
  audioChunks: number;
  callbacks: LiveSocketCallbacks;
}

interface Harness {
  session: VoiceSession;
  states: VoiceState[];
  tokenRequests: Array<Record<string, unknown>>;
  pendingTokens: Array<Deferred<Response>>;
  pendingSockets: Array<{ gate: Deferred<void>; socket: FakeSocket }>;
  sockets: FakeSocket[];
  micGate: Deferred<void>;
  mic: { started: number; stopped: number; emit(pcm: string): void };
  // Resolve the oldest outstanding token request / socket open.
  grantToken(): Promise<void>;
  openSocket(): Promise<FakeSocket>;
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ token: 't', model: 'm', config: {}, actor: 'ai:gemini-live' }), { status: 200 });
}

function createHarness(options?: { autoMic?: boolean }): Harness {
  const h = {
    states: [],
    tokenRequests: [],
    pendingTokens: [],
    pendingSockets: [],
    sockets: [],
    micGate: deferred<void>(),
  } as unknown as Harness;

  let onChunk: ((pcm: string, level: number) => void) | null = null;
  h.mic = {
    started: 0,
    stopped: 0,
    emit: (pcm) => onChunk?.(pcm, 0.1),
  };
  if (options?.autoMic !== false) h.micGate.resolve();

  const deps: VoiceSessionDeps = {
    createMic: () => ({
      start: async (handler) => {
        await h.micGate.promise;
        h.mic.started++;
        onChunk = handler;
      },
      stop: async () => {
        h.mic.stopped++;
        onChunk = null;
      },
      setMuted: () => undefined,
      isMuted: () => false,
    }),
    createPlayer: () => ({
      resume: async () => undefined,
      enqueue: () => undefined,
      flush: () => undefined,
      close: async () => undefined,
    }),
    openSocket: async (_grant, callbacks) => {
      const socket: FakeSocket = {
        id: h.sockets.length + h.pendingSockets.length + 1,
        closed: false,
        audioChunks: 0,
        callbacks,
        sendRealtimeInput: () => {
          socket.audioChunks++;
        },
        sendToolResponse: () => undefined,
        close: () => {
          socket.closed = true;
        },
      };
      const gate = deferred<void>();
      h.pendingSockets.push({ gate, socket });
      await gate.promise;
      h.sockets.push(socket);
      return socket;
    },
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      h.tokenRequests.push(JSON.parse(String(init?.body ?? '{}')));
      const pending = deferred<Response>();
      h.pendingTokens.push(pending);
      return pending.promise;
    }) as typeof fetch,
    delay: async () => undefined,
  };

  h.grantToken = async () => {
    h.pendingTokens.shift()!.resolve(tokenResponse());
    await settle();
  };
  h.openSocket = async () => {
    const next = h.pendingSockets.shift()!;
    next.gate.resolve();
    await settle();
    return next.socket;
  };

  h.session = new VoiceSession(
    {
      slug: 'doc',
      shareToken: 'tok',
      getApiBase: () => 'https://host/api',
      getAuthorActor: () => 'human:Dan',
      editor: {} as VoiceEditorApi,
      events: {
        onState: (state) => h.states.push(state),
        onLevel: () => undefined,
        onTranscript: () => undefined,
      },
    },
    deps,
  );
  return h;
}

async function startFully(h: Harness): Promise<FakeSocket> {
  const started = h.session.start();
  await settle();
  await h.grantToken();
  const socket = await h.openSocket();
  await started;
  return socket;
}

async function run(): Promise<void> {
  // Baseline: a normal start ends up listening, with audio reaching the socket.
  let h = createHarness();
  let socket = await startFully(h);
  assertEqual(h.session.getState(), 'listening', 'normal start reaches listening');
  h.mic.emit('pcm');
  assertEqual(socket.audioChunks, 1, 'audio reaches the active socket');

  // End pressed while the token request is in flight: nothing else is acquired.
  h = createHarness();
  let started = h.session.start();
  await settle();
  await h.session.stop();
  await h.grantToken();
  await started;
  assertEqual(h.pendingSockets.length + h.sockets.length, 0, 'no socket opened after stop during token fetch');
  assertEqual(h.mic.started, 0, 'microphone never started after stop during token fetch');
  assertEqual(h.session.getState(), 'idle', 'stays idle after a cancelled start');
  assertEqual(h.states.includes('error'), false, 'a cancelled start is not reported as an error');

  // End pressed while the socket is opening: it is closed the moment it arrives.
  h = createHarness();
  started = h.session.start();
  await settle();
  await h.grantToken();
  await h.session.stop();
  socket = await h.openSocket();
  await started;
  assertEqual(socket.closed, true, 'late socket is closed when the start was cancelled');
  assertEqual(h.mic.started, 0, 'microphone never started after stop during socket open');
  assertEqual(h.session.getState(), 'idle', 'idle after stop during socket open');

  // End pressed while the microphone permission prompt is open. stop() finds no
  // stream to release, so the start must release it when the prompt resolves.
  h = createHarness({ autoMic: false });
  started = h.session.start();
  await settle();
  await h.grantToken();
  socket = await h.openSocket();
  await h.session.stop();
  const stopsBeforePrompt = h.mic.stopped;
  h.micGate.resolve();
  await started;
  assertEqual(h.mic.started, 1, 'permission prompt resolved after stop');
  assertEqual(h.mic.stopped > stopsBeforePrompt, true, 'microphone released after a late permission grant');
  h.mic.emit('pcm');
  assertEqual(socket.audioChunks, 0, 'no audio is streamed after stop');
  assertEqual(h.session.getState(), 'idle', 'idle after stop during permission prompt');

  // Socket rotation (goAway): the replacement becomes active, the old one is
  // closed, and the old socket's late close event does not start another
  // reconnect against the healthy new socket.
  h = createHarness();
  const first = await startFully(h);
  first.callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'handle-1' } } as never);
  first.callbacks.onmessage({ goAway: { timeLeft: '5s' } } as never);
  await settle();
  assertEqual(h.session.getState(), 'reconnecting', 'goAway starts a reconnect');
  assertEqual(h.tokenRequests[1]?.resumeHandle, 'handle-1', 'reconnect token carries the resumption handle');
  await h.grantToken();
  const second = await h.openSocket();
  assertEqual(first.closed, true, 'superseded socket is closed');
  assertEqual(h.session.getState(), 'listening', 'listening again after rotation');
  first.callbacks.onclose();
  await settle();
  assertEqual(h.tokenRequests.length, 2, 'late close from the superseded socket does not reconnect again');
  assertEqual(h.session.getState(), 'listening', 'still listening after the stale close event');

  // Messages from a superseded socket are ignored; the active one is honoured.
  first.callbacks.onmessage({ goAway: {} } as never);
  await settle();
  assertEqual(h.tokenRequests.length, 2, 'stale goAway ignored');
  h.mic.emit('pcm');
  assertEqual(second.audioChunks, 1, 'audio flows to the replacement socket');
  assertEqual(first.audioChunks, 0, 'no audio to the superseded socket');

  // The active socket dropping unexpectedly does reconnect.
  second.callbacks.onclose();
  await settle();
  assertEqual(h.tokenRequests.length, 3, 'unexpected close of the active socket reconnects');

  // Stop during that reconnect, then start again: the old socket is closed, the
  // abandoned attempt does not disturb the new session, and audio flows.
  await h.session.stop();
  assertEqual(second.closed, true, 'stop during reconnect closes the socket that was still assigned');
  await h.grantToken(); // the abandoned reconnect's token arrives late
  assertEqual(h.pendingSockets.length, 0, 'abandoned reconnect opens no socket');
  const restarted = h.session.start();
  await settle();
  await h.grantToken();
  const third = await h.openSocket();
  await restarted;
  assertEqual(h.session.getState(), 'listening', 'restart after a stopped reconnect reaches listening');
  h.mic.emit('pcm');
  assertEqual(third.audioChunks, 1, 'audio flows after restart (reconnecting flag was reset)');

  // Reconnect gives up after repeated failures and reports it once.
  h = createHarness();
  const only = await startFully(h);
  only.callbacks.onclose();
  await settle();
  for (let i = 0; i < 3; i++) {
    h.pendingTokens.shift()!.resolve(new Response(JSON.stringify({ error: 'nope', code: 'LIVE_TOKEN_FAILED' }), { status: 502 }));
    await settle();
  }
  assertEqual(h.session.getState(), 'error', 'gives up after repeated reconnect failures');
  assertEqual(h.mic.stopped > 0, true, 'microphone released when the connection is lost for good');

  console.log('voice-session: all assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
