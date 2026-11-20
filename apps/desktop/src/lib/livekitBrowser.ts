import { useSyncExternalStore } from "react";
import {
  useVoiceStore,
  type VoiceTransportAdapter,
} from "@cafofo/core-logic";
import {
  AudioPresets,
  ConnectionState,
  createLocalAudioTrack,
  LocalAudioTrack,
  LocalTrack,
  LocalVideoTrack,
  RemoteAudioTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
} from "livekit-client";
import { isTauriRuntime } from "./tauri";
import {
  createWebRnnoiseProcessor,
  isWebRnnoiseSupported,
  preloadWebRnnoise,
} from "./webRnnoiseProcessor";

export interface BrowserMediaSnapshot {
  connected: boolean;
  remoteVideoByUser: Record<string, RemoteVideoTrack>;
  remoteParticipantIds: string[];
  localScreenVideoTrack: LocalVideoTrack | null;
  audioPlaybackBlocked: boolean;
  micNotice: string | null;
  rmsLevel: number;
  webRnnoiseActive: boolean;
}

interface AttachedAudioEntry {
  trackSid: string;
  participantIdentity: string;
  isScreenAudio: boolean;
  track: RemoteAudioTrack;
  element: HTMLAudioElement;
  sourceNode: MediaStreamAudioSourceNode | null;
  gainNode: GainNode | null;
  usingWebAudio: boolean;
}

const HIGH_QUALITY_VOICE_PRESET = {
  maxBitrate: 64_000,
};

let activeRoom: Room | null = null;
let activeRoomName: string | null = null;
let localMicTrack: LocalAudioTrack | null = null;
let localScreenTracks: LocalTrack[] = [];
let hiddenAudioHost: HTMLDivElement | null = null;
let playbackAudioCtx: AudioContext | null = null;
let micProcessorAudioCtx: AudioContext | null = null;
let gestureUnlockBound = false;
let joinSessionSeq = 0;
let micPublishSeq = 0;
let lastRequestedMicOpts: {
  deviceId?: string | null;
  label?: string | null;
  rnnoiseEnabled: boolean;
} | null = null;

const attachedAudio = new Map<string, AttachedAudioEntry>();
const remoteVideos = new Map<string, RemoteVideoTrack>();

let browserMuted = false;
let browserDeafened = false;
let browserRnnoiseEnabled = true;
let currentUserVolumes: Record<string, number> = {};
let currentScreenVolumes: Record<string, number> = {};

let micAnalyserTimer: ReturnType<typeof setInterval> | null = null;
let micAnalyserCtx: AudioContext | null = null;

let snapshot: BrowserMediaSnapshot = {
  connected: false,
  remoteVideoByUser: {},
  remoteParticipantIds: [],
  localScreenVideoTrack: null,
  audioPlaybackBlocked: false,
  micNotice: null,
  rmsLevel: 0,
  webRnnoiseActive: false,
};

const listeners = new Set<() => void>();

function collectRemoteParticipantIds(): string[] {
  const ids = new Set<string>();
  if (activeRoom && activeRoom.state !== ConnectionState.Disconnected) {
    for (const participant of activeRoom.remoteParticipants.values()) {
      const normalized = normalizeParticipantIdentity(participant.identity);
      if (normalized) ids.add(normalized);
    }
  }
  for (const identity of remoteVideos.keys()) {
    ids.add(identity);
  }
  for (const entry of attachedAudio.values()) {
    ids.add(entry.participantIdentity);
  }
  return Array.from(ids);
}

function notifyListeners(): void {
  const videoRecord: Record<string, RemoteVideoTrack> = {};
  for (const [identity, track] of remoteVideos.entries()) {
    videoRecord[identity] = track;
  }

  snapshot = {
    ...snapshot,
    remoteVideoByUser: videoRecord,
    remoteParticipantIds: collectRemoteParticipantIds(),
  };

  for (const listener of listeners) {
    listener();
  }
}

function updateSnapshot(patch: Partial<BrowserMediaSnapshot>): void {
  snapshot = {
    ...snapshot,
    ...patch,
  };
  for (const listener of listeners) {
    listener();
  }
}

function ensurePlaybackAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return null;

  if (!playbackAudioCtx || playbackAudioCtx.state === "closed") {
    playbackAudioCtx = new AudioCtx({ latencyHint: "interactive" });
  }

  if (!gestureUnlockBound) {
    gestureUnlockBound = true;
    const resumeOnGesture = () => {
      if (playbackAudioCtx && playbackAudioCtx.state === "suspended") {
        void playbackAudioCtx.resume().catch(() => {});
      }
    };
    window.addEventListener("pointerdown", resumeOnGesture, { passive: true });
    window.addEventListener("keydown", resumeOnGesture, { passive: true });
  }

  if (playbackAudioCtx.state === "suspended") {
    void playbackAudioCtx.resume().catch(() => {});
  }
  return playbackAudioCtx;
}

async function ensureMicProcessorAudioContext(): Promise<AudioContext | null> {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return null;

  if (!micProcessorAudioCtx || micProcessorAudioCtx.state === "closed") {
    micProcessorAudioCtx = new AudioCtx({
      sampleRate: 48_000,
      latencyHint: "interactive",
    });
  }
  if (micProcessorAudioCtx.state === "suspended") {
    await Promise.race([
      micProcessorAudioCtx.resume().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1200)),
    ]);
  }
  return micProcessorAudioCtx;
}

function getHiddenAudioHost(): HTMLDivElement {
  if (hiddenAudioHost && document.body.contains(hiddenAudioHost)) {
    return hiddenAudioHost;
  }
  const el = document.createElement("div");
  el.setAttribute("data-cafofo-browser-audio", "true");
  el.style.display = "none";
  document.body.appendChild(el);
  hiddenAudioHost = el;
  return el;
}

function applyPlaybackVolumes(): void {
  const peers = useVoiceStore.getState().peers;

  for (const entry of attachedAudio.values()) {
    let volumePct = currentUserVolumes[entry.participantIdentity] ?? 100;
    if (entry.isScreenAudio) {
      const streamId =
        peers[entry.participantIdentity]?.screen_sharing?.stream_id;
      volumePct = streamId ? (currentScreenVolumes[streamId] ?? 100) : 100;
    }

    const targetGain = browserDeafened
      ? 0
      : Math.max(0, Math.min(2, volumePct / 100));

    if (entry.usingWebAudio && entry.gainNode && playbackAudioCtx) {
      try {
        entry.gainNode.gain.setTargetAtTime(
          targetGain,
          playbackAudioCtx.currentTime,
          0.015,
        );
      } catch {
        entry.gainNode.gain.value = targetGain;
      }
      // Keep raw <audio> element muted so audio plays solely through the GainNode (0%–200%)
      entry.element.muted = true;
      entry.element.volume = 0;
    } else {
      const clamped = Math.min(1, targetGain);
      entry.track.setVolume(clamped);
      entry.element.muted = browserDeafened || clamped === 0;
    }
  }
}

function normalizeParticipantIdentity(identity: string): string {
  return identity.endsWith("-screen")
    ? identity.slice(0, -"-screen".length)
    : identity;
}

function cleanupAudioEntry(entry: AttachedAudioEntry): void {
  try {
    entry.sourceNode?.disconnect();
  } catch {
    // ignore
  }
  try {
    entry.gainNode?.disconnect();
  } catch {
    // ignore
  }
  entry.track.detach(entry.element);
  entry.element.remove();
}

