import type { RealtimeChannel } from "@supabase/supabase-js";
import { create } from "zustand";
import type { GamePresenceUpdate } from "../generated";
import type {
  GameCatalogRow,
  PresenceStatus,
  ProfileRow,
  ServerRow,
} from "../supabase/types";
import {
  getSupabaseClientOrThrow,
  loadPreferredPresenceStatus,
  onLocalProfileUpdated,
  useAuthStore,
} from "./useAuthStore";

export interface MemberVoiceRealtimeState {
  channel_id: string | null;
  display_name?: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  is_streaming: boolean;
}

export interface MemberRealtimePresence {
  user_id: string;
  status: PresenceStatus;
  game_presence: GamePresenceUpdate | null;
  voice_state?: MemberVoiceRealtimeState | null;
  updated_at: number;
  sender_session?: string;
  sender_seq?: number;
}

export interface VoicePresenceTransitionEvent {
  serverId: string;
  userId: string;
  previousChannelId: string | null;
  currentChannelId: string | null;
  voiceState: MemberVoiceRealtimeState | null;
}

export interface VoicePresenceUpdateEvent extends VoicePresenceTransitionEvent {
  previousVoiceState: MemberVoiceRealtimeState | null;
}

type VoiceTransitionListener = (event: VoicePresenceTransitionEvent) => void;
type VoiceUpdateListener = (event: VoicePresenceUpdateEvent) => void;
type ServerRealtimeInvalidator = (
  serverId: string,
  kind: "members" | "roles" | "channels",
) => void;
type ProfileRealtimeListener = (profile: ProfileRow) => void;
type ServerRowRealtimeListener = (server: ServerRow) => void;

const voiceTransitionListeners = new Set<VoiceTransitionListener>();
const voiceUpdateListeners = new Set<VoiceUpdateListener>();
const serverRealtimeInvalidators = new Set<ServerRealtimeInvalidator>();
const profileRealtimeListeners = new Set<ProfileRealtimeListener>();
const serverRowRealtimeListeners = new Set<ServerRowRealtimeListener>();

// Supabase Realtime limits each client to 5 Presence track() calls per 30s window.
// Throttling track() to >= 8s guarantees <= 4 track() calls per 30s,
// while WebSocket Broadcast (`voice_state_sync`) delivers every change in < 50ms.
const MIN_PRESENCE_TRACK_INTERVAL_MS = 8_000;
const BROADCAST_FRESHNESS_WINDOW_MS = 12_000;
const SPEAKING_BROADCAST_MIN_INTERVAL_MS = 250;

