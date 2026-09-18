// Audio plumbing for the voice agent.
//
// Capture: microphone -> AudioWorklet -> 16 kHz mono PCM16 chunks (base64).
// Playback: 24 kHz PCM16 chunks -> gapless scheduled buffers, flushable so the
// author can talk over the model (barge-in).

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

// Roughly 100 ms per message keeps latency low without flooding the socket.
const CHUNK_SAMPLES = 1600;

// The worklet is inlined as a Blob so the single-file editor bundle needs no
// extra asset route. It resamples to 16 kHz when the hardware context refuses
// that rate, and emits fixed-size Int16 chunks.
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.chunkSamples = opts.chunkSamples || 1600;
    this.ratio = sampleRate / this.targetRate;
    this.readPos = 0;
    this.prev = 0;
    this.out = new Int16Array(this.chunkSamples);
    this.outLen = 0;
    this.sumSquares = 0;
  }
  push(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.out[this.outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.sumSquares += clamped * clamped;
    if (this.outLen === this.chunkSamples) {
      const level = Math.sqrt(this.sumSquares / this.chunkSamples);
      const buffer = this.out.buffer.slice(0);
      this.port.postMessage({ pcm: buffer, level }, [buffer]);
      this.outLen = 0;
      this.sumSquares = 0;
    }
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < channel.length; i++) this.push(channel[i]);
      return true;
    }
    // Linear-interpolation resample. readPos carries the fractional position
    // across render quanta (it can sit at -1..0, between the previous block's
    // last sample and this block's first) so there is no drift at block edges.
    while (this.readPos < channel.length - 1) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      const a = i < 0 ? this.prev : channel[i];
      this.push(a * (1 - frac) + channel[i + 1] * frac);
      this.readPos += this.ratio;
    }
    this.readPos -= channel.length;
    this.prev = channel[channel.length - 1];
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
`;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type MicChunkHandler = (base64Pcm: string, level: number) => void;

export class MicCapture {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private muted = false;

  async start(onChunk: MicChunkHandler): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Echo cancellation matters: without it the model hears itself through
        // the speakers and interrupts its own replies.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    try {
      this.context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    } catch {
      this.context = new AudioContext();
    }

    const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    try {
      await this.context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }

    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { targetRate: INPUT_SAMPLE_RATE, chunkSamples: CHUNK_SAMPLES },
    });
    this.node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      if (this.muted) {
        onChunk('', 0);
        return;
      }
      onChunk(bytesToBase64(new Uint8Array(event.data.pcm)), event.data.level);
    };
    this.source.connect(this.node);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;
  }
}

export class PcmPlayer {
  private context: AudioContext | null = null;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private onSpeakingChange: ((speaking: boolean) => void) | null = null;
  // A pass-through tap for the dock's level display. Playback never depends on
  // it: if it cannot be made, sources go straight to the destination as before.
  private analyser: AnalyserNode | null = null;
  private levelScratch: Float32Array<ArrayBuffer> | null = null;

  constructor(onSpeakingChange?: (speaking: boolean) => void) {
    this.onSpeakingChange = onSpeakingChange ?? null;
  }

  // Must be called from a user gesture so autoplay policy lets audio through.
  async resume(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      try {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 256;
        analyser.connect(this.context.destination);
        this.analyser = analyser;
        this.levelScratch = new Float32Array(analyser.fftSize);
      } catch {
        this.analyser = null;
        this.levelScratch = null;
      }
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  // RMS (0..1) of what is audible right now, for display only. It reads the
  // playing signal, so it stays in step with the sound and drops to zero the
  // moment flush() cuts the agent off.
  getLevel(): number {
    if (!this.analyser || !this.levelScratch || this.sources.size === 0) return 0;
    try {
      this.analyser.getFloatTimeDomainData(this.levelScratch);
      let sumSquares = 0;
      for (let i = 0; i < this.levelScratch.length; i++) sumSquares += this.levelScratch[i] * this.levelScratch[i];
      return Math.sqrt(sumSquares / this.levelScratch.length);
    } catch {
      return 0;
    }
  }

  enqueue(base64Pcm: string): void {
    if (!this.context || !base64Pcm) return;
    const bytes = base64ToBytes(base64Pcm);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (sampleCount === 0) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
    const buffer = this.context.createBuffer(1, sampleCount, OUTPUT_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) channel[i] = view.getInt16(i * 2, true) / 0x8000;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser ?? this.context.destination);

    // A small lead on the first chunk absorbs network jitter; later chunks
    // butt up against the previous one for gapless speech.
    const now = this.context.currentTime;
    if (this.nextStartTime < now) this.nextStartTime = now + 0.04;
    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;

    if (this.sources.size === 0) this.onSpeakingChange?.(true);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.onSpeakingChange?.(false);
    };
  }

  // Drop everything queued. Called when the server reports the author spoke
  // over the model.
  flush(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    const wasSpeaking = this.sources.size > 0;
    this.sources.clear();
    this.nextStartTime = 0;
    if (wasSpeaking) this.onSpeakingChange?.(false);
  }

  async close(): Promise<void> {
    this.flush();
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = null;
    this.analyser = null;
    this.levelScratch = null;
  }
}