function attachRemoteTrack(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
): void {
  const sid = track.sid ?? publication.trackSid;
  const identity = normalizeParticipantIdentity(participant.identity);

  if (track.kind === Track.Kind.Audio && track instanceof RemoteAudioTrack) {
    if (attachedAudio.has(sid)) return;

    const element = track.attach() as HTMLAudioElement;
    element.autoplay = true;
    element.setAttribute("playsinline", "true");
    getHiddenAudioHost().appendChild(element);

    const isScreenAudio =
      track.source === Track.Source.ScreenShareAudio ||
      publication.source === Track.Source.ScreenShareAudio ||
      publication.trackName === "screen-audio" ||
      participant.identity.endsWith("-screen");

    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let gainNode: GainNode | null = null;
    let usingWebAudio = false;

    const ctx = ensurePlaybackAudioContext();
    if (ctx && track.mediaStreamTrack) {
      try {
        const mediaStream = new MediaStream([track.mediaStreamTrack]);
        sourceNode = ctx.createMediaStreamSource(mediaStream);
        gainNode = ctx.createGain();
        gainNode.gain.value = 1;
        sourceNode.connect(gainNode);
        gainNode.connect(ctx.destination);
        usingWebAudio = true;
        // Chrome/WebView2 requires the remote WebRTC MediaStream to stay attached to an <audio>
        // element to decode frames, while muted so output goes cleanly through GainNode (0-200%).
        element.muted = true;
        element.volume = 0;
      } catch {
        sourceNode = null;
        gainNode = null;
        usingWebAudio = false;
      }
    }

    attachedAudio.set(sid, {
      trackSid: sid,
      participantIdentity: identity,
      isScreenAudio,
      track,
      element,
      sourceNode,
      gainNode,
      usingWebAudio,
    });
    applyPlaybackVolumes();
    void element.play().catch(() => {
      if (!usingWebAudio || ctx?.state === "suspended") {
        updateSnapshot({ audioPlaybackBlocked: true });
      }
    });
    if (ctx && ctx.state === "suspended") {
      updateSnapshot({ audioPlaybackBlocked: true });
    }
    return;
  }

  if (track.kind === Track.Kind.Video && track instanceof RemoteVideoTrack) {
    const isScreenShare =
      publication.source === Track.Source.ScreenShare ||
      track.source === Track.Source.ScreenShare ||
      publication.trackName === "screen-video" ||
      participant.identity.endsWith("-screen");
    if (isScreenShare && typeof publication.setVideoQuality === "function") {
      publication.setVideoQuality(VideoQuality.HIGH);
    }

    if (typeof track.setPlayoutDelay === "function") {
      track.setPlayoutDelay(0);
    }
    const rtpReceiver = track.receiver as
      | (RTCRtpReceiver & { playoutDelayHint?: number })
      | undefined;
    if (rtpReceiver && "playoutDelayHint" in rtpReceiver) {
      rtpReceiver.playoutDelayHint = 0;
    }

    remoteVideos.set(identity, track);
    notifyListeners();
  }
}

function detachRemoteTrack(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant,
): void {
  const sid = track.sid ?? publication.trackSid;
  const identity = normalizeParticipantIdentity(participant.identity);
  const audioEntry = attachedAudio.get(sid);
  if (audioEntry) {
    cleanupAudioEntry(audioEntry);
    attachedAudio.delete(sid);
  }

  if (track.kind === Track.Kind.Video) {
    const current = remoteVideos.get(identity);
    if (current === track) {
      remoteVideos.delete(identity);
      notifyListeners();
    }
  }
}

function stopMicMeter(): void {
  if (micAnalyserTimer) {
    clearInterval(micAnalyserTimer);
    micAnalyserTimer = null;
  }
  if (micAnalyserCtx) {
    void micAnalyserCtx.close().catch(() => {});
    micAnalyserCtx = null;
  }
  if (snapshot.rmsLevel !== 0) {
    updateSnapshot({ rmsLevel: 0 });
  }
}

function startMicMeter(track: LocalAudioTrack): void {
  stopMicMeter();
  if (typeof AudioContext === "undefined") return;

  try {
    const ctx = new AudioContext();
    const stream = new MediaStream([track.mediaStreamTrack]);
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const samples = new Uint8Array(analyser.fftSize);
    micAnalyserCtx = ctx;
    let lastVoiceAt = 0;

    micAnalyserTimer = setInterval(() => {
      if (browserMuted || browserDeafened) {
        if (snapshot.rmsLevel !== 0) updateSnapshot({ rmsLevel: 0 });
        useVoiceStore.getState().setLocalSpeaking(false);
        return;
      }
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const centered = (samples[i] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.min(1, Math.sqrt(sum / samples.length));
      updateSnapshot({ rmsLevel: rms });
      const now = Date.now();
      if (rms > 0.03) {
        lastVoiceAt = now;
        useVoiceStore.getState().setLocalSpeaking(true);
      } else if (now - lastVoiceAt > 350) {
        useVoiceStore.getState().setLocalSpeaking(false);
      }
    }, 180);
  } catch {
    // WebAudio metering is optional
  }
}

async function resolvePreferredBrowserMicId(
  preferredId?: string | null,
  preferredLabel?: string | null,
): Promise<string | undefined> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.enumerateDevices
  ) {
    return preferredId || undefined;
  }

  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const inputs = devices.filter((d) => d.kind === "audioinput" && d.deviceId);
  if (inputs.length === 0) return preferredId || undefined;

  if (preferredId && inputs.some((d) => d.deviceId === preferredId)) {
    return preferredId;
  }

  if (preferredLabel) {
    const normalizedTarget = preferredLabel.trim().toLowerCase();
    const byLabel = inputs.find(
      (d) => d.label && d.label.trim().toLowerCase() === normalizedTarget,
    );
    if (byLabel) {
      return byLabel.deviceId;
    }
  }

  return preferredId || undefined;
}

