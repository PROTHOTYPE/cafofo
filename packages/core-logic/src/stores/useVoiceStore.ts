import { create } from "zustand";
import type {
  GamePresenceUpdate,
  PeerState,
  ScreenShareStarted,
} from "../generated";
import {
  resolveSignalingUrl,
  SignalingClient,
  type ConnectionStatus,
} from "../ws/SignalingClient";
import { getSupabaseClientOrThrow, useAuthStore } from "./useAuthStore";
import {
  onVoicePresenceUpdate,
  usePresenceStore,
} from "./usePresenceStore";
import { useServerStore } from "./useServerStore";

/**
 * Resolves the default WebSocket signaling URL via `SignalingClient`'s
 * dynamic hostname/env resolver.
 */
export function getDefaultSignalingUrl(explicitUrl?: string): string {
  return resolveSignalingUrl(explicitUrl);
}

function isLoopbackHost(hostname: string): boolean {
  const clean = hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return clean === "localhost" || clean === "127.0.0.1" || clean === "::1";
}

function isLocalDesktopHost(hostname: string): boolean {
  const clean = hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return (
    isLoopbackHost(clean) ||
    clean === "tauri.localhost" ||
    clean.endsWith(".tauri.localhost")
  );
}

function isPrivateLanIpv4(hostname: string): boolean {
  const clean = hostname.trim().replace(/^\[|\]$/g, "");
  return (
    /^192\.168\./.test(clean) ||
    /^10\./.test(clean) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(clean)
  );
}

function isLocalRuntimeWindow(): boolean {
  if (typeof window === "undefined") return false;
  return isLocalDesktopHost(window.location?.hostname ?? "");
}

function resolveLiveKitUrl(issuedUrl: string, signalingUrl: string): string {
  try {
    const lk = new URL(issuedUrl);
    if (!isLoopbackHost(lk.hostname)) {
      // Never rewrite public/cloud hosts (e.g. wss://*.livekit.cloud) or explicit LAN hosts.
      return issuedUrl;
    }

    const sig = new URL(signalingUrl);
    if (isLocalRuntimeWindow() || isLocalDesktopHost(sig.hostname)) {
      lk.hostname = "127.0.0.1";
      return lk.toString().replace(/\/$/, "");
    }

    if (isPrivateLanIpv4(sig.hostname)) {
      lk.hostname = sig.hostname;
      return lk.toString().replace(/\/$/, "");
    }

    return issuedUrl;
  } catch {
    return issuedUrl;
  }
}

const AUDIO_PREFS_STORAGE_KEY = "cafofo:audio-prefs:v1";

interface PersistedAudioPrefs {
  userVolumes: Record<string, number>;
  screenVolumes: Record<string, number>;
  selectedMicDeviceId: string | null;
  selectedMicLabel: string | null;
  rnnoiseEnabled: boolean;
}

function loadAudioPrefs(): PersistedAudioPrefs {
  const defaults: PersistedAudioPrefs = {
    userVolumes: {},
    screenVolumes: {},
    selectedMicDeviceId: null,
    selectedMicLabel: null,
    rnnoiseEnabled: true,
  };
  if (typeof localStorage === "undefined") {
    return defaults;
  }
  try {
    const raw = localStorage.getItem(AUDIO_PREFS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedAudioPrefs>;
    return {
      userVolumes: parsed.userVolumes ?? {},
      screenVolumes: parsed.screenVolumes ?? {},
      selectedMicDeviceId:
        typeof parsed.selectedMicDeviceId === "string" &&
        parsed.selectedMicDeviceId.trim().length > 0
          ? parsed.selectedMicDeviceId
          : null,
      selectedMicLabel:
        typeof parsed.selectedMicLabel === "string" &&
        parsed.selectedMicLabel.trim().length > 0
          ? parsed.selectedMicLabel
          : null,
      rnnoiseEnabled:
        typeof parsed.rnnoiseEnabled === "boolean"
          ? parsed.rnnoiseEnabled
          : true,
    };
  } catch {
    return defaults;
  }
}

function saveAudioPrefs(prefs: PersistedAudioPrefs): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(AUDIO_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage quota errors
  }
}

export function clampVolumePercent(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(200, Math.round(value)));
}

export interface VoiceTransportAdapter {
  joinVoiceRoom: (params: {
    url: string;
    token: string;
    roomName?: string;
    micDeviceId?: string | null;
    micDeviceLabel?: string | null;
    rnnoiseEnabled?: boolean;
  }) => Promise<void>;
  leaveVoiceRoom: () => Promise<void>;
  isConnectedToRoom?: (roomName: string) => boolean;
  isParticipantPresent?: (userId: string) => boolean;
  setMicDevice?: (params: {
    deviceId: string | null;
    label?: string | null;
    rnnoiseEnabled?: boolean;
  }) => Promise<void>;
  setVoiceControls: (params: {
    muted?: boolean;
    deafened?: boolean;
    rnnoiseEnabled?: boolean;
  }) => Promise<void>;
  setPushToTalkKey: (vkCode: number | null) => Promise<void>;
  startWindowShare: (params: {
    hwnd: number;
    pid: number;
    targetFps?: number;
    shareAudio?: boolean;
  }) => Promise<void>;
  stopWindowShare: () => Promise<void>;
  playEntrySound: (url: string, volume: number) => Promise<void>;
  setPlaybackVolumes?: (params: {
    deafened: boolean;
    userVolumes: Record<string, number>;
    screenVolumes: Record<string, number>;
  }) => void;
}

