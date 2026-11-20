import type { GamePresenceUpdate, VoiceTransportAdapter } from "@cafofo/core-logic";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createBrowserLiveKitTransport } from "./livekitBrowser";

export interface AudioDeviceInfo {
  id: string;
  name: string;
  direction: "Input" | "Output";
  is_default: boolean;
  sample_rate: number;
  channels: number;
}

export interface WindowInfo {
  hwnd: number;
  pid: number;
  title: string;
  process_name: string;
  icon_png_base64: string | null;
}

export type LoopbackMode = "ProcessTreeIsolated" | "StandardSystemFallback";

export interface AudioStatus {
  connected: boolean;
  muted: boolean;
  deafened: boolean;
  rnnoise_enabled: boolean;
  ptt_key: number | null;
  ptt_active: boolean;
  rms_level: number;
  vad_probability: number;
  sharing_window_hwnd: number | null;
  loopback_mode: LoopbackMode | null;
}

export interface KnownGameEntry {
  game_id: string;
  name: string;
  executables: string[];
  is_custom: boolean;
}

export interface ActiveGameSession {
  game_id: string;
  game_name: string;
  process_name: string;
  pid: number;
  started_at_ms: number;
  is_custom: boolean;
}

export interface DetectedProcess {
  pid: number;
  name: string;
  executable_path: string | null;
}

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

export function listAudioInputDevices(): Promise<AudioDeviceInfo[]> {
  return invoke<AudioDeviceInfo[]>("list_audio_input_devices");
}

export function listCaptureWindows(): Promise<WindowInfo[]> {
  return invoke<WindowInfo[]>("list_capture_windows");
}

export function joinVoiceRoom(params: {
  url: string;
  token: string;
  micDeviceId?: string | null;
}): Promise<void> {
  return invoke<void>("join_voice_room", {
    url: params.url,
    token: params.token,
    micDeviceId: params.micDeviceId ?? null,
  });
}

export function leaveVoiceRoom(): Promise<void> {
  return invoke<void>("leave_voice_room");
}

export function setVoiceControls(params: {
  muted?: boolean;
  deafened?: boolean;
  rnnoiseEnabled?: boolean;
}): Promise<void> {
  return invoke<void>("set_voice_controls", {
    muted: params.muted ?? null,
    deafened: params.deafened ?? null,
    rnnoiseEnabled: params.rnnoiseEnabled ?? null,
  });
}

export function setPushToTalkKey(vkCode: number | null): Promise<void> {
  return invoke<void>("set_push_to_talk_key", { vkCode });
}

export function getAudioStatus(): Promise<AudioStatus> {
  return invoke<AudioStatus>("get_audio_status");
}

export function startWindowShare(params: {
  hwnd: number;
  pid: number;
  targetFps?: number;
  shareAudio?: boolean;
}): Promise<void> {
  return invoke<void>("start_window_share", {
    hwnd: params.hwnd,
    pid: params.pid,
    targetFps: params.targetFps ?? null,
    shareAudio: params.shareAudio ?? null,
  });
}

export function stopWindowShare(): Promise<void> {
  return invoke<void>("stop_window_share");
}

export function setGameCatalog(entries: KnownGameEntry[]): Promise<void> {
  return invoke<void>("set_game_catalog", { entries });
}

export function syncCustomGames(
  entries: KnownGameEntry[],
): Promise<KnownGameEntry[]> {
  return invoke<KnownGameEntry[]>("sync_custom_games", { entries });
}

export function extractExeIcon(exePath: string): Promise<string | null> {
  return invoke<string | null>("extract_exe_icon", { exePath });
}

export function listCustomGames(): Promise<KnownGameEntry[]> {
  return invoke<KnownGameEntry[]>("list_custom_games");
}

export function addCustomGame(params: {
  name: string;
  executable: string;
}): Promise<KnownGameEntry[]> {
  return invoke<KnownGameEntry[]>("add_custom_game", params);
}

export function removeCustomGame(gameId: string): Promise<KnownGameEntry[]> {
  return invoke<KnownGameEntry[]>("remove_custom_game", { gameId });
}

export function getActiveGameSession(): Promise<ActiveGameSession | null> {
  return invoke<ActiveGameSession | null>("get_active_game_session");
}

export function listRunningProcesses(): Promise<DetectedProcess[]> {
  return invoke<DetectedProcess[]>("list_running_processes");
}

export function playEntrySound(url: string, volume: number): Promise<void> {
  return invoke<void>("play_entry_sound", { url, volume });
}

export function listenGamePresenceChanged(
  handler: (payload: GamePresenceUpdate) => void,
): Promise<UnlistenFn> {
  return listen<GamePresenceUpdate>("game-presence-changed", (event) => {
    handler(event.payload);
  });
}

export function createTauriVoiceTransport(): VoiceTransportAdapter {
  const webRtcTransport = createBrowserLiveKitTransport();
  if (!isTauriRuntime()) {
    return webRtcTransport;
  }

  // No Desktop Windows (WebView2), usa o motor LiveKit WebRTC completo para
  // garantir reprodução de áudio remoto, controle de volume individual (0-200%),
  // visualização de transmissões 16:9 e RNNoise WASM, mantendo recursos nativos
  // como som de entrada, Game Detector, bandeja do sistema e auto-update.
  return {
    ...webRtcTransport,
    playEntrySound,
  };
}