async function applyRnnoiseToLocalMic(
  track: LocalAudioTrack,
  enabled: boolean,
): Promise<void> {
  const nativeTauriRnnoise = isTauriRuntime();
  if (nativeTauriRnnoise) {
    updateSnapshot({ webRnnoiseActive: false });
    return;
  }

  if (enabled && isWebRnnoiseSupported()) {
    try {
      const procCtx = await ensureMicProcessorAudioContext();
      if (procCtx && typeof track.setAudioContext === "function") {
        await track.setAudioContext(procCtx);
      }

      await track.mediaStreamTrack
        .applyConstraints({
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: false,
        })
        .catch(() => {});

      const existing = track.getProcessor();
      if (!existing) {
        await track.setProcessor(createWebRnnoiseProcessor());
      }
      updateSnapshot({ webRnnoiseActive: true });
      return;
    } catch {
      // Fallback cleanly to native WebRTC noiseSuppression if AudioWorklet/WASM fails
      await track.stopProcessor().catch(() => {});
      await track.mediaStreamTrack
        .applyConstraints({
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        })
        .catch(() => {});
      updateSnapshot({ webRnnoiseActive: false });
      return;
    }
  }

  await track.stopProcessor().catch(() => {});
  await track.mediaStreamTrack
    .applyConstraints({
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: enabled,
    })
    .catch(() => {});
  updateSnapshot({ webRnnoiseActive: false });
}

function isTransientPublishError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    name === "PublishTrackError" ||
    msg.includes("engine not connected") ||
    msg.includes("within timeout") ||
    msg.includes("not connected") ||
    msg.includes("timeout") ||
    msg.includes("reconnecting")
  );
}

async function waitForRoomConnected(
  room: Room,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (activeRoom !== room) return false;
  if (room.state === ConnectionState.Connected) return true;
  if (room.state === ConnectionState.Disconnected) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room.off(RoomEvent.Connected, onConnected);
      room.off(RoomEvent.Reconnected, onConnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      resolve(ok);
    };
    const onConnected = () => finish(activeRoom === room);
    const onDisconnected = () => finish(false);
    const timer = setTimeout(
      () =>
        finish(
          activeRoom === room && room.state === ConnectionState.Connected,
        ),
      timeoutMs,
    );

    room.on(RoomEvent.Connected, onConnected);
    room.on(RoomEvent.Reconnected, onConnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
  });
}

