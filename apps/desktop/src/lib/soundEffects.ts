import { useSyncExternalStore } from "react";
import type { VoiceSoundCallbacks } from "@cafofo/core-logic";

const SYSTEM_SOUND_VOLUME_KEY = "cafofo:system-sound-volume:v1";
const DEFAULT_SYSTEM_SOUND_VOLUME = 75;

let cachedVolumePercent: number | null = null;
const volumeListeners = new Set<() => void>();

function clampSystemVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SYSTEM_SOUND_VOLUME;
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function getSystemSoundVolume(): number {
  if (cachedVolumePercent !== null) {
    return cachedVolumePercent;
  }
  if (typeof localStorage === "undefined") {
    cachedVolumePercent = DEFAULT_SYSTEM_SOUND_VOLUME;
    return cachedVolumePercent;
  }
  try {
    const raw = localStorage.getItem(SYSTEM_SOUND_VOLUME_KEY);
    if (raw === null) {
      cachedVolumePercent = DEFAULT_SYSTEM_SOUND_VOLUME;
      return cachedVolumePercent;
    }
    const parsed = Number(raw);
    cachedVolumePercent = clampSystemVolume(parsed);
    return cachedVolumePercent;
  } catch {
    cachedVolumePercent = DEFAULT_SYSTEM_SOUND_VOLUME;
    return cachedVolumePercent;
  }
}

export function setSystemSoundVolume(volumePercent: number): void {
  const next = clampSystemVolume(volumePercent);
  cachedVolumePercent = next;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(SYSTEM_SOUND_VOLUME_KEY, String(next));
    } catch {
      // ignore storage quota errors
    }
  }
  for (const listener of volumeListeners) {
    listener();
  }
}

function subscribeSystemSoundVolume(listener: () => void): () => void {
  volumeListeners.add(listener);
  return () => {
    volumeListeners.delete(listener);
  };
}

export function useSystemSoundVolume(): [number, (next: number) => void] {
  const vol = useSyncExternalStore(
    subscribeSystemSoundVolume,
    getSystemSoundVolume,
    () => DEFAULT_SYSTEM_SOUND_VOLUME,
  );
  return [vol, setSystemSoundVolume];
}

let sharedAudioCtx: AudioContext | null = null;
let audioUnlockBound = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new Ctx();
  }
  if (!audioUnlockBound) {
    audioUnlockBound = true;
    const unlock = () => {
      if (sharedAudioCtx && sharedAudioCtx.state === "suspended") {
        void sharedAudioCtx.resume().catch(() => {});
      }
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock, { passive: true });
  }
  return sharedAudioCtx;
}

function runWithAudioContext(fn: (ctx: AudioContext) => void): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx
      .resume()
      .then(() => {
        if (ctx.state === "running") {
          fn(ctx);
        }
      })
      .catch(() => {});
    return;
  }
  fn(ctx);
}

function scheduleCyberTone(params: {
  ctx: AudioContext;
  startTime: number;
  durationSec: number;
  freqStartHz: number;
  freqEndHz?: number;
  peakGain: number;
  type?: OscillatorType;
}): void {
  const {
    ctx,
    startTime,
    durationSec,
    freqStartHz,
    freqEndHz,
    peakGain,
    type = "sine",
  } = params;
  if (peakGain <= 0.0005) return;

  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freqStartHz, startTime);
  if (freqEndHz && freqEndHz !== freqStartHz) {
    osc.frequency.exponentialRampToValueAtTime(
      Math.max(40, freqEndHz),
      startTime + durationSec,
    );
  }

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(2400, startTime);

  gain.gain.setValueAtTime(0.0001, startTime);
  gain.gain.exponentialRampToValueAtTime(
    Math.min(0.6, peakGain),
    startTime + Math.min(0.014, durationSec * 0.25),
  );
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + durationSec);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + durationSec + 0.01);
}

/**
 * Som sutil de "bipe de radar/conexão" (440Hz -> 880Hz) quando alguém entra na sala de voz.
 */
export function playVoiceJoinSound(): void {
  const volPercent = getSystemSoundVolume();
  if (volPercent <= 0) return;

  runWithAudioContext((ctx) => {
    const scale = (volPercent / 100) * 0.16;
    const now = ctx.currentTime + 0.005;

    // Primeiro pulso de radar (440Hz)
    scheduleCyberTone({
      ctx,
      startTime: now,
      durationSec: 0.075,
      freqStartHz: 440,
      freqEndHz: 587.33,
      peakGain: scale * 0.85,
      type: "triangle",
    });

    // Harmônico de confirmação (880Hz)
    scheduleCyberTone({
      ctx,
      startTime: now + 0.068,
      durationSec: 0.12,
      freqStartHz: 880,
      freqEndHz: 880,
      peakGain: scale,
      type: "sine",
    });
  });
}

/**
 * Som sutil de "desconexão" (880Hz -> 440Hz -> 330Hz) quando alguém sai da sala de voz.
 */