export interface VoiceSoundCallbacks {
  onJoin?: () => void;
  onLeave?: () => void;
  onMuteToggle?: (muted: boolean) => void;
  onDeafenToggle?: (deafened: boolean) => void;
}

interface VoiceState {
  signalingUrl: string;
  signalingClient: SignalingClient | null;
  transport: VoiceTransportAdapter | null;
  soundCallbacks: VoiceSoundCallbacks | null;
  connectionStatus: ConnectionStatus;
  isJoining: boolean;
  activeVoiceChannelId: string | null;
  activeVoiceChannelName: string | null;
  peers: Record<string, PeerState>;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  rnnoiseEnabled: boolean;
  pttKey: number | null;
  selectedMicDeviceId: string | null;
  selectedMicLabel: string | null;
  sharingWindow: { hwnd: number; pid: number; title: string } | null;
  livekitUrl: string | null;
  userVolumes: Record<string, number>;
  screenVolumes: Record<string, number>;
  error: string | null;

  configure: (params: {
    signalingUrl?: string;
    transport?: VoiceTransportAdapter | null;
    soundCallbacks?: VoiceSoundCallbacks | null;
  }) => void;
  joinVoiceChannel: (params: {
    channelId: string;
    channelName: string;
  }) => Promise<void>;
  leaveVoiceChannel: (options?: {
    silent?: boolean;
    skipPresenceClear?: boolean;
  }) => Promise<void>;
  toggleMute: () => Promise<void>;
  toggleDeafen: () => Promise<void>;
  toggleRnnoise: () => Promise<void>;
  setSelectedMicDeviceId: (
    deviceId: string | null,
    label?: string | null,
  ) => Promise<void>;
  setPushToTalkKey: (vkCode: number | null) => Promise<void>;
  startWindowShare: (params: {
    hwnd: number;
    pid: number;
    title: string;
    targetFps?: number;
    shareAudio?: boolean;
  }) => Promise<void>;
  stopWindowShare: () => Promise<void>;
  syncGamePresence: (presence: GamePresenceUpdate | null) => void;
  setLocalSpeaking: (speaking: boolean) => void;
  setPeerSpeaking: (userId: string, speaking: boolean) => void;
  movePeerToRoom: (params: {
    serverId: string;
    sourceRoomId: string;
    targetRoomId: string;
    targetUserId: string;
  }) => void;
  setUserVolume: (userId: string, volumePercent: number) => void;
  setScreenVolume: (streamId: string, volumePercent: number) => void;
}

const initialPrefs = loadAudioPrefs();
const peerJoinSoundCooldown = new Map<string, number>();
const peerEntrySoundCooldown = new Map<string, number>();
const peerLeaveSoundCooldown = new Map<string, number>();
let activeJoinController: AbortController | null = null;
let activeJoinPromise: Promise<void> | null = null;
let inFlightTargetChannelId: string | null = null;

function persistVoiceAudioPrefs(state: {
  userVolumes: Record<string, number>;
  screenVolumes: Record<string, number>;
  selectedMicDeviceId: string | null;
  selectedMicLabel: string | null;
  rnnoiseEnabled: boolean;
}): void {
  saveAudioPrefs({
    userVolumes: state.userVolumes,
    screenVolumes: state.screenVolumes,
    selectedMicDeviceId: state.selectedMicDeviceId,
    selectedMicLabel: state.selectedMicLabel,
    rnnoiseEnabled: state.rnnoiseEnabled,
  });
}

function canFireSoundCooldown(map: Map<string, number>, key: string, windowMs = 2500): boolean {
  const now = Date.now();
  const prev = map.get(key) ?? 0;
  if (now - prev < windowMs) return false;
  map.set(key, now);
  return true;
}

async function playFriendEntrySound(
  friendUserId: string,
  transport: VoiceTransportAdapter | null,
  deafened: boolean,
  userVolumePercent: number,
): Promise<void> {
  if (!transport || deafened) return;
  try {
    const supabase = getSupabaseClientOrThrow();
    const { data } = await supabase
      .from("profiles")
      .select("entry_sound_url, entry_sound_volume")
      .eq("id", friendUserId)
      .maybeSingle();

    if (!data?.entry_sound_url) return;
    const baseVolume = Number(data.entry_sound_volume ?? 0.75);
    const effective = Math.max(0, Math.min(2, baseVolume * (userVolumePercent / 100)));
    await transport.playEntrySound(data.entry_sound_url, effective);
  } catch {
    // Non-fatal if entry sound playback fails
  }
}