async function createAndPublishBrowserMic(
  room: Room,
  opts: {
    deviceId?: string | null;
    label?: string | null;
    rnnoiseEnabled: boolean;
  },
): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    updateSnapshot({
      micNotice:
        "Microfone bloqueado pelo navegador fora de HTTPS/localhost (modo ouvinte ativo).",
    });
    return;
  }

  const publishSeq = ++micPublishSeq;
  lastRequestedMicOpts = { ...opts };

  const isStale = () =>
    activeRoom !== room ||
    publishSeq !== micPublishSeq ||
    room.state === ConnectionState.Disconnected;

  if (localMicTrack) {
    stopMicMeter();
    await room.localParticipant.unpublishTrack(localMicTrack).catch(() => {});
    await localMicTrack.stopProcessor().catch(() => {});
    localMicTrack.stop();
    localMicTrack = null;
  }

  const resolvedId = await resolvePreferredBrowserMicId(
    opts.deviceId,
    opts.label,
  );
  if (isStale()) return;

  const useWasmRnnoise =
    !isTauriRuntime() && opts.rnnoiseEnabled && isWebRnnoiseSupported();

  // Do NOT pass rigid sampleRate/channelCount constraints to getUserMedia: many
  // headsets/USB/virtual mics reject 48kHz/mono with OverconstrainedError.
  // WebRnnoiseProcessor's 48kHz AudioContext automatically resamples any mic hardware.
  let audioTrack: LocalAudioTrack;
  if (resolvedId) {
    try {
      audioTrack = await createLocalAudioTrack({
        deviceId: { exact: resolvedId },
        echoCancellation: true,
        autoGainControl: true,
        noiseSuppression: !useWasmRnnoise && opts.rnnoiseEnabled,
      });
    } catch {
      try {
        audioTrack = await createLocalAudioTrack({
          deviceId: resolvedId,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: opts.rnnoiseEnabled,
        });
      } catch {
        audioTrack = await createLocalAudioTrack({
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: opts.rnnoiseEnabled,
        });
      }
    }
  } else {
    audioTrack = await createLocalAudioTrack({
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: !useWasmRnnoise && opts.rnnoiseEnabled,
    });
  }

  if (isStale()) {
    audioTrack.stop();
    return;
  }

  if (browserMuted || browserDeafened) {
    await audioTrack.mute();
  }

  // Attach 48kHz AudioContext + RNNoise WASM processor BEFORE publishing so the very
  // first audio frame sent into LiveKit is already noise-suppressed (0ms delay).
  await applyRnnoiseToLocalMic(audioTrack, opts.rnnoiseEnabled);

  if (isStale()) {
    await audioTrack.stopProcessor().catch(() => {});
    audioTrack.stop();
    return;
  }

  const maxAttempts = 3;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isStale()) {
      await audioTrack.stopProcessor().catch(() => {});
      audioTrack.stop();
      return;
    }

    const ready = await waitForRoomConnected(room, 10_000);
    if (isStale()) {
      await audioTrack.stopProcessor().catch(() => {});
      audioTrack.stop();
      return;
    }
    if (!ready) {
      lastErr = new Error("Conexão de voz indisponível ao publicar microfone.");
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 700 * attempt));
        continue;
      }
      break;
    }

    try {
      await room.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.Microphone,
        name: "microphone",
        audioPreset: HIGH_QUALITY_VOICE_PRESET,
        dtx: true,
        red: true,
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!isTransientPublishError(err) || attempt >= maxAttempts) {
        break;
      }
      await new Promise((r) => setTimeout(r, 750 * attempt));
    }
  }

  if (lastErr) {
    await audioTrack.stopProcessor().catch(() => {});
    audioTrack.stop();
    if (isStale()) return;
    throw lastErr;
  }

  if (isStale()) {
    await room.localParticipant.unpublishTrack(audioTrack).catch(() => {});
    await audioTrack.stopProcessor().catch(() => {});
    audioTrack.stop();
    return;
  }

  localMicTrack = audioTrack;
  startMicMeter(audioTrack);
  updateSnapshot({ micNotice: null });
}

export async function retryBrowserMicPublish(): Promise<void> {
  if (
    !activeRoom ||
    activeRoom.state !== ConnectionState.Connected ||
    !lastRequestedMicOpts
  ) {
    return;
  }
  updateSnapshot({ micNotice: null });
  try {
    await createAndPublishBrowserMic(activeRoom, lastRequestedMicOpts);
  } catch (err) {
    const errName = err instanceof Error ? err.name : "";
    const errMsg = err instanceof Error ? err.message : String(err);
    updateSnapshot({
      micNotice: `Falha ao ativar microfone (${errName || "erro"}): ${errMsg}`,
    });
  }
}

async function cleanupRoom(): Promise<void> {
  micPublishSeq += 1;
  lastRequestedMicOpts = null;
  stopMicMeter();

  if (localMicTrack) {
    await localMicTrack.stopProcessor().catch(() => {});
    localMicTrack.stop();
    localMicTrack = null;
  }

  for (const track of localScreenTracks) {
    track.stop();
  }
  localScreenTracks = [];

  for (const entry of attachedAudio.values()) {
    cleanupAudioEntry(entry);
  }
  attachedAudio.clear();
  remoteVideos.clear();

  if (activeRoom) {
    await activeRoom.disconnect().catch(() => {});
    activeRoom = null;
  }
  activeRoomName = null;

  snapshot = {
    connected: false,
    remoteVideoByUser: {},
    remoteParticipantIds: [],
    localScreenVideoTrack: null,
    audioPlaybackBlocked: false,
    micNotice: null,
    rmsLevel: 0,
    webRnnoiseActive: false,
  };
  for (const listener of listeners) {
    listener();
  }
}

export function canBrowserScreenShare(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getDisplayMedia)
  );
}

export async function unlockBrowserAudioPlayback(): Promise<void> {
  if (playbackAudioCtx && playbackAudioCtx.state === "suspended") {
    await playbackAudioCtx.resume().catch(() => {});
  }
  if (!activeRoom) return;
  await activeRoom.startAudio().catch(() => {});
  for (const entry of attachedAudio.values()) {
    void entry.element.play().catch(() => {});
  }
  const stillBlocked =
    !activeRoom.canPlaybackAudio || playbackAudioCtx?.state === "suspended";
  updateSnapshot({ audioPlaybackBlocked: stillBlocked });
}