export function playVoiceLeaveSound(): void {
  const volPercent = getSystemSoundVolume();
  if (volPercent <= 0) return;

  runWithAudioContext((ctx) => {
    const scale = (volPercent / 100) * 0.15;
    const now = ctx.currentTime + 0.005;

    scheduleCyberTone({
      ctx,
      startTime: now,
      durationSec: 0.07,
      freqStartHz: 659.25,
      freqEndHz: 440,
      peakGain: scale * 0.9,
      type: "sine",
    });

    scheduleCyberTone({
      ctx,
      startTime: now + 0.062,
      durationSec: 0.11,
      freqStartHz: 440,
      freqEndHz: 293.66,
      peakGain: scale * 0.8,
      type: "triangle",
    });
  });
}

/**
 * Clique suave no toggle de mutar/desmutar microfone.
 */
export function playMuteToggleSound(muted: boolean): void {
  const volPercent = getSystemSoundVolume();
  if (volPercent <= 0) return;

  runWithAudioContext((ctx) => {
    const scale = (volPercent / 100) * 0.1;
    const now = ctx.currentTime + 0.003;

    scheduleCyberTone({
      ctx,
      startTime: now,
      durationSec: 0.055,
      freqStartHz: muted ? 520 : 440,
      freqEndHz: muted ? 350 : 660,
      peakGain: scale,
      type: "sine",
    });
  });
}

/**
 * Clique suave no toggle de ensurdecer/reativar áudio.
 */
export function playDeafenToggleSound(deafened: boolean): void {
  const volPercent = getSystemSoundVolume();
  if (volPercent <= 0) return;

  runWithAudioContext((ctx) => {
    const scale = (volPercent / 100) * 0.11;
    const now = ctx.currentTime + 0.003;

    scheduleCyberTone({
      ctx,
      startTime: now,
      durationSec: 0.05,
      freqStartHz: deafened ? 440 : 370,
      freqEndHz: deafened ? 310 : 520,
      peakGain: scale * 0.85,
      type: "sine",
    });

    scheduleCyberTone({
      ctx,
      startTime: now + 0.045,
      durationSec: 0.065,
      freqStartHz: deafened ? 310 : 520,
      freqEndHz: deafened ? 240 : 740,
      peakGain: scale,
      type: "triangle",
    });
  });
}

let lastChatSoundAt = 0;

/**
 * Som suave de popup (2 notas cristalinas) ao receber nova mensagem de chat.
 */
export function playChatMessageSound(): void {
  const volPercent = getSystemSoundVolume();
  if (volPercent <= 0) return;

  const nowMs = Date.now();
  if (nowMs - lastChatSoundAt < 350) return;
  lastChatSoundAt = nowMs;

  runWithAudioContext((ctx) => {
    const scale = (volPercent / 100) * 0.13;
    const now = ctx.currentTime + 0.004;

    // Nota inicial suave (D5 -> F#5)
    scheduleCyberTone({
      ctx,
      startTime: now,
      durationSec: 0.068,
      freqStartHz: 587.33,
      freqEndHz: 739.99,
      peakGain: scale * 0.85,
      type: "sine",
    });

    // Nota harmônica de confirmação (A5)
    scheduleCyberTone({
      ctx,
      startTime: now + 0.056,
      durationSec: 0.115,
      freqStartHz: 880,
      freqEndHz: 932.33,
      peakGain: scale,
      type: "triangle",
    });
  });
}

/**
 * Toque melódico moderno para chamada 1:1 recebida (2 acordes cristalinos).
 */
export function playIncomingCallRingtone(): void {
  const volPercent = getSystemSoundVolume();
  if (volPercent <= 0) return;

  runWithAudioContext((ctx) => {
    const scale = (volPercent / 100) * 0.14;
    const now = ctx.currentTime + 0.01;
    const notes: Array<[number, number, number]> = [
      [0.0, 523.25, 0.16], // C5
      [0.14, 659.25, 0.16], // E5
      [0.28, 783.99, 0.24], // G5
      [0.62, 659.25, 0.16], // E5
      [0.76, 783.99, 0.18], // G5
      [0.92, 1046.5, 0.3], // C6
    ];
    for (const [offset, freq, dur] of notes) {
      scheduleCyberTone({
        ctx,
        startTime: now + offset,
        durationSec: dur,
        freqStartHz: freq,
        freqEndHz: freq,
        peakGain: scale,
        type: "sine",
      });
    }
  });
}

/**
 * Sino discreto quando chega um novo pedido de amizade.
 */
export function playFriendRequestSound(): void {
  const volPercent = getSystemSoundVolume();
  if (volPercent <= 0) return;

  runWithAudioContext((ctx) => {
    const scale = (volPercent / 100) * 0.13;
    const now = ctx.currentTime + 0.005;
    scheduleCyberTone({
      ctx,
      startTime: now,
      durationSec: 0.09,
      freqStartHz: 659.25,
      freqEndHz: 880,
      peakGain: scale * 0.9,
      type: "sine",
    });
    scheduleCyberTone({
      ctx,
      startTime: now + 0.085,
      durationSec: 0.15,
      freqStartHz: 987.77,
      freqEndHz: 1174.66,
      peakGain: scale,
      type: "triangle",
    });
  });
}

export function createVoiceSoundCallbacks(): VoiceSoundCallbacks {
  return {
    onJoin: playVoiceJoinSound,
    onLeave: playVoiceLeaveSound,
    onMuteToggle: playMuteToggleSound,
    onDeafenToggle: playDeafenToggleSound,
  };
}
