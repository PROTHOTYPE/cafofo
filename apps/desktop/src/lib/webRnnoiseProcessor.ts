import {
  loadRnnoise,
  RnnoiseWorkletNode,
} from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import type {
  AudioProcessorOptions,
  Track,
  TrackProcessor,
} from "livekit-client";

let cachedWasmPromise: Promise<ArrayBuffer> | null = null;
const loadedWorkletContexts = new WeakSet<AudioContext>();

export function isWebRnnoiseSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof WebAssembly !== "undefined"
  );
}

async function getRnnoiseWasmBinary(): Promise<ArrayBuffer> {
  if (!cachedWasmPromise) {
    cachedWasmPromise = loadRnnoise({
      url: rnnoiseWasmUrl,
      simdUrl: rnnoiseSimdWasmUrl,
    }).catch((err) => {
      cachedWasmPromise = null;
      throw err;
    });
  }
  const binary = await cachedWasmPromise;
  return binary.slice(0);
}

export function preloadWebRnnoise(): void {
  if (!isWebRnnoiseSupported()) return;
  void getRnnoiseWasmBinary().catch(() => {});
}

async function ensureWorkletLoaded(ctx: AudioContext): Promise<void> {
  if (loadedWorkletContexts.has(ctx)) return;
  await ctx.audioWorklet.addModule(rnnoiseWorkletUrl);
  loadedWorkletContexts.add(ctx);
}

export class WebRnnoiseProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "cafofo-web-rnnoise";
  processedTrack?: MediaStreamTrack;

  private ownContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  async init(opts: AudioProcessorOptions): Promise<void> {
    await this.setupGraph(opts.track, opts.audioContext);
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.teardownGraph();
    await this.setupGraph(opts.track, opts.audioContext);
  }

  async destroy(): Promise<void> {
    await this.teardownGraph();
    if (this.ownContext) {
      await this.ownContext.close().catch(() => {});
      this.ownContext = null;
    }
  }

  private async setupGraph(
    inputTrack: MediaStreamTrack,
    providedContext?: AudioContext,
  ): Promise<void> {
    // RNNoise strictly requires 48kHz audio frames
    let ctx: AudioContext;
    if (providedContext && providedContext.sampleRate === 48_000) {
      ctx = providedContext;
    } else {
      if (!this.ownContext) {
        this.ownContext = new AudioContext({
          sampleRate: 48_000,
          latencyHint: "interactive",
        });
      }
      ctx = this.ownContext;
    }

    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }

    const [wasmBinary] = await Promise.all([
      getRnnoiseWasmBinary(),
      ensureWorkletLoaded(ctx),
    ]);

    const source = ctx.createMediaStreamSource(new MediaStream([inputTrack]));
    const rnnoise = new RnnoiseWorkletNode(ctx, {
      maxChannels: 1,
      wasmBinary,
    });
    const destination = ctx.createMediaStreamDestination();

    source.connect(rnnoise);
    rnnoise.connect(destination);

    this.sourceNode = source;
    this.rnnoiseNode = rnnoise;
    this.destinationNode = destination;
    this.processedTrack = destination.stream.getAudioTracks()[0];
  }

  private async teardownGraph(): Promise<void> {
    try {
      this.sourceNode?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.rnnoiseNode?.disconnect();
      this.rnnoiseNode?.destroy();
    } catch {
      // ignore
    }
    try {
      this.destinationNode?.disconnect();
    } catch {
      // ignore
    }
    if (this.processedTrack) {
      this.processedTrack.stop();
      this.processedTrack = undefined;
    }
    this.sourceNode = null;
    this.rnnoiseNode = null;
    this.destinationNode = null;
  }
}

export function createWebRnnoiseProcessor(): WebRnnoiseProcessor {
  return new WebRnnoiseProcessor();
}