export async function listBrowserAudioInputs(): Promise<
  Array<{ id: string; name: string }>
> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.enumerateDevices
  ) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d, index) => ({
      id: d.deviceId,
      name: d.label || `Microfone ${index + 1}`,
    }));
}

export function useBrowserRemoteMedia(): BrowserMediaSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

export async function startBrowserScreenShare(params?: {
  targetFps?: number;
  shareAudio?: boolean;
}): Promise<void> {
  if (!activeRoom) {
    throw new Error("Conecte em uma sala de voz antes de transmitir.");
  }
  if (!canBrowserScreenShare()) {
    throw new Error(
      "Seu navegador não suporta transmissão de tela neste contexto.",
    );
  }

  // Stop any previous local screen share cleanly first
  if (localScreenTracks.length > 0) {
    for (const oldTrack of localScreenTracks) {
      await activeRoom.localParticipant.unpublishTrack(oldTrack).catch(() => {});
      oldTrack.stop();
    }
    localScreenTracks = [];
    updateSnapshot({ localScreenVideoTrack: null });
  }

  const targetFps = params?.targetFps ?? 60;
  const shareAudio = params?.shareAudio ?? true;

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: targetFps },
    },
    audio: shareAudio,
  });

  const publishedTracks: LocalTrack[] = [];
  let localPreviewVideo: LocalVideoTrack | null = null;

  const [videoMediaTrack] = stream.getVideoTracks();
  if (videoMediaTrack) {
    try {
      videoMediaTrack.contentHint = targetFps >= 45 ? "motion" : "detail";
    } catch {
      // contentHint is optional on some browsers
    }
    const localVideo = new LocalVideoTrack(videoMediaTrack, undefined, false);
    await activeRoom.localParticipant.publishTrack(localVideo, {
      source: Track.Source.ScreenShare,
      name: "screen-video",
      videoCodec: "h264",
      simulcast: false,
      degradationPreference: "maintain-framerate",
      videoEncoding: {
        maxBitrate: 3_500_000,
        maxFramerate: targetFps,
      },
    });
    videoMediaTrack.addEventListener(
      "ended",
      () => {
        if (localScreenTracks.includes(localVideo)) {
          void useVoiceStore.getState().stopWindowShare().catch(() => {});
        }
      },
      { once: true },
    );
    publishedTracks.push(localVideo);
    localPreviewVideo = localVideo;
  }

  const [audioMediaTrack] = stream.getAudioTracks();
  if (audioMediaTrack) {
    const localAudio = new LocalAudioTrack(audioMediaTrack, undefined, false);
    await activeRoom.localParticipant.publishTrack(localAudio, {
      source: Track.Source.ScreenShareAudio,
      name: "screen-audio",
      audioPreset: AudioPresets.musicStereo,
      dtx: false,
      red: true,
    });
    publishedTracks.push(localAudio);
  }

  localScreenTracks = publishedTracks;
  updateSnapshot({ localScreenVideoTrack: localPreviewVideo });
}