export const useVoiceStore = create<VoiceState>((set, get) => ({
  signalingUrl: getDefaultSignalingUrl(),
  signalingClient: null,
  transport: null,
  soundCallbacks: null,
  connectionStatus: "disconnected",
  isJoining: false,
  activeVoiceChannelId: null,
  activeVoiceChannelName: null,
  peers: {},
  muted: false,
  deafened: false,
  speaking: false,
  rnnoiseEnabled: initialPrefs.rnnoiseEnabled,
  pttKey: null,
  selectedMicDeviceId: initialPrefs.selectedMicDeviceId,
  selectedMicLabel: initialPrefs.selectedMicLabel,
  sharingWindow: null,
  livekitUrl: null,
  userVolumes: initialPrefs.userVolumes,
  screenVolumes: initialPrefs.screenVolumes,
  error: null,

  configure: ({ signalingUrl, transport, soundCallbacks }) => {
    set((prev) => ({
      signalingUrl: signalingUrl ?? prev.signalingUrl,
      transport: transport !== undefined ? transport : prev.transport,
      soundCallbacks:
        soundCallbacks !== undefined ? soundCallbacks : prev.soundCallbacks,
    }));
  },

  joinVoiceChannel: async ({ channelId, channelName }) => {
    const auth = useAuthStore.getState();
    const userId = auth.user?.id;
    const accessToken = auth.session?.access_token;
    const displayName =
      auth.profile?.display_name || auth.profile?.username || "Cafofo User";

    if (!userId || !accessToken) {
      throw new Error("Faça login antes de entrar em uma sala de voz.");
    }

    if (activeJoinPromise && inFlightTargetChannelId === channelId) {
      return activeJoinPromise;
    }

    const existingClient = get().signalingClient;
    if (get().activeVoiceChannelId === channelId && existingClient && !get().isJoining) {
      if (!existingClient.isOpen()) {
        existingClient.connect();
      }
      return;
    }

    activeJoinController?.abort();
    const joinController = new AbortController();
    activeJoinController = joinController;
    inFlightTargetChannelId = channelId;

    const runJoin = async (): Promise<void> => {
      set({ isJoining: true, error: null });
      try {
        const wasSwitchingRoom = Boolean(get().activeVoiceChannelId);
        await get().leaveVoiceChannel({
          silent: wasSwitchingRoom,
          skipPresenceClear: wasSwitchingRoom,
        });
        if (joinController.signal.aborted) return;

        // Seed peers immediately from Realtime presence + self so UI renders with 0ms delay
        const activeServerId = useServerStore.getState().activeServerId;
        const serverMembers = activeServerId
          ? (useServerStore.getState().membersByServer[activeServerId] ?? [])
          : [];
        const presenceOnline = activeServerId
          ? (usePresenceStore.getState().onlineByServer[activeServerId] ?? {})
          : {};
        const initialPeers: Record<string, PeerState> = {
          [userId]: {
            user_id: userId,
            display_name: displayName,
            muted: get().muted,
            deafened: get().deafened,
            speaking: false,
            noise_suppression: get().rnnoiseEnabled,
            reconnecting: false,
            game_presence: usePresenceStore.getState().currentGame,
            screen_sharing: null,
          },
        };
        for (const pres of Object.values(presenceOnline)) {
          if (pres.user_id !== userId && pres.voice_state?.channel_id === channelId) {
            const member = serverMembers.find((m) => m.user_id === pres.user_id);
            const peerName =
              pres.voice_state.display_name ||
              member?.nickname ||
              member?.profile?.display_name ||
              member?.profile?.username ||
              pres.user_id.slice(0, 8);
            initialPeers[pres.user_id] = {
              user_id: pres.user_id,
              display_name: peerName,
              muted: pres.voice_state.muted,
              deafened: pres.voice_state.deafened,
              speaking: pres.voice_state.speaking,
              noise_suppression: true,
              reconnecting: false,
              game_presence: pres.game_presence ?? null,
              screen_sharing: pres.voice_state.is_streaming
                ? {
                    room_id: channelId,
                    user_id: pres.user_id,
                    stream_id: `presence-${pres.user_id}`,
                    source_title: "Transmissão ao vivo",
                    width: 1920,
                    height: 1080,
                    fps: 60,
                    has_audio: true,
                  }
                : null,
            };
          }
        }

        set({
          activeVoiceChannelId: channelId,
          activeVoiceChannelName: channelName,
          peers: initialPeers,
          error: null,
        });

        get().soundCallbacks?.onJoin?.();

        const client = new SignalingClient({
          url: get().signalingUrl,
          accessToken,
          autoReconnect: true,
        });

        joinController.signal.addEventListener(
          "abort",
          () => {
            client.disconnect();
          },
          { once: true },
        );

        const pushLocalPresenceVoice = () => {
          if (joinController.signal.aborted) return;
          const s = get();
          void usePresenceStore.getState().setLocalVoiceState(
            s.activeVoiceChannelId
              ? {
                  channel_id: s.activeVoiceChannelId,
                  display_name: displayName,
                  muted: s.muted,
                  deafened: s.deafened,
                  speaking: s.speaking,
                  is_streaming: Boolean(s.sharingWindow),
                }
              : null,
            userId,
          );
        };

        // Broadcast immediately via Supabase Realtime Channel without waiting for signaling WS
        pushLocalPresenceVoice();

        client.on("statusChange", (status) => {
          if (joinController.signal.aborted) return;
          set((prev) => ({
            connectionStatus: status,
            error: status === "connected" || status === "reconnecting" ? null : prev.error,
          }));
          if (status === "connected") {
            client.joinRoom({
              room_id: channelId,
              user_id: userId,
              display_name: displayName,
              access_token: accessToken,
            });
          }
        });

        client.on("roomJoined", (snapshot) => {
          if (joinController.signal.aborted) return;
          const currentSharing = get().sharingWindow;
          const currentMuted = get().muted;
          const currentDeafened = get().deafened;
          const currentRnnoise = get().rnnoiseEnabled;
          const prevPeers = get().peers;
          const transport = get().transport;
          const peerMap: Record<string, PeerState> = {};
          for (const peer of snapshot.peers) {
            peerMap[peer.user_id] = peer;
          }
          // Preserve any remote peer whose LiveKit audio/video is still actively connected
          // even if their signaling WebSocket briefly reconnected
          for (const [uid, prevPeer] of Object.entries(prevPeers)) {
            if (!peerMap[uid] && uid !== userId && transport?.isParticipantPresent?.(uid)) {
              peerMap[uid] = prevPeer;
            }
          }
          if (peerMap[userId]) {
            peerMap[userId] = {
              ...peerMap[userId],
              muted: currentMuted,
              deafened: currentDeafened,
              noise_suppression: currentRnnoise,
              screen_sharing:
                peerMap[userId].screen_sharing ??
                (currentSharing
                  ? {
                      room_id: snapshot.room_id,
                      user_id: userId,
                      stream_id: `win-${currentSharing.hwnd}`,
                      source_title: currentSharing.title,
                      width: 1920,
                      height: 1080,
                      fps: 60,
                      has_audio: true,
                    }
                  : null),
            };
          } else {
            peerMap[userId] = {
              user_id: userId,
              display_name: displayName,
              muted: currentMuted,
              deafened: currentDeafened,
              speaking: get().speaking,
              noise_suppression: currentRnnoise,
              reconnecting: false,
              game_presence: usePresenceStore.getState().currentGame,
              screen_sharing: currentSharing
                ? {
                    room_id: snapshot.room_id,
                    user_id: userId,
                    stream_id: `win-${currentSharing.hwnd}`,
                    source_title: currentSharing.title,
                    width: 1920,
                    height: 1080,
                    fps: 60,
                    has_audio: true,
                  }
                : null,
            };
          }
          set({ peers: peerMap, error: null });
          pushLocalPresenceVoice();

          // Always sync current local mute/deafen/screen-share state to server after reconnect
          if (currentMuted || currentDeafened || !currentRnnoise) {
            client.updateVoiceState({
              room_id: snapshot.room_id,
              user_id: userId,
              muted: currentMuted,
              deafened: currentDeafened,
              speaking: get().speaking,
              noise_suppression: currentRnnoise,
            });
          }
          if (currentSharing) {
            client.notifyScreenShareStarted({
              room_id: snapshot.room_id,
              user_id: userId,
              stream_id: `win-${currentSharing.hwnd}`,
              source_title: currentSharing.title,
              width: 1920,
              height: 1080,
              fps: 60,
              has_audio: true,
            });
          }

          // If LiveKit is ALREADY connected to this exact room (e.g. signaling WS reconnected
          // after a brief Fly.io proxy drop), DO NOT tear down LiveKit or kill active screen shares!
          const alreadyConnectedLiveKit =
            get().transport?.isConnectedToRoom?.(snapshot.room_id) ?? false;
          if (!alreadyConnectedLiveKit) {
            client.requestLiveKitToken(snapshot.room_id);
          }

          const currentGame = usePresenceStore.getState().currentGame;
          if (currentGame) {
            client.updateGamePresence({ ...currentGame, user_id: userId });
          }
        });

        client.on("peerMovedToRoom", ({ target_room_id }) => {
          if (
            joinController.signal.aborted ||
            !target_room_id ||
            get().activeVoiceChannelId === target_room_id
          ) {
            return;
          }
          const channelsByServer = useServerStore.getState().channelsByServer;
          let targetName = "Sala de Voz";
          for (const chList of Object.values(channelsByServer)) {
            const match = chList.find((c) => c.id === target_room_id);
            if (match) {
              targetName = match.name;
              break;
            }
          }
          void get().joinVoiceChannel({
            channelId: target_room_id,
            channelName: targetName,
          });
        });

        let livekitJoiningRoom: string | null = null;

        client.on("liveKitTokenIssued", async ({ url, token, room_name }) => {
          if (joinController.signal.aborted) return;
          const resolvedUrl = resolveLiveKitUrl(url, get().signalingUrl);
          set({ livekitUrl: resolvedUrl, error: null });
          const transport = get().transport;
          if (!transport) return;

          const targetRoomName = room_name || channelId;
          if (
            livekitJoiningRoom === targetRoomName ||
            transport.isConnectedToRoom?.(targetRoomName)
          ) {
            return;
          }

          livekitJoiningRoom = targetRoomName;
          const maxAttempts = 2;
          let lastErr: unknown = null;
          try {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
              if (joinController.signal.aborted) return;
              try {
                await transport.joinVoiceRoom({
                  url: resolvedUrl,
                  token,
                  roomName: targetRoomName,
                  micDeviceId: get().selectedMicDeviceId,
                  micDeviceLabel: get().selectedMicLabel,
                  rnnoiseEnabled: get().rnnoiseEnabled,
                });
                if (joinController.signal.aborted) {
                  await transport.leaveVoiceRoom().catch(() => {});
                  return;
                }
                await transport.setVoiceControls({
                  muted: get().muted,
                  deafened: get().deafened,
                  rnnoiseEnabled: get().rnnoiseEnabled,
                });
                transport.setPlaybackVolumes?.({
                  deafened: get().deafened,
                  userVolumes: get().userVolumes,
                  screenVolumes: get().screenVolumes,
                });
                await transport.setPushToTalkKey(get().pttKey);
                set({ error: null });
                return;
              } catch (err) {
                lastErr = err;
                if (attempt < maxAttempts && !joinController.signal.aborted) {
                  await new Promise((resolve) => setTimeout(resolve, 600));
                }
              }
            }

            if (!joinController.signal.aborted && lastErr) {
              const message =
                lastErr instanceof Error ? lastErr.message : String(lastErr);
              set({ error: message });
            }
          } finally {
            if (livekitJoiningRoom === targetRoomName) {
              livekitJoiningRoom = null;
            }
          }
        });

        client.on("peerJoined", (peer) => {
          if (joinController.signal.aborted) return;
          const wasAlreadyPresent = Boolean(get().peers[peer.user_id]);
          set((prev) => ({
            peers: { ...prev.peers, [peer.user_id]: peer },
          }));

          if (!wasAlreadyPresent && peer.user_id !== userId) {
            if (
              !get().deafened &&
              canFireSoundCooldown(peerJoinSoundCooldown, peer.user_id)
            ) {
              get().soundCallbacks?.onJoin?.();
            }
            if (
              !get().deafened &&
              canFireSoundCooldown(peerEntrySoundCooldown, peer.user_id)
            ) {
              const userVol = get().userVolumes[peer.user_id] ?? 100;
              void playFriendEntrySound(
                peer.user_id,
                get().transport,
                get().deafened,
                userVol,
              );
            }
          }
        });

        client.on("peerLeft", ({ user_id }) => {
          if (joinController.signal.aborted) return;
          // Never drop a peer whose LiveKit voice/video stream is still live (signaling-only blip)
          if (user_id !== userId && get().transport?.isParticipantPresent?.(user_id)) {
            set((prev) => {
              const existing = prev.peers[user_id];
              if (!existing) return prev;
              return {
                peers: {
                  ...prev.peers,
                  [user_id]: { ...existing, reconnecting: true },
                },
              };
            });
            return;
          }
          const wasPresent = Boolean(get().peers[user_id]);
          set((prev) => {
            const next = { ...prev.peers };
            delete next[user_id];
            return { peers: next };
          });
          if (wasPresent && user_id !== userId && !get().deafened) {
            if (canFireSoundCooldown(peerLeaveSoundCooldown, user_id)) {
              get().soundCallbacks?.onLeave?.();
            }
          }
        });

        client.on("peerReconnecting", ({ user_id }) => {
          set((prev) => {
            const existing = prev.peers[user_id];
            if (!existing) return prev;
            return {
              peers: {
                ...prev.peers,
                [user_id]: { ...existing, reconnecting: true },
              },
            };
          });
        });

        client.on("voiceStateUpdate", (update) => {
          set((prev) => {
            const existing = prev.peers[update.user_id];
            if (!existing) return prev;
            return {
              peers: {
                ...prev.peers,
                [update.user_id]: {
                  ...existing,
                  muted: update.muted,
                  deafened: update.deafened,
                  speaking: update.speaking,
                  noise_suppression: update.noise_suppression,
                },
              },
            };
          });
        });

        client.on("screenShareStarted", (share: ScreenShareStarted) => {
          set((prev) => {
            const existing = prev.peers[share.user_id];
            if (!existing) return prev;
            return {
              peers: {
                ...prev.peers,
                [share.user_id]: {
                  ...existing,
                  screen_sharing: share,
                },
              },
            };
          });
        });

        client.on("screenShareStopped", ({ user_id }) => {
          set((prev) => {
            const existing = prev.peers[user_id];
            if (!existing) return prev;
            return {
              peers: {
                ...prev.peers,
                [user_id]: {
                  ...existing,
                  screen_sharing: null,
                },
              },
            };
          });
        });

        client.on("gamePresenceUpdate", (update) => {
          usePresenceStore.getState().applyRemoteGamePresence(update);
          set((prev) => {
            const existing = prev.peers[update.user_id];
            if (!existing) return prev;
            return {
              peers: {
                ...prev.peers,
                [update.user_id]: {
                  ...existing,
                  game_presence:
                    update.game_id || update.game_name ? update : null,
                },
              },
            };
          });
        });

        client.on("error", (err) => {
          if (joinController.signal.aborted) return;
          // Suppress transient/recoverable signaling transport notices during auto-reconnect
          if (err.recoverable && get().connectionStatus === "reconnecting") {
            return;
          }
          if (!err.recoverable) {
            set({ error: `${err.code}: ${err.message}` });
          }
        });

        set({ signalingClient: client });
        client.connect();
      } finally {
        if (activeJoinController === joinController) {
          set({ isJoining: false });
          activeJoinPromise = null;
          inFlightTargetChannelId = null;
        }
      }
    };

    const promise = runJoin();
    activeJoinPromise = promise;
    return promise;
  },

  leaveVoiceChannel: async (options) => {
    const { signalingClient, activeVoiceChannelId, transport, sharingWindow } =
      get();
    const userId = useAuthStore.getState().user?.id;
    const wasInRoom = Boolean(activeVoiceChannelId);

    // Broadcast immediate leave via Supabase Realtime before awaiting network teardown
    if (userId && wasInRoom && !options?.skipPresenceClear) {
      await usePresenceStore
        .getState()
        .setLocalVoiceState(null, userId)
        .catch(() => {});
    }

    if (wasInRoom && !options?.silent) {
      get().soundCallbacks?.onLeave?.();
    }

    if (sharingWindow && transport) {
      await transport.stopWindowShare().catch(() => {});
    }

    if (signalingClient && activeVoiceChannelId && userId) {
      if (signalingClient.isOpen()) {
        signalingClient.leaveRoom({
          room_id: activeVoiceChannelId,
          user_id: userId,
        });
        // Give the WebSocket frame a short window to flush before closing the socket
        await new Promise((resolve) => setTimeout(resolve, 45));
      }
    }
    signalingClient?.disconnect();

    if (transport) {
      await transport.leaveVoiceRoom().catch(() => {});
    }

    set({
      signalingClient: null,
      connectionStatus: "disconnected",
      activeVoiceChannelId: null,
      activeVoiceChannelName: null,
      peers: {},
      speaking: false,
      sharingWindow: null,
      livekitUrl: null,
    });
  },

  toggleMute: async () => {
    const nextMuted = !get().muted;
    const nextSpeaking = nextMuted ? false : get().speaking;
    set({ muted: nextMuted, speaking: nextSpeaking });
    get().soundCallbacks?.onMuteToggle?.(nextMuted);
    await get().transport?.setVoiceControls({ muted: nextMuted });

    const { signalingClient, activeVoiceChannelId, deafened, rnnoiseEnabled, sharingWindow } =
      get();
    const auth = useAuthStore.getState();
    const userId = auth.user?.id;
    const displayName =
      auth.profile?.display_name || auth.profile?.username || "Cafofo User";
    if (activeVoiceChannelId && userId) {
      if (signalingClient?.isOpen()) {
        signalingClient.updateVoiceState({
          room_id: activeVoiceChannelId,
          user_id: userId,
          muted: nextMuted,
          deafened,
          speaking: nextSpeaking,
          noise_suppression: rnnoiseEnabled,
        });
      }
      void usePresenceStore.getState().setLocalVoiceState(
        {
          channel_id: activeVoiceChannelId,
          display_name: displayName,
          muted: nextMuted,
          deafened,
          speaking: nextSpeaking,
          is_streaming: Boolean(sharingWindow),
        },
        userId,
      );
    }
  },

  toggleDeafen: async () => {
    const nextDeafened = !get().deafened;
    const nextMuted = nextDeafened ? true : get().muted;
    const nextSpeaking = nextMuted ? false : get().speaking;
    set({ deafened: nextDeafened, muted: nextMuted, speaking: nextSpeaking });
    get().soundCallbacks?.onDeafenToggle?.(nextDeafened);
    await get().transport?.setVoiceControls({
      deafened: nextDeafened,
      muted: nextMuted,
    });

    const { signalingClient, activeVoiceChannelId, rnnoiseEnabled, sharingWindow } = get();
    const auth = useAuthStore.getState();
    const userId = auth.user?.id;
    const displayName =
      auth.profile?.display_name || auth.profile?.username || "Cafofo User";
    if (activeVoiceChannelId && userId) {
      if (signalingClient?.isOpen()) {
        signalingClient.updateVoiceState({
          room_id: activeVoiceChannelId,
          user_id: userId,
          muted: nextMuted,
          deafened: nextDeafened,
          speaking: nextSpeaking,
          noise_suppression: rnnoiseEnabled,
        });
      }
      void usePresenceStore.getState().setLocalVoiceState(
        {
          channel_id: activeVoiceChannelId,
          display_name: displayName,
          muted: nextMuted,
          deafened: nextDeafened,
          speaking: nextSpeaking,
          is_streaming: Boolean(sharingWindow),
        },
        userId,
      );
    }
  },

  toggleRnnoise: async () => {
    const next = !get().rnnoiseEnabled;
    set({ rnnoiseEnabled: next });
    persistVoiceAudioPrefs({
      userVolumes: get().userVolumes,
      screenVolumes: get().screenVolumes,
      selectedMicDeviceId: get().selectedMicDeviceId,
      selectedMicLabel: get().selectedMicLabel,
      rnnoiseEnabled: next,
    });
    await get().transport?.setVoiceControls({ rnnoiseEnabled: next });

    const { signalingClient, activeVoiceChannelId, muted, deafened, speaking } =
      get();
    const userId = useAuthStore.getState().user?.id;
    if (signalingClient?.isOpen() && activeVoiceChannelId && userId) {
      signalingClient.updateVoiceState({
        room_id: activeVoiceChannelId,
        user_id: userId,
        muted,
        deafened,
        speaking,
        noise_suppression: next,
      });
    }
  },

  setSelectedMicDeviceId: async (deviceId, label) => {
    const cleanId = deviceId && deviceId.trim().length > 0 ? deviceId : null;
    const cleanLabel =
      cleanId && label && label.trim().length > 0 ? label.trim() : null;
    set({
      selectedMicDeviceId: cleanId,
      selectedMicLabel: cleanLabel,
    });
    persistVoiceAudioPrefs({
      userVolumes: get().userVolumes,
      screenVolumes: get().screenVolumes,
      selectedMicDeviceId: cleanId,
      selectedMicLabel: cleanLabel,
      rnnoiseEnabled: get().rnnoiseEnabled,
    });

    if (get().activeVoiceChannelId) {
      await get()
        .transport?.setMicDevice?.({
          deviceId: cleanId,
          label: cleanLabel,
          rnnoiseEnabled: get().rnnoiseEnabled,
        })
        .catch(() => {});
    }
  },

  setPushToTalkKey: async (vkCode) => {
    set({ pttKey: vkCode });
    await get().transport?.setPushToTalkKey(vkCode);
  },

  startWindowShare: async ({ hwnd, pid, title, targetFps = 60, shareAudio = true }) => {
    const { transport, signalingClient, activeVoiceChannelId } = get();
    const auth = useAuthStore.getState();
    const userId = auth.user?.id;
    const displayName =
      auth.profile?.display_name || auth.profile?.username || "Cafofo User";
    if (!activeVoiceChannelId || !userId) {
      throw new Error("Entre em uma sala de voz para compartilhar uma janela.");
    }

    if (transport) {
      await transport.startWindowShare({ hwnd, pid, targetFps, shareAudio });
    }

    const streamId = `win-${hwnd}`;
    const sharePayload: ScreenShareStarted = {
      room_id: activeVoiceChannelId,
      user_id: userId,
      stream_id: streamId,
      source_title: title,
      width: 1920,
      height: 1080,
      fps: targetFps,
      has_audio: shareAudio,
    };

    set((prev) => {
      const selfPeer = prev.peers[userId];
      return {
        sharingWindow: { hwnd, pid, title },
        peers: selfPeer
          ? {
              ...prev.peers,
              [userId]: { ...selfPeer, screen_sharing: sharePayload },
            }
          : prev.peers,
      };
    });

    signalingClient?.notifyScreenShareStarted(sharePayload);

    const { muted, deafened, speaking } = get();
    void usePresenceStore.getState().setLocalVoiceState(
      {
        channel_id: activeVoiceChannelId,
        display_name: displayName,
        muted,
        deafened,
        speaking,
        is_streaming: true,
      },
      userId,
    );
  },

  stopWindowShare: async () => {
    const { transport, signalingClient, activeVoiceChannelId, sharingWindow } =
      get();
    const auth = useAuthStore.getState();
    const userId = auth.user?.id;
    const displayName =
      auth.profile?.display_name || auth.profile?.username || "Cafofo User";

    if (transport) {
      await transport.stopWindowShare();
    }

    if (sharingWindow && signalingClient && activeVoiceChannelId && userId) {
      signalingClient.notifyScreenShareStopped({
        room_id: activeVoiceChannelId,
        user_id: userId,
        stream_id: `win-${sharingWindow.hwnd}`,
      });
    }

    set((prev) => {
      const selfPeer = userId ? prev.peers[userId] : undefined;
      return {
        sharingWindow: null,
        peers:
          userId && selfPeer
            ? {
                ...prev.peers,
                [userId]: { ...selfPeer, screen_sharing: null },
              }
            : prev.peers,
      };
    });

    if (activeVoiceChannelId && userId) {
      const { muted, deafened, speaking } = get();
      void usePresenceStore.getState().setLocalVoiceState(
        {
          channel_id: activeVoiceChannelId,
          display_name: displayName,
          muted,
          deafened,
          speaking,
          is_streaming: false,
        },
        userId,
      );
    }
  },

  syncGamePresence: (presence) => {
    const { signalingClient, activeVoiceChannelId } = get();
    const userId = useAuthStore.getState().user?.id;
    if (!signalingClient || !activeVoiceChannelId || !userId) return;

    signalingClient.updateGamePresence({
      user_id: userId,
      game_id: presence?.game_id ?? null,
      game_name: presence?.game_name ?? null,
      process_name: presence?.process_name ?? null,
      started_at_ms: presence?.started_at_ms ?? null,
    });
  },

  setLocalSpeaking: (nextSpeaking) => {
    const {
      speaking,
      muted,
      deafened,
      rnnoiseEnabled,
      signalingClient,
      activeVoiceChannelId,
    } = get();
    const effectiveSpeaking = !muted && !deafened && nextSpeaking;
    if (effectiveSpeaking === speaking) return;

    set({ speaking: effectiveSpeaking });

    const userId = useAuthStore.getState().user?.id;
    if (!userId || !activeVoiceChannelId) return;

    if (signalingClient?.isOpen()) {
      signalingClient.updateVoiceState({
        room_id: activeVoiceChannelId,
        user_id: userId,
        muted,
        deafened,
        speaking: effectiveSpeaking,
        noise_suppression: rnnoiseEnabled,
      });
    }

    set((prev) => {
      const selfPeer = prev.peers[userId];
      if (!selfPeer) return prev;
      return {
        peers: {
          ...prev.peers,
          [userId]: { ...selfPeer, speaking: effectiveSpeaking },
        },
      };
    });

    usePresenceStore.getState().setLocalSpeakingState(effectiveSpeaking, userId);
  },

  setPeerSpeaking: (userId, isSpeaking) => {
    set((prev) => {
      const existing = prev.peers[userId];
      if (!existing || existing.speaking === isSpeaking) return prev;
      return {
        peers: {
          ...prev.peers,
          [userId]: { ...existing, speaking: isSpeaking },
        },
      };
    });
  },

  movePeerToRoom: ({ serverId, sourceRoomId, targetRoomId, targetUserId }) => {
    if (!sourceRoomId || !targetRoomId || sourceRoomId === targetRoomId) {
      return;
    }

    const activeClient = get().signalingClient;
    if (activeClient?.isOpen()) {
      activeClient.movePeerToRoom({
        server_id: serverId,
        source_room_id: sourceRoomId,
        target_room_id: targetRoomId,
        target_user_id: targetUserId,
      });
      return;
    }

    const accessToken = useAuthStore.getState().session?.access_token;
    if (!accessToken) {
      set({ error: "Faça login novamente para mover membros." });
      return;
    }

    const ephemeral = new SignalingClient({
      url: get().signalingUrl,
      accessToken,
      autoReconnect: false,
    });

    ephemeral.on("statusChange", (status) => {
      if (status === "connected") {
        ephemeral.movePeerToRoom({
          server_id: serverId,
          source_room_id: sourceRoomId,
          target_room_id: targetRoomId,
          target_user_id: targetUserId,
        });
        setTimeout(() => ephemeral.disconnect(), 300);
      }
    });

    ephemeral.on("error", (err) => {
      set({ error: `${err.code}: ${err.message}` });
      ephemeral.disconnect();
    });

    ephemeral.connect();
  },

  setUserVolume: (userId, volumePercent) => {
    const clamped = clampVolumePercent(volumePercent);
    set((prev) => {
      const userVolumes = { ...prev.userVolumes, [userId]: clamped };
      persistVoiceAudioPrefs({
        userVolumes,
        screenVolumes: prev.screenVolumes,
        selectedMicDeviceId: prev.selectedMicDeviceId,
        selectedMicLabel: prev.selectedMicLabel,
        rnnoiseEnabled: prev.rnnoiseEnabled,
      });
      prev.transport?.setPlaybackVolumes?.({
        deafened: prev.deafened,
        userVolumes,
        screenVolumes: prev.screenVolumes,
      });
      return { userVolumes };
    });
  },

  setScreenVolume: (streamId, volumePercent) => {
    const clamped = clampVolumePercent(volumePercent);
    set((prev) => {
      const screenVolumes = { ...prev.screenVolumes, [streamId]: clamped };
      persistVoiceAudioPrefs({
        userVolumes: prev.userVolumes,
        screenVolumes,
        selectedMicDeviceId: prev.selectedMicDeviceId,
        selectedMicLabel: prev.selectedMicLabel,
        rnnoiseEnabled: prev.rnnoiseEnabled,
      });
      prev.transport?.setPlaybackVolumes?.({
        deafened: prev.deafened,
        userVolumes: prev.userVolumes,
        screenVolumes,
      });
      return { screenVolumes };
    });
  },
}));