const LOCAL_SESSION_ID = `${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
let localSenderSeq = 0;

function nextSenderSeq(): number {
  localSenderSeq += 1;
  return localSenderSeq;
}

export function onVoicePresenceTransition(
  listener: VoiceTransitionListener,
): () => void {
  voiceTransitionListeners.add(listener);
  return () => {
    voiceTransitionListeners.delete(listener);
  };
}

export function onVoicePresenceUpdate(
  listener: VoiceUpdateListener,
): () => void {
  voiceUpdateListeners.add(listener);
  return () => {
    voiceUpdateListeners.delete(listener);
  };
}

export function onServerRealtimeInvalidate(
  listener: ServerRealtimeInvalidator,
): () => void {
  serverRealtimeInvalidators.add(listener);
  return () => {
    serverRealtimeInvalidators.delete(listener);
  };
}

export function onProfileRealtimeUpdate(
  listener: ProfileRealtimeListener,
): () => void {
  profileRealtimeListeners.add(listener);
  return () => {
    profileRealtimeListeners.delete(listener);
  };
}

export function onServerRowRealtimeUpdate(
  listener: ServerRowRealtimeListener,
): () => void {
  serverRowRealtimeListeners.add(listener);
  return () => {
    serverRowRealtimeListeners.delete(listener);
  };
}

function voiceStateChanged(
  a: MemberVoiceRealtimeState | null,
  b: MemberVoiceRealtimeState | null,
): boolean {
  if (!a && !b) return false;
  if (!a || !b) return true;
  return (
    a.channel_id !== b.channel_id ||
    a.muted !== b.muted ||
    a.deafened !== b.deafened ||
    a.speaking !== b.speaking ||
    a.is_streaming !== b.is_streaming
  );
}

function emitVoiceChanges(
  serverId: string,
  prevMap: Record<string, MemberRealtimePresence>,
  nextMap: Record<string, MemberRealtimePresence>,
): void {
  const allUserIds = new Set([
    ...Object.keys(prevMap),
    ...Object.keys(nextMap),
  ]);
  for (const uid of allUserIds) {
    const prevVoice = prevMap[uid]?.voice_state ?? null;
    const nextVoice = nextMap[uid]?.voice_state ?? null;
    const prevChannelId = prevVoice?.channel_id ?? null;
    const nextChannelId = nextVoice?.channel_id ?? null;

    if (prevChannelId !== nextChannelId) {
      const transitionEvent: VoicePresenceTransitionEvent = {
        serverId,
        userId: uid,
        previousChannelId: prevChannelId,
        currentChannelId: nextChannelId,
        voiceState: nextVoice,
      };
      for (const listener of voiceTransitionListeners) {
        try {
          listener(transitionEvent);
        } catch {
          // ignore listener errors
        }
      }
    }

    if (voiceStateChanged(prevVoice, nextVoice)) {
      const updateEvent: VoicePresenceUpdateEvent = {
        serverId,
        userId: uid,
        previousChannelId: prevChannelId,
        currentChannelId: nextChannelId,
        previousVoiceState: prevVoice,
        voiceState: nextVoice,
      };
      for (const listener of voiceUpdateListeners) {
        try {
          listener(updateEvent);
        } catch {
          // ignore listener errors
        }
      }
    }
  }
}

interface PresenceState {
  gameCatalog: GameCatalogRow[];
  currentGame: GamePresenceUpdate | null;
  localStatus: PresenceStatus;
  localVoiceState: MemberVoiceRealtimeState | null;
  onlineByServer: Record<string, Record<string, MemberRealtimePresence>>;
  gameByUser: Record<string, GamePresenceUpdate | null>;
  activePresenceChannel: RealtimeChannel | null;
  activeDbChannel: RealtimeChannel | null;
  activePresenceServerId: string | null;
  isPresenceSubscribed: boolean;

  loadGameCatalog: () => Promise<GameCatalogRow[]>;
  bindServerPresence: (
    serverId: string,
    userId: string,
    status?: PresenceStatus,
  ) => Promise<void>;
  unbindServerPresence: () => Promise<void>;
  notifyLeaving: () => void;
  setLocalStatus: (
    status: PresenceStatus,
    userId?: string,
  ) => Promise<void>;
  setLocalGamePresence: (
    presence: GamePresenceUpdate | null,
    userId?: string,
  ) => Promise<void>;
  setLocalVoiceState: (
    voiceState: MemberVoiceRealtimeState | null,
    userId?: string,
  ) => Promise<void>;
  setLocalSpeakingState: (speaking: boolean, userId?: string) => void;
  applyRemoteGamePresence: (update: GamePresenceUpdate) => void;
}

interface ReceiverBroadcastMeta {
  receivedAtLocalMs: number;
  senderSession: string | null;
  senderSeq: number;
}

let presenceRetryTimer: ReturnType<typeof setTimeout> | null = null;
const lastBroadcastMetaByKey = new Map<string, ReceiverBroadcastMeta>();

// Strict rate-limited Presence track scheduler (<= 1 track per 8s => never hits 5/30s limit)
let lastTrackSentAt = 0;
let lastTrackedSignature: string | null = null;
let trackThrottleTimer: ReturnType<typeof setTimeout> | null = null;
let trackInFlight = false;
let pendingTrackEntry: {
  channel: RealtimeChannel;
  payload: MemberRealtimePresence;
  signature: string;
} | null = null;

let lastSpeakingBroadcastAt = 0;
let bindingPresenceServerId: string | null = null;

function isChannelJoined(
  channel: RealtimeChannel | null,
): channel is RealtimeChannel {
  return Boolean(channel && channel.state === "joined");
}

function isChannelActive(channel: RealtimeChannel | null): boolean {
  return Boolean(
    channel && (channel.state === "joined" || channel.state === "joining"),
  );
}

async function sendBroadcastIfJoined(
  channel: RealtimeChannel | null,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!isChannelJoined(channel)) return;
  try {
    await channel.send({
      type: "broadcast",
      event,
      payload,
    });
  } catch {
    // ignore transient send errors
  }
}

function buildTrackSignature(payload: MemberRealtimePresence): string {
  return JSON.stringify({
    u: payload.user_id,
    s: payload.status,
    g: payload.game_presence
      ? {
          id: payload.game_presence.game_id,
          name: payload.game_presence.game_name,
          started: payload.game_presence.started_at_ms,
        }
      : null,
    v: payload.voice_state
      ? {
          c: payload.voice_state.channel_id,
          m: payload.voice_state.muted,
          d: payload.voice_state.deafened,
          st: payload.voice_state.is_streaming,
          n: payload.voice_state.display_name ?? null,
        }
      : null,
  });
}

function resetTrackScheduler(): void {
  if (trackThrottleTimer) {
    clearTimeout(trackThrottleTimer);
    trackThrottleTimer = null;
  }
  pendingTrackEntry = null;
  lastTrackedSignature = null;
}

function flushScheduledTrack(): void {
  if (trackInFlight || !pendingTrackEntry) return;
  const entry = pendingTrackEntry;

  if (!isChannelJoined(entry.channel)) {
    pendingTrackEntry = null;
    return;
  }

  if (entry.signature === lastTrackedSignature) {
    pendingTrackEntry = null;
    return;
  }

  const elapsed = Date.now() - lastTrackSentAt;
  if (elapsed < MIN_PRESENCE_TRACK_INTERVAL_MS) {
    if (!trackThrottleTimer) {
      trackThrottleTimer = setTimeout(() => {
        trackThrottleTimer = null;
        flushScheduledTrack();
      }, MIN_PRESENCE_TRACK_INTERVAL_MS - elapsed + 50);
    }
    return;
  }

  pendingTrackEntry = null;
  trackInFlight = true;
  lastTrackSentAt = Date.now();
  lastTrackedSignature = entry.signature;

  void entry.channel
    .track(entry.payload)
    .catch(() => {
      if (lastTrackedSignature === entry.signature) {
        lastTrackedSignature = null;
      }
    })
    .finally(() => {
      trackInFlight = false;
      if (pendingTrackEntry) {
        flushScheduledTrack();
      }
    });
}

function schedulePresenceTrack(
  channel: RealtimeChannel | null,
  payload: MemberRealtimePresence,
  immediateIfAllowed = false,
): void {
  if (!isChannelJoined(channel)) return;
  const signature = buildTrackSignature(payload);
  if (signature === lastTrackedSignature && !pendingTrackEntry) return;

  pendingTrackEntry = { channel, payload, signature };
  if (immediateIfAllowed) {
    flushScheduledTrack();
    return;
  }

  const elapsed = Date.now() - lastTrackSentAt;
  if (elapsed >= MIN_PRESENCE_TRACK_INTERVAL_MS && !trackInFlight) {
    flushScheduledTrack();
  } else if (!trackThrottleTimer) {
    const waitMs = Math.max(200, MIN_PRESENCE_TRACK_INTERVAL_MS - elapsed + 50);
    trackThrottleTimer = setTimeout(() => {
      trackThrottleTimer = null;
      flushScheduledTrack();
    }, waitMs);
  }
}

function clearPresenceRetryTimer(): void {
  if (presenceRetryTimer) {
    clearTimeout(presenceRetryTimer);
    presenceRetryTimer = null;
  }
}

function makeMetaKey(serverId: string, userId: string): string {
  return `${serverId}:${userId}`;
}

function normalizeValidStatus(status?: PresenceStatus | null): PresenceStatus {
  if (
    status === "online" ||
    status === "idle" ||
    status === "dnd" ||
    status === "offline"
  ) {
    return status;
  }
  return "online";
}

function sanitizeVoiceForTrack(
  voice: MemberVoiceRealtimeState | null,
): MemberVoiceRealtimeState | null {
  if (!voice || !voice.channel_id) return null;
  return {
    ...voice,
    speaking: false,
  };
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  gameCatalog: [],
  currentGame: null,
  localStatus: loadPreferredPresenceStatus() ?? "online",
  localVoiceState: null,
  onlineByServer: {},
  gameByUser: {},
  activePresenceChannel: null,
  activeDbChannel: null,
  activePresenceServerId: null,
  isPresenceSubscribed: false,

  loadGameCatalog: async () => {
    const supabase = getSupabaseClientOrThrow();
    const { data, error } = await supabase
      .from("game_catalog")
      .select("*")
      .order("name", { ascending: true });

    if (error) {
      throw new Error(`Erro ao carregar catálogo de jogos: ${error.message}`);
    }

    const catalog = data ?? [];
    set({ gameCatalog: catalog });
    return catalog;
  },

  bindServerPresence: async (serverId, userId, status) => {
    clearPresenceRetryTimer();
    const resolvedStatus = normalizeValidStatus(
      status ??
        loadPreferredPresenceStatus() ??
        useAuthStore.getState().profile?.status ??
        get().localStatus,
    );

    const current = get().activePresenceChannel;
    if (
      current &&
      get().activePresenceServerId === serverId &&
      isChannelActive(current)
    ) {
      if (get().localStatus !== resolvedStatus) {
        await get().setLocalStatus(resolvedStatus, userId);
      }
      return;
    }

    if (bindingPresenceServerId === serverId) {
      return;
    }
    bindingPresenceServerId = serverId;

    try {
      if (current || get().activeDbChannel) {
        await get().unbindServerPresence();
      }

      set({ localStatus: resolvedStatus });

      const supabase = getSupabaseClientOrThrow();
      const accessToken = useAuthStore.getState().session?.access_token;
      if (accessToken) {
        await supabase.realtime.setAuth(accessToken).catch(() => {});
      }

      if (bindingPresenceServerId !== serverId) {
        return;
      }

      const buildCurrentSelfPayload = (): MemberRealtimePresence => ({
        user_id: userId,
        status: get().localStatus,
        game_presence: get().currentGame,
        voice_state: sanitizeVoiceForTrack(get().localVoiceState),
        updated_at: Date.now(),
        sender_session: LOCAL_SESSION_ID,
        sender_seq: nextSenderSeq(),
      });

      const channel = supabase.channel(`cafofo-voice-presence:${serverId}`, {
        config: {
          presence: { key: userId },
          broadcast: { self: false, ack: false },
        },
      });

      const syncState = () => {
        if (get().activePresenceChannel !== channel) return;
        const state = channel.presenceState<MemberRealtimePresence>();
        const prevMap = get().onlineByServer[serverId] ?? {};
        const nextMap: Record<string, MemberRealtimePresence> = {};
        const gamePatches: Record<string, GamePresenceUpdate | null> = {};
        const localNow = Date.now();

        for (const [key, entries] of Object.entries(state)) {
          if (!entries || entries.length === 0) continue;
          const sorted = [...entries].sort((a, b) => {
            if (
              a.sender_session &&
              a.sender_session === b.sender_session &&
              typeof a.sender_seq === "number" &&
              typeof b.sender_seq === "number"
            ) {
              return b.sender_seq - a.sender_seq;
            }
            return (b.updated_at ?? 0) - (a.updated_at ?? 0);
          });
          const latest = sorted[0];
          if (!latest) continue;

          const uid = latest.user_id || key;
          if (uid === userId) continue;

          const prevEntry = prevMap[uid];
          const metaKey = makeMetaKey(serverId, uid);
          const broadcastMeta = lastBroadcastMetaByKey.get(metaKey);

          // Compare strictly using the RECEIVER's own local clock and sender_seq
          // (never compare sender's Date.now() against receiver's Date.now()!).
          const presenceHasNewerSeq =
            Boolean(broadcastMeta?.senderSession) &&
            latest.sender_session === broadcastMeta?.senderSession &&
            typeof latest.sender_seq === "number" &&
            latest.sender_seq >= (broadcastMeta?.senderSeq ?? 0);

          const keepFresherBroadcast =
            Boolean(prevEntry) &&
            Boolean(broadcastMeta) &&
            !presenceHasNewerSeq &&
            localNow - (broadcastMeta?.receivedAtLocalMs ?? 0) <
              BROADCAST_FRESHNESS_WINDOW_MS;

          const rawVoice = keepFresherBroadcast
            ? (prevEntry?.voice_state ?? null)
            : (latest.voice_state ?? null);

          const effectiveVoice: MemberVoiceRealtimeState | null =
            rawVoice && rawVoice.channel_id
              ? {
                  ...rawVoice,
                  speaking:
                    prevEntry?.voice_state?.channel_id === rawVoice.channel_id
                      ? Boolean(prevEntry.voice_state.speaking)
                      : Boolean(rawVoice.speaking),
                }
              : null;

          const effectiveStatus = keepFresherBroadcast
            ? normalizeValidStatus(prevEntry?.status)
            : normalizeValidStatus(latest.status);

          const effectiveGame = keepFresherBroadcast
            ? (prevEntry?.game_presence ?? null)
            : (latest.game_presence ?? null);

          nextMap[uid] = {
            user_id: uid,
            status: effectiveStatus,
            game_presence: effectiveGame,
            voice_state: effectiveVoice,
            updated_at: localNow,
            sender_session: latest.sender_session,
            sender_seq: latest.sender_seq,
          };
          gamePatches[uid] = effectiveGame;
        }

        // Keep any peer who sent a fresh Broadcast very recently while their initial
        // Presence track() is still propagating, UNLESS they explicitly left.
        for (const [uid, prevEntry] of Object.entries(prevMap)) {
          if (uid === userId || nextMap[uid]) continue;
          const meta = lastBroadcastMetaByKey.get(makeMetaKey(serverId, uid));
          if (meta && localNow - meta.receivedAtLocalMs < 1500) {
            nextMap[uid] = prevEntry;
          } else {
            lastBroadcastMetaByKey.delete(makeMetaKey(serverId, uid));
          }
        }

        nextMap[userId] = {
          user_id: userId,
          status: get().localStatus,
          game_presence: get().currentGame,
          voice_state: get().localVoiceState,
          updated_at: localNow,
        };

        set((prev) => ({
          onlineByServer: {
            ...prev.onlineByServer,
            [serverId]: nextMap,
          },
          gameByUser: {
            ...prev.gameByUser,
            ...gamePatches,
          },
        }));
        emitVoiceChanges(serverId, prevMap, nextMap);
      };

      channel
        .on("presence", { event: "sync" }, syncState)
        .on("presence", { event: "join" }, syncState)
        .on("presence", { event: "leave" }, syncState)
        .on("broadcast", { event: "presence_sync_request" }, ({ payload }) => {
          if (get().activePresenceChannel !== channel) return;
          const requesterId = (payload as { requester_id?: string } | null)
            ?.requester_id;
          if (requesterId === userId) return;
          const jitterMs = Math.floor(Math.random() * 140);
          setTimeout(() => {
            if (get().activePresenceChannel !== channel) return;
            void sendBroadcastIfJoined(
              channel,
              "voice_state_sync",
              buildCurrentSelfPayload() as unknown as Record<string, unknown>,
            );
          }, jitterMs);
        })
        .on("broadcast", { event: "presence_leaving" }, ({ payload }) => {
          if (get().activePresenceChannel !== channel) return;
          const targetUid = (payload as { user_id?: string } | null)?.user_id;
          if (!targetUid || targetUid === userId) return;

          lastBroadcastMetaByKey.delete(makeMetaKey(serverId, targetUid));

          const prevMap = get().onlineByServer[serverId] ?? {};
          if (!prevMap[targetUid]) return;
          const nextMap = { ...prevMap };
          delete nextMap[targetUid];

          set((prev) => ({
            onlineByServer: {
              ...prev.onlineByServer,
              [serverId]: nextMap,
            },
          }));
          emitVoiceChanges(serverId, prevMap, nextMap);
        })
        .on("broadcast", { event: "voice_state_sync" }, ({ payload }) => {
          if (get().activePresenceChannel !== channel) return;
          if (!payload || typeof payload !== "object") return;
          const data = payload as Partial<MemberRealtimePresence>;
          const targetUid = data.user_id;
          if (!targetUid || targetUid === userId) return;

          const metaKey = makeMetaKey(serverId, targetUid);
          const prevMeta = lastBroadcastMetaByKey.get(metaKey);
          const incomingSession =
            typeof data.sender_session === "string"
              ? data.sender_session
              : null;
          const incomingSeq =
            typeof data.sender_seq === "number" ? data.sender_seq : 0;

          // Only drop strictly out-of-order packets from the exact same sender session
          if (
            prevMeta &&
            incomingSession &&
            prevMeta.senderSession === incomingSession &&
            incomingSeq > 0 &&
            incomingSeq < prevMeta.senderSeq
          ) {
            return;
          }

          const localNow = Date.now();
          lastBroadcastMetaByKey.set(metaKey, {
            receivedAtLocalMs: localNow,
            senderSession: incomingSession,
            senderSeq: incomingSeq,
          });

          const prevMap = get().onlineByServer[serverId] ?? {};
          const existing = prevMap[targetUid];

          const rawVoice =
            data.voice_state !== undefined
              ? data.voice_state
              : (existing?.voice_state ?? null);
          const nextVoice: MemberVoiceRealtimeState | null =
            rawVoice && rawVoice.channel_id
              ? {
                  ...rawVoice,
                  speaking:
                    existing?.voice_state?.channel_id === rawVoice.channel_id
                      ? Boolean(
                          rawVoice.speaking || existing.voice_state.speaking,
                        )
                      : Boolean(rawVoice.speaking),
                }
              : null;

          const nextEntry: MemberRealtimePresence = {
            user_id: targetUid,
            status:
              data.status !== undefined
                ? normalizeValidStatus(data.status)
                : (existing?.status ?? "online"),
            game_presence:
              data.game_presence !== undefined
                ? data.game_presence
                : (existing?.game_presence ?? null),
            voice_state: nextVoice,
            updated_at: localNow,
            sender_session: incomingSession ?? undefined,
            sender_seq: incomingSeq || undefined,
          };

          const nextMap = {
            ...prevMap,
            [targetUid]: nextEntry,
          };

          set((prev) => ({
            onlineByServer: {
              ...prev.onlineByServer,
              [serverId]: nextMap,
            },
            gameByUser:
              data.game_presence !== undefined
                ? { ...prev.gameByUser, [targetUid]: data.game_presence }
                : prev.gameByUser,
          }));
          emitVoiceChanges(serverId, prevMap, nextMap);
        })
        .on("broadcast", { event: "profile_updated" }, ({ payload }) => {
          if (get().activePresenceChannel !== channel) return;
          const updated = (payload as { profile?: ProfileRow } | null)?.profile;
          if (!updated?.id) return;
          for (const listener of profileRealtimeListeners) {
            try {
              listener(updated);
            } catch {
              // ignore listener errors
            }
          }
        })
        .on("broadcast", { event: "voice_speaking_sync" }, ({ payload }) => {
          if (get().activePresenceChannel !== channel) return;
          if (!payload || typeof payload !== "object") return;
          const data = payload as {
            user_id?: string;
            channel_id?: string | null;
            speaking?: boolean;
          };
          const targetUid = data.user_id;
          if (!targetUid || targetUid === userId) return;

          const prevMap = get().onlineByServer[serverId] ?? {};
          const existing = prevMap[targetUid];
          if (
            !existing?.voice_state ||
            !data.channel_id ||
            existing.voice_state.channel_id !== data.channel_id
          ) {
            return;
          }
          const nextSpeaking = Boolean(data.speaking);
          if (existing.voice_state.speaking === nextSpeaking) return;

          const nextMap: Record<string, MemberRealtimePresence> = {
            ...prevMap,
            [targetUid]: {
              ...existing,
              voice_state: {
                ...existing.voice_state,
                speaking: nextSpeaking,
              },
            },
          };

          set((prev) => ({
            onlineByServer: {
              ...prev.onlineByServer,
              [serverId]: nextMap,
            },
          }));
          emitVoiceChanges(serverId, prevMap, nextMap);
        });

      // Separate channel strictly for Postgres table changes (members / roles / channels / profiles)
      const dbChannel = supabase
        .channel(`cafofo-server-db:${serverId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "server_members",
            filter: `server_id=eq.${serverId}`,
          },
          () => {
            for (const inv of serverRealtimeInvalidators) {
              inv(serverId, "members");
            }
          },
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "server_roles",
            filter: `server_id=eq.${serverId}`,
          },
          () => {
            for (const inv of serverRealtimeInvalidators) {
              inv(serverId, "roles");
            }
          },
        )
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "channels",
            filter: `server_id=eq.${serverId}`,
          },
          () => {
            for (const inv of serverRealtimeInvalidators) {
              inv(serverId, "channels");
            }
          },
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "servers",
            filter: `id=eq.${serverId}`,
          },
          (payload) => {
            const updatedServer = payload.new as ServerRow | null;
            if (!updatedServer?.id) return;
            for (const listener of serverRowRealtimeListeners) {
              try {
                listener(updatedServer);
              } catch {
                // ignore listener errors
              }
            }
          },
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "profiles",
          },
          (payload) => {
            const updated = payload.new as ProfileRow | null;
            if (!updated?.id) return;
            for (const listener of profileRealtimeListeners) {
              try {
                listener(updated);
              } catch {
                // ignore listener errors
              }
            }
            // If this user is currently tracked online in this server, keep status in sync too
            if (updated.id !== userId && updated.status) {
              const prevMap = get().onlineByServer[serverId] ?? {};
              const existing = prevMap[updated.id];
              if (existing && existing.status !== updated.status) {
                const nextStatus = normalizeValidStatus(updated.status);
                set((prev) => ({
                  onlineByServer: {
                    ...prev.onlineByServer,
                    [serverId]: {
                      ...prevMap,
                      [updated.id]: {
                        ...existing,
                        status: nextStatus,
                        updated_at: Date.now(),
                      },
                    },
                  },
                }));
              }
            }
          },
        );

      dbChannel.subscribe();

      const scheduleReconnect = () => {
        if (get().activePresenceChannel !== channel) return;
        set({ isPresenceSubscribed: false });
        resetTrackScheduler();
        clearPresenceRetryTimer();
        presenceRetryTimer = setTimeout(() => {
          if (get().activePresenceServerId === serverId) {
            void get().bindServerPresence(serverId, userId, get().localStatus);
          }
        }, 2500);
      };

      channel.subscribe((subStatus) => {
        if (get().activePresenceChannel !== channel) return;

        if (subStatus === "SUBSCRIBED") {
          set({ isPresenceSubscribed: true });
          syncState();
          const payload = buildCurrentSelfPayload();
          void sendBroadcastIfJoined(
            channel,
            "voice_state_sync",
            payload as unknown as Record<string, unknown>,
          );
          void sendBroadcastIfJoined(channel, "presence_sync_request", {
            requester_id: userId,
          });
          schedulePresenceTrack(channel, payload, true);
        } else if (
          subStatus === "CHANNEL_ERROR" ||
          subStatus === "TIMED_OUT" ||
          subStatus === "CLOSED"
        ) {
          scheduleReconnect();
        }
      });

      set({
        activePresenceChannel: channel,
        activeDbChannel: dbChannel,
        activePresenceServerId: serverId,
        isPresenceSubscribed: false,
      });
    } finally {
      if (bindingPresenceServerId === serverId) {
        bindingPresenceServerId = null;
      }
    }
  },

  notifyLeaving: () => {
    const channel = get().activePresenceChannel;
    const userId = useAuthStore.getState().user?.id;
    if (channel && userId && isChannelJoined(channel)) {
      void sendBroadcastIfJoined(channel, "presence_leaving", {
        user_id: userId,
      });
      void channel.untrack().catch(() => {});
    }
  },

  unbindServerPresence: async () => {
    clearPresenceRetryTimer();
    resetTrackScheduler();

    const channel = get().activePresenceChannel;
    const dbChannel = get().activeDbChannel;
    const userId = useAuthStore.getState().user?.id;

    // Clear active pointers FIRST so the CLOSED callback never schedules a reconnect
    set({
      activePresenceChannel: null,
      activeDbChannel: null,
      activePresenceServerId: null,
      isPresenceSubscribed: false,
      localVoiceState: null,
    });

    const supabase = getSupabaseClientOrThrow();
    if (channel) {
      if (userId && isChannelJoined(channel)) {
        // Await broadcast & untrack + brief flush BEFORE removing channel so peers see offline immediately
        await sendBroadcastIfJoined(channel, "presence_leaving", {
          user_id: userId,
        });
        await channel.untrack().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      await supabase.removeChannel(channel).catch(() => {});
    }
    if (dbChannel) {
      await supabase.removeChannel(dbChannel).catch(() => {});
    }
  },

  setLocalStatus: async (status, userId) => {
    const resolvedUserId = userId ?? useAuthStore.getState().user?.id;
    const normalized = normalizeValidStatus(status);
    set({ localStatus: normalized });

    const serverId = get().activePresenceServerId;
    const now = Date.now();
    if (serverId && resolvedUserId) {
      set((prev) => {
        const currentMap = prev.onlineByServer[serverId] ?? {};
        const existing = currentMap[resolvedUserId];
        return {
          onlineByServer: {
            ...prev.onlineByServer,
            [serverId]: {
              ...currentMap,
              [resolvedUserId]: {
                user_id: resolvedUserId,
                status: normalized,
                game_presence: existing?.game_presence ?? prev.currentGame,
                voice_state: prev.localVoiceState,
                updated_at: now,
              },
            },
          },
        };
      });
    }

    const channel = get().activePresenceChannel;
    if (channel && resolvedUserId && isChannelJoined(channel)) {
      const payload: MemberRealtimePresence = {
        user_id: resolvedUserId,
        status: normalized,
        game_presence: get().currentGame,
        voice_state: sanitizeVoiceForTrack(get().localVoiceState),
        updated_at: now,
        sender_session: LOCAL_SESSION_ID,
        sender_seq: nextSenderSeq(),
      };
      await sendBroadcastIfJoined(
        channel,
        "voice_state_sync",
        payload as unknown as Record<string, unknown>,
      );
      schedulePresenceTrack(channel, payload);
    }
  },

  setLocalGamePresence: async (presence, userId) => {
    const resolvedUserId =
      userId ?? useAuthStore.getState().user?.id ?? presence?.user_id;
    const normalized: GamePresenceUpdate | null =
      presence && (presence.game_id || presence.game_name)
        ? {
            ...presence,
            user_id: resolvedUserId ?? presence.user_id,
          }
        : null;

    const serverId = get().activePresenceServerId;
    const now = Date.now();
    set((prev) => {
      const nextOnline = { ...prev.onlineByServer };
      if (serverId && resolvedUserId) {
        const currentMap = nextOnline[serverId] ?? {};
        nextOnline[serverId] = {
          ...currentMap,
          [resolvedUserId]: {
            user_id: resolvedUserId,
            status: prev.localStatus,
            game_presence: normalized,
            voice_state: prev.localVoiceState,
            updated_at: now,
          },
        };
      }
      return {
        currentGame: normalized,
        onlineByServer: nextOnline,
        gameByUser: resolvedUserId
          ? { ...prev.gameByUser, [resolvedUserId]: normalized }
          : prev.gameByUser,
      };
    });

    const channel = get().activePresenceChannel;
    if (channel && resolvedUserId && isChannelJoined(channel)) {
      const payload: MemberRealtimePresence = {
        user_id: resolvedUserId,
        status: get().localStatus,
        game_presence: normalized,
        voice_state: sanitizeVoiceForTrack(get().localVoiceState),
        updated_at: now,
        sender_session: LOCAL_SESSION_ID,
        sender_seq: nextSenderSeq(),
      };
      await sendBroadcastIfJoined(
        channel,
        "voice_state_sync",
        payload as unknown as Record<string, unknown>,
      );
      schedulePresenceTrack(channel, payload);
    }
  },

  setLocalVoiceState: async (voiceState, userId) => {
    const resolvedUserId = userId ?? useAuthStore.getState().user?.id;
    const normalizedVoice =
      voiceState && voiceState.channel_id ? { ...voiceState } : null;
    set({ localVoiceState: normalizedVoice });

    const serverId = get().activePresenceServerId;
    const now = Date.now();
    if (serverId && resolvedUserId) {
      const prevMap = get().onlineByServer[serverId] ?? {};
      const existing = prevMap[resolvedUserId];
      const nextEntry: MemberRealtimePresence = {
        user_id: resolvedUserId,
        status: get().localStatus,
        game_presence: existing?.game_presence ?? get().currentGame,
        voice_state: normalizedVoice,
        updated_at: now,
      };
      const nextMap = {
        ...prevMap,
        [resolvedUserId]: nextEntry,
      };
      set((prev) => ({
        onlineByServer: {
          ...prev.onlineByServer,
          [serverId]: nextMap,
        },
      }));
    }

    const channel = get().activePresenceChannel;
    if (channel && resolvedUserId && isChannelJoined(channel)) {
      const payload: MemberRealtimePresence = {
        user_id: resolvedUserId,
        status: get().localStatus,
        game_presence: get().currentGame,
        voice_state: sanitizeVoiceForTrack(normalizedVoice),
        updated_at: now,
        sender_session: LOCAL_SESSION_ID,
        sender_seq: nextSenderSeq(),
      };
      await sendBroadcastIfJoined(
        channel,
        "voice_state_sync",
        payload as unknown as Record<string, unknown>,
      );
      schedulePresenceTrack(channel, payload);
    }
  },

  setLocalSpeakingState: (speaking, userId) => {
    const resolvedUserId = userId ?? useAuthStore.getState().user?.id;
    const currentVoice = get().localVoiceState;
    if (!resolvedUserId || !currentVoice?.channel_id) return;
    if (currentVoice.speaking === speaking) return;

    const updatedVoice: MemberVoiceRealtimeState = {
      ...currentVoice,
      speaking,
    };
    set({ localVoiceState: updatedVoice });

    const serverId = get().activePresenceServerId;
    if (serverId) {
      set((prev) => {
        const currentMap = prev.onlineByServer[serverId] ?? {};
        const existing = currentMap[resolvedUserId];
        if (!existing) return prev;
        return {
          onlineByServer: {
            ...prev.onlineByServer,
            [serverId]: {
              ...currentMap,
              [resolvedUserId]: {
                ...existing,
                voice_state: updatedVoice,
              },
            },
          },
        };
      });
    }

    const now = Date.now();
    if (now - lastSpeakingBroadcastAt < SPEAKING_BROADCAST_MIN_INTERVAL_MS) {
      return;
    }
    const channel = get().activePresenceChannel;
    if (isChannelJoined(channel)) {
      lastSpeakingBroadcastAt = now;
      void sendBroadcastIfJoined(channel, "voice_speaking_sync", {
        user_id: resolvedUserId,
        channel_id: currentVoice.channel_id,
        speaking,
      });
    }
  },

  applyRemoteGamePresence: (update) => {
    const normalized =
      update.game_id || update.game_name ? update : null;
    set((prev) => {
      const nextOnline = { ...prev.onlineByServer };
      for (const [serverId, members] of Object.entries(nextOnline)) {
        const existing = members[update.user_id];
        if (existing) {
          nextOnline[serverId] = {
            ...members,
            [update.user_id]: {
              ...existing,
              game_presence: normalized,
              updated_at: Date.now(),
            },
          };
        }
      }

      return {
        gameByUser: {
          ...prev.gameByUser,
          [update.user_id]: normalized,
        },
        onlineByServer: nextOnline,
      };
    });
  },
}));

onLocalProfileUpdated((updatedProfile) => {
  for (const listener of profileRealtimeListeners) {
    try {
      listener(updatedProfile);
    } catch {
      // ignore
    }
  }
  const channel = usePresenceStore.getState().activePresenceChannel;
  if (isChannelJoined(channel)) {
    void sendBroadcastIfJoined(channel, "profile_updated", {
      profile: updatedProfile,
    });
  }
});