export function createBrowserLiveKitTransport(): VoiceTransportAdapter {
  return {
    isConnectedToRoom: (roomName: string) => {
      return Boolean(
        activeRoom &&
          activeRoomName === roomName &&
          activeRoom.state === ConnectionState.Connected,
      );
    },

    isParticipantPresent: (userId: string) => {
      if (!activeRoom || activeRoom.state === ConnectionState.Disconnected) {
        return false;
      }
      if (remoteVideos.has(userId)) return true;
      for (const participant of activeRoom.remoteParticipants.values()) {
        if (normalizeParticipantIdentity(participant.identity) === userId) {
          return true;
        }
      }
      for (const entry of attachedAudio.values()) {
        if (entry.participantIdentity === userId) return true;
      }
      return false;
    },

    joinVoiceRoom: async ({
      url,
      token,
      roomName,
      micDeviceId,
      micDeviceLabel,
      rnnoiseEnabled,
    }) => {
      const targetRoomName = roomName ?? null;
      if (
        targetRoomName &&
        activeRoom &&
        activeRoomName === targetRoomName &&
        activeRoom.state === ConnectionState.Connected
      ) {
        return;
      }

      const myJoinSeq = ++joinSessionSeq;
      await cleanupRoom();
      if (myJoinSeq !== joinSessionSeq) return;

      ensurePlaybackAudioContext();

      if (typeof rnnoiseEnabled === "boolean") {
        browserRnnoiseEnabled = rnnoiseEnabled;
      }
      if (!isTauriRuntime() && browserRnnoiseEnabled) {
        preloadWebRnnoise();
      }

      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
        publishDefaults: {
          audioPreset: HIGH_QUALITY_VOICE_PRESET,
          dtx: true,
          red: true,
          videoCodec: "h264",
          simulcast: false,
          degradationPreference: "maintain-framerate",
          screenShareEncoding: {
            maxBitrate: 3_500_000,
            maxFramerate: 60,
          },
        },
      });

      room.on(RoomEvent.ParticipantConnected, () => {
        if (activeRoom !== room) return;
        notifyListeners();
      });

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (activeRoom !== room) return;
        attachRemoteTrack(track, publication, participant);
        notifyListeners();
      });

      room.on(
        RoomEvent.TrackUnsubscribed,
        (track, publication, participant) => {
          if (activeRoom !== room) return;
          detachRemoteTrack(track, publication, participant);
          notifyListeners();
        },
      );

      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (activeRoom !== room) return;
        const normalizedId = normalizeParticipantIdentity(participant.identity);
        // Only clean up tracks belonging to this exact participant identity if no sibling
        // identity (e.g. `<id>` vs `<id>-screen`) remains connected
        let stillHasSibling = false;
        for (const other of room.remoteParticipants.values()) {
          if (normalizeParticipantIdentity(other.identity) === normalizedId) {
            stillHasSibling = true;
            break;
          }
        }
        if (!stillHasSibling) {
          for (const [sid, entry] of attachedAudio.entries()) {
            if (entry.participantIdentity === normalizedId) {
              cleanupAudioEntry(entry);
              attachedAudio.delete(sid);
            }
          }
          remoteVideos.delete(normalizedId);
          // If signaling had already marked this peer as reconnecting/gone, remove them now
          const voiceState = useVoiceStore.getState();
          const existingPeer = voiceState.peers[normalizedId];
          if (existingPeer?.reconnecting) {
            const nextPeers = { ...voiceState.peers };
            delete nextPeers[normalizedId];
            useVoiceStore.setState({ peers: nextPeers });
          }
        }
        notifyListeners();
      });

      room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (activeRoom !== room) return;
        updateSnapshot({
          audioPlaybackBlocked:
            !room.canPlaybackAudio || playbackAudioCtx?.state === "suspended",
        });
      });

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        if (activeRoom !== room) return;
        const speakerIds = new Set(
          speakers.map((p) => normalizeParticipantIdentity(p.identity)),
        );
        const store = useVoiceStore.getState();
        const localId = normalizeParticipantIdentity(
          room.localParticipant.identity,
        );
        for (const peerId of Object.keys(store.peers)) {
          if (peerId !== localId) {
            store.setPeerSpeaking(peerId, speakerIds.has(peerId));
          }
        }
      });

      room.on(RoomEvent.Reconnected, () => {
        if (activeRoom !== room) return;
        updateSnapshot({ connected: true });
        if (!localMicTrack && lastRequestedMicOpts) {
          void createAndPublishBrowserMic(room, lastRequestedMicOpts).catch(
            () => {},
          );
        }
      });

      room.on(RoomEvent.Disconnected, () => {
        if (activeRoom === room) {
          activeRoomName = null;
          updateSnapshot({ connected: false, localScreenVideoTrack: null });
        }
      });

      await room.connect(url, token, {
        autoSubscribe: true,
        peerConnectionTimeout: 25_000,
      });

      if (myJoinSeq !== joinSessionSeq) {
        await room.disconnect().catch(() => {});
        return;
      }

      activeRoom = room;
      activeRoomName = targetRoomName ?? room.name ?? null;

      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.isSubscribed && publication.track) {
            attachRemoteTrack(publication.track, publication, participant);
          }
        }
      }

      await room.startAudio().catch(() => {});
      if (myJoinSeq !== joinSessionSeq || activeRoom !== room) return;

      updateSnapshot({
        connected: true,
        remoteParticipantIds: collectRemoteParticipantIds(),
        audioPlaybackBlocked:
          !room.canPlaybackAudio || playbackAudioCtx?.state === "suspended",
        micNotice: null,
      });

      try {
        await createAndPublishBrowserMic(room, {
          deviceId: micDeviceId,
          label: micDeviceLabel,
          rnnoiseEnabled: browserRnnoiseEnabled,
        });
      } catch (err) {
        if (
          myJoinSeq !== joinSessionSeq ||
          activeRoom !== room ||
          room.state === ConnectionState.Disconnected
        ) {
          return;
        }
        const errName = err instanceof Error ? err.name : "";
        const errMsg = err instanceof Error ? err.message : String(err);
        const notice =
          errName === "NotAllowedError" || errName === "PermissionDeniedError"
            ? "Permissão de microfone negada no navegador; áudio e vídeo da sala continuam ativos."
            : errName === "NotFoundError"
              ? "Nenhum microfone detectado neste dispositivo (modo ouvinte ativo)."
              : isTransientPublishError(err)
                ? "Conexão do microfone oscilou — reconectando automaticamente..."
                : `Falha ao ativar microfone (${errName || "erro"}): ${errMsg}`;
        updateSnapshot({ micNotice: notice });
      }
    },

    leaveVoiceRoom: async () => {
      joinSessionSeq += 1;
      await cleanupRoom();
    },

    setMicDevice: async ({ deviceId, label, rnnoiseEnabled }) => {
      if (typeof rnnoiseEnabled === "boolean") {
        browserRnnoiseEnabled = rnnoiseEnabled;
      }
      if (!isTauriRuntime() && browserRnnoiseEnabled) {
        preloadWebRnnoise();
      }
      if (!activeRoom || activeRoom.state !== ConnectionState.Connected) {
        return;
      }
      await createAndPublishBrowserMic(activeRoom, {
        deviceId,
        label,
        rnnoiseEnabled: browserRnnoiseEnabled,
      });
    },

    setVoiceControls: async ({ muted, deafened, rnnoiseEnabled }) => {
      if (typeof deafened === "boolean") {
        browserDeafened = deafened;
        if (deafened) {
          browserMuted = true;
        }
        applyPlaybackVolumes();
      }

      if (typeof muted === "boolean") {
        browserMuted = muted;
      }

      if (typeof rnnoiseEnabled === "boolean") {
        browserRnnoiseEnabled = rnnoiseEnabled;
        if (localMicTrack) {
          await applyRnnoiseToLocalMic(localMicTrack, rnnoiseEnabled);
        }
      }

      if (localMicTrack) {
        if (browserMuted || browserDeafened) {
          await localMicTrack.mute().catch(() => {});
        } else {
          await localMicTrack.unmute().catch(() => {});
        }
      }
    },

    setPushToTalkKey: async () => {
      // Global low-level keyboard PTT only runs in native Tauri runtime
    },

    startWindowShare: async ({ targetFps = 60, shareAudio = true }) => {
      await startBrowserScreenShare({ targetFps, shareAudio });
    },

    stopWindowShare: async () => {
      if (activeRoom) {
        for (const track of localScreenTracks) {
          await activeRoom.localParticipant
            .unpublishTrack(track)
            .catch(() => {});
          track.stop();
        }
      } else {
        for (const track of localScreenTracks) {
          track.stop();
        }
      }
      localScreenTracks = [];
      updateSnapshot({ localScreenVideoTrack: null });
    },

    playEntrySound: async (url, volume) => {
      if (browserDeafened || typeof Audio === "undefined") return;
      const clampedVol = Math.max(0, Math.min(2, volume));
      const ctx = ensurePlaybackAudioContext();
      if (ctx && clampedVol > 1) {
        try {
          const resp = await fetch(url);
          const buf = await resp.arrayBuffer();
          const decoded = await ctx.decodeAudioData(buf);
          const src = ctx.createBufferSource();
          const gain = ctx.createGain();
          src.buffer = decoded;
          gain.gain.value = clampedVol;
          src.connect(gain);
          gain.connect(ctx.destination);
          src.start(0);
          return;
        } catch {
          // Fallback to standard HTMLAudioElement if CORS blocks fetch
        }
      }
      const audio = new Audio(url);
      audio.volume = Math.max(0, Math.min(1, clampedVol));
      await audio.play().catch(() => {});
    },

    setPlaybackVolumes: ({ deafened, userVolumes, screenVolumes }) => {
      browserDeafened = deafened;
      currentUserVolumes = userVolumes;
      currentScreenVolumes = screenVolumes;
      applyPlaybackVolumes();
    },
  };
}