onVoicePresenceUpdate(
  ({ serverId, userId, previousChannelId, currentChannelId, voiceState }) => {
    const selfId = useAuthStore.getState().user?.id;
    if (!userId || userId === selfId) return;

    const voiceStore = useVoiceStore.getState();
    const activeVoiceId = voiceStore.activeVoiceChannelId;
    if (!activeVoiceId) return;

    if (currentChannelId === activeVoiceId) {
      const wasPresent = Boolean(voiceStore.peers[userId]);
      const members = useServerStore.getState().membersByServer[serverId] ?? [];
      const member = members.find((m) => m.user_id === userId);
      const displayName =
        voiceState?.display_name ||
        member?.nickname ||
        member?.profile?.display_name ||
        member?.profile?.username ||
        userId.slice(0, 8);

      useVoiceStore.setState((prev) => {
        const existing = prev.peers[userId];
        const nextScreenSharing: ScreenShareStarted | null =
          voiceState?.is_streaming
            ? (existing?.screen_sharing ?? {
                room_id: activeVoiceId,
                user_id: userId,
                stream_id: `presence-${userId}`,
                source_title: "Transmissão ao vivo",
                width: 1920,
                height: 1080,
                fps: 60,
                has_audio: true,
              })
            : null;
        return {
          peers: {
            ...prev.peers,
            [userId]: {
              user_id: userId,
              display_name: existing?.display_name || displayName,
              muted: voiceState?.muted ?? existing?.muted ?? false,
              deafened: voiceState?.deafened ?? existing?.deafened ?? false,
              speaking: voiceState?.speaking ?? existing?.speaking ?? false,
              noise_suppression: existing?.noise_suppression ?? true,
              reconnecting: false,
              game_presence:
                existing?.game_presence ??
                usePresenceStore.getState().gameByUser[userId] ??
                null,
              screen_sharing: nextScreenSharing,
            },
          },
        };
      });

      if (!wasPresent && previousChannelId !== activeVoiceId) {
        if (
          !voiceStore.deafened &&
          canFireSoundCooldown(peerJoinSoundCooldown, userId)
        ) {
          voiceStore.soundCallbacks?.onJoin?.();
        }
        if (
          !voiceStore.deafened &&
          canFireSoundCooldown(peerEntrySoundCooldown, userId)
        ) {
          const userVol = voiceStore.userVolumes[userId] ?? 100;
          void playFriendEntrySound(
            userId,
            voiceStore.transport,
            voiceStore.deafened,
            userVol,
          );
        }
      }
    } else if (
      previousChannelId === activeVoiceId &&
      currentChannelId !== activeVoiceId
    ) {
      // Never evict a peer from the stage if LiveKit still has their live voice/video connected
      if (voiceStore.transport?.isParticipantPresent?.(userId)) {
        return;
      }
      const wasPresent = Boolean(voiceStore.peers[userId]);
      useVoiceStore.setState((prev) => {
        if (!prev.peers[userId]) return prev;
        const next = { ...prev.peers };
        delete next[userId];
        return { peers: next };
      });
      if (
        wasPresent &&
        !voiceStore.deafened &&
        canFireSoundCooldown(peerLeaveSoundCooldown, userId)
      ) {
        voiceStore.soundCallbacks?.onLeave?.();
      }
    }
  },
);
