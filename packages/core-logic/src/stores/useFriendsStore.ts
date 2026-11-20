import type { RealtimeChannel } from "@supabase/supabase-js";
import { create } from "zustand";
import type { GamePresenceUpdate } from "../generated";
import type {
  DirectChannelRow,
  DirectMessageRow,
  FriendshipRow,
  Json,
  MessageAttachment,
  PresenceStatus,
  ProfileRow,
} from "../supabase/types";
import {
  getSupabaseClientOrThrow,
  loadPreferredPresenceStatus,
  useAuthStore,
} from "./useAuthStore";
import { onProfileRealtimeUpdate, usePresenceStore } from "./usePresenceStore";
import { useVoiceStore } from "./useVoiceStore";

const DM_PAGE_SIZE = 50;
const DM_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const GLOBAL_PRESENCE_TRACK_THROTTLE_MS = 8_000;

export interface FriendshipWithProfile extends FriendshipRow {
  otherUser: ProfileRow | null;
  direction: "incoming" | "outgoing";
}

export interface DirectChannelWithPeer extends DirectChannelRow {
  otherUserId: string;
  otherUser: ProfileRow | null;
  lastMessagePreview: string | null;
}

export interface DirectMessageItem extends DirectMessageRow {
  author: ProfileRow | null;
  parsed_attachments: MessageAttachment[];
  reply_to?: DirectMessageItem | null;
}

export interface FriendGlobalPresence {
  user_id: string;
  status: PresenceStatus;
  game_presence: GamePresenceUpdate | null;
  updated_at: number;
}

export interface IncomingDirectCall {
  callId: string;
  dmChannelId: string;
  roomId: string;
  callerId: string;
  callerName: string;
  callerAvatarUrl: string | null;
  callerAccentColor: string;
  receivedAt: number;
}

export interface OutgoingDirectCall {
  callId: string;
  dmChannelId: string;
  roomId: string;
  calleeId: string;
  calleeName: string;
  calleeAvatarUrl: string | null;
  startedAt: number;
  status: "ringing" | "declined" | "missed";
}

export interface IncomingDmNotificationEvent {
  dmChannelId: string;
  message: DirectMessageItem;
  isActiveDm: boolean;
  isAtBottom: boolean;
}

type IncomingDmListener = (event: IncomingDmNotificationEvent) => void;
type IncomingFriendRequestListener = (friendship: FriendshipWithProfile) => void;

const incomingDmListeners = new Set<IncomingDmListener>();
const incomingFriendRequestListeners = new Set<IncomingFriendRequestListener>();
const notifiedDmMessageIds = new Set<string>();

export function onIncomingDmNotification(
  listener: IncomingDmListener,
): () => void {
  incomingDmListeners.add(listener);
  return () => {
    incomingDmListeners.delete(listener);
  };
}

export function onIncomingFriendRequest(
  listener: IncomingFriendRequestListener,
): () => void {
  incomingFriendRequestListeners.add(listener);
  return () => {
    incomingFriendRequestListeners.delete(listener);
  };
}

export function makeDmVoiceRoomId(dmChannelId: string): string {
  return `dm:${dmChannelId}`;
}

function parseDmAttachments(raw: Json): MessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Record<string, Json> =>
        typeof item === "object" && item !== null,
    )
    .map((item) => ({
      name: String(item.name ?? "arquivo"),
      url: String(item.url ?? ""),
      path: String(item.path ?? ""),
      mime_type: String(item.mime_type ?? "application/octet-stream"),
      size: Number(item.size ?? 0),
    }))
    .filter((a) => Boolean(a.url));
}

function resolveDmReplyLinks(
  messages: DirectMessageItem[],
): DirectMessageItem[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return messages.map((m) => ({
    ...m,
    reply_to: m.reply_to_id ? (byId.get(m.reply_to_id) ?? null) : null,
  }));
}

function toFriendlyError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) {
      return new Error(msg);
    }
  }
  return new Error(String(err));
}

async function fetchProfilesMap(
  userIds: string[],
  existingCache: Record<string, ProfileRow>,
): Promise<Record<string, ProfileRow>> {
  const missing = Array.from(new Set(userIds)).filter(
    (id) => Boolean(id) && !existingCache[id],
  );
  if (missing.length === 0) return existingCache;

  const supabase = getSupabaseClientOrThrow();
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .in("id", missing);

  if (!data || data.length === 0) return existingCache;
  const next = { ...existingCache };
  for (const row of data) {
    next[row.id] = row;
  }
  return next;
}

async function sendDirectSignalToUser(
  targetUserId: string,
  event: "dm_call_ring" | "dm_call_accept" | "dm_call_decline" | "dm_call_cancel",
  payload: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabaseClientOrThrow();
  const tempChannel = supabase.channel(`cafofo-user-inbox:${targetUserId}`, {
    config: { broadcast: { self: false, ack: false } },
  });

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 3500);
    tempChannel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        void tempChannel
          .send({
            type: "broadcast",
            event,
            payload,
          })
          .finally(() => {
            setTimeout(done, 120);
          });
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        done();
      }
    });
  });

  await supabase.removeChannel(tempChannel).catch(() => {});
}

let socialDbChannel: RealtimeChannel | null = null;
let userInboxChannel: RealtimeChannel | null = null;
let globalPresenceChannel: RealtimeChannel | null = null;
let boundSocialUserId: string | null = null;
let outgoingTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let incomingTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
let lastGlobalTrackAt = 0;
let globalTrackTimer: ReturnType<typeof setTimeout> | null = null;

function clearCallTimers(): void {
  if (outgoingTimeoutHandle) {
    clearTimeout(outgoingTimeoutHandle);
    outgoingTimeoutHandle = null;
  }
  if (incomingTimeoutHandle) {
    clearTimeout(incomingTimeoutHandle);
    incomingTimeoutHandle = null;
  }
}

interface FriendsState {
  friendships: FriendshipWithProfile[];
  dmChannels: DirectChannelWithPeer[];
  activeDmChannelId: string | null;
  messagesByDm: Record<string, DirectMessageItem[]>;
  hasMoreByDm: Record<string, boolean>;
  loadingByDm: Record<string, boolean>;
  isAtBottomByDm: Record<string, boolean>;
  unreadByDm: Record<string, number>;
  replyingToDm: DirectMessageItem | null;
  profileCache: Record<string, ProfileRow>;
  friendPresenceByUser: Record<string, FriendGlobalPresence>;
  incomingCall: IncomingDirectCall | null;
  outgoingCall: OutgoingDirectCall | null;
  loading: boolean;
  sending: boolean;
  error: string | null;

  bindSocialRealtime: (userId: string) => Promise<void>;
  unbindSocialRealtime: () => Promise<void>;
  syncGlobalPresence: (
    status: PresenceStatus,
    game: GamePresenceUpdate | null,
  ) => void;
  loadFriendships: () => Promise<FriendshipWithProfile[]>;
  loadDmChannels: () => Promise<DirectChannelWithPeer[]>;
  sendFriendRequestByUsername: (
    username: string,
  ) => Promise<FriendshipWithProfile>;
  sendFriendRequestByUserId: (
    targetUserId: string,
  ) => Promise<FriendshipWithProfile>;
  acceptFriendRequest: (friendshipId: string) => Promise<void>;
  removeOrDeclineFriendship: (friendshipId: string) => Promise<void>;
  blockUser: (targetUserId: string) => Promise<void>;
  openOrCreateDm: (otherUserId: string) => Promise<DirectChannelWithPeer>;
  selectDmChannel: (dmChannelId: string | null) => void;
  setDmAtBottom: (dmChannelId: string, isAtBottom: boolean) => void;
  markDmRead: (dmChannelId: string) => void;
  loadDmMessages: (dmChannelId: string) => Promise<DirectMessageItem[]>;
  loadOlderDmMessages: (dmChannelId: string) => Promise<DirectMessageItem[]>;
  sendDmMessage: (params: {
    dmChannelId: string;
    content: string;
    replyToId?: string | null;
    files?: File[];
  }) => Promise<DirectMessageItem>;
  editDmMessage: (messageId: string, content: string) => Promise<void>;
  deleteDmMessage: (messageId: string) => Promise<void>;
  setReplyingToDm: (message: DirectMessageItem | null) => void;

  startDirectCall: (params: {
    dmChannelId: string;
    calleeId: string;
    calleeName: string;
    calleeAvatarUrl?: string | null;
  }) => Promise<void>;
  acceptIncomingCall: () => Promise<string | null>;
  declineIncomingCall: () => Promise<void>;
  cancelOutgoingCall: () => Promise<void>;
  reset: () => Promise<void>;
}

export const useFriendsStore = create<FriendsState>((set, get) => ({
  friendships: [],
  dmChannels: [],
  activeDmChannelId: null,
  messagesByDm: {},
  hasMoreByDm: {},
  loadingByDm: {},
  isAtBottomByDm: {},
  unreadByDm: {},
  replyingToDm: null,
  profileCache: {},
  friendPresenceByUser: {},
  incomingCall: null,
  outgoingCall: null,
  loading: false,
  sending: false,
  error: null,

  syncGlobalPresence: (status, game) => {
    const userId = useAuthStore.getState().user?.id;
    if (!userId || !globalPresenceChannel || globalPresenceChannel.state !== "joined") {
      return;
    }
    const payload: FriendGlobalPresence = {
      user_id: userId,
      status,
      game_presence: game,
      updated_at: Date.now(),
    };

    const doTrack = () => {
      if (!globalPresenceChannel || globalPresenceChannel.state !== "joined") {
        return;
      }
      lastGlobalTrackAt = Date.now();
      void globalPresenceChannel.track(payload).catch(() => {});
    };

    void globalPresenceChannel
      .send({
        type: "broadcast",
        event: "friend_presence_sync",
        payload: payload as unknown as Record<string, unknown>,
      })
      .catch(() => {});

    const elapsed = Date.now() - lastGlobalTrackAt;
    if (elapsed >= GLOBAL_PRESENCE_TRACK_THROTTLE_MS) {
      if (globalTrackTimer) {
        clearTimeout(globalTrackTimer);
        globalTrackTimer = null;
      }
      doTrack();
    } else if (!globalTrackTimer) {
      globalTrackTimer = setTimeout(() => {
        globalTrackTimer = null;
        doTrack();
      }, GLOBAL_PRESENCE_TRACK_THROTTLE_MS - elapsed + 60);
    }
  },

  bindSocialRealtime: async (userId) => {
    if (boundSocialUserId === userId && socialDbChannel && userInboxChannel) {
      return;
    }

    await get().unbindSocialRealtime();
    boundSocialUserId = userId;

    const supabase = getSupabaseClientOrThrow();
    const accessToken = useAuthStore.getState().session?.access_token;
    if (accessToken) {
      await supabase.realtime.setAuth(accessToken).catch(() => {});
    }

    await Promise.all([
      get().loadFriendships().catch(() => []),
      get().loadDmChannels().catch(() => []),
    ]);

    if (boundSocialUserId !== userId) return;

    // 1. Postgres Realtime channel for friendships, direct_channels & direct_messages
    const dbCh = supabase
      .channel(`cafofo-social-db:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "friendships",
        },
        async (payload) => {
          const prevIds = new Set(get().friendships.map((f) => f.id));
          const refreshed = await get().loadFriendships().catch(() => []);
          if (payload.eventType === "INSERT") {
            const inserted = payload.new as FriendshipRow | null;
            if (
              inserted &&
              !prevIds.has(inserted.id) &&
              inserted.addressee_id === userId &&
              inserted.status === "pending"
            ) {
              const matched = refreshed.find((f) => f.id === inserted.id);
              if (matched) {
                for (const listener of incomingFriendRequestListeners) {
                  try {
                    listener(matched);
                  } catch {
                    // ignore
                  }
                }
              }
            }
          }
          if (payload.eventType === "UPDATE") {
            void get().loadDmChannels().catch(() => {});
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "direct_channels",
        },
        () => {
          void get().loadDmChannels().catch(() => {});
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "direct_messages",
        },
        async (payload) => {
          const row = payload.new as DirectMessageRow;
          if (!row?.id || !row.dm_channel_id) return;

          const updatedCache = await fetchProfilesMap(
            [row.author_id],
            get().profileCache,
          );
          const author = updatedCache[row.author_id] ?? null;
          const nextMsg: DirectMessageItem = {
            ...row,
            author,
            parsed_attachments: parseDmAttachments(row.attachments),
          };

          let isNew = false;
          let isActiveDm = false;
          let isAtBottom = true;

          set((prev) => {
            const existingList = prev.messagesByDm[row.dm_channel_id];
            if (existingList?.some((m) => m.id === row.id)) {
              return prev;
            }
            isNew = true;
            isActiveDm = prev.activeDmChannelId === row.dm_channel_id;
            isAtBottom = prev.isAtBottomByDm[row.dm_channel_id] ?? true;

            const isFromOther = row.author_id !== userId;
            const shouldIncrementUnread =
              isFromOther && !(isActiveDm && isAtBottom);

            const nextMessagesByDm = existingList
              ? {
                  ...prev.messagesByDm,
                  [row.dm_channel_id]: resolveDmReplyLinks([
                    ...existingList,
                    nextMsg,
                  ]),
                }
              : prev.messagesByDm;

            const preview =
              row.content.trim() ||
              (nextMsg.parsed_attachments.length > 0 ? "[Anexo]" : "");

            const hasChannel = prev.dmChannels.some(
              (c) => c.id === row.dm_channel_id,
            );
            const nextDmChannels = hasChannel
              ? prev.dmChannels
                  .map((c) =>
                    c.id === row.dm_channel_id
                      ? {
                          ...c,
                          last_message_at: row.created_at,
                          lastMessagePreview: preview,
                        }
                      : c,
                  )
                  .sort((a, b) =>
                    b.last_message_at.localeCompare(a.last_message_at),
                  )
              : prev.dmChannels;

            const nextUnreadByDm = shouldIncrementUnread
              ? {
                  ...prev.unreadByDm,
                  [row.dm_channel_id]:
                    (prev.unreadByDm[row.dm_channel_id] ?? 0) + 1,
                }
              : prev.unreadByDm;

            return {
              profileCache: updatedCache,
              messagesByDm: nextMessagesByDm,
              dmChannels: nextDmChannels,
              unreadByDm: nextUnreadByDm,
            };
          });

          // If this DM channel wasn't in our list yet, load it now
          if (!get().dmChannels.some((c) => c.id === row.dm_channel_id)) {
            void get().loadDmChannels().catch(() => {});
          }

          if (
            isNew &&
            row.author_id !== userId &&
            !notifiedDmMessageIds.has(row.id)
          ) {
            notifiedDmMessageIds.add(row.id);
            if (notifiedDmMessageIds.size > 250) {
              const oldest = notifiedDmMessageIds.values().next().value;
              if (oldest) notifiedDmMessageIds.delete(oldest);
            }
            const event: IncomingDmNotificationEvent = {
              dmChannelId: row.dm_channel_id,
              message: nextMsg,
              isActiveDm,
              isAtBottom,
            };
            for (const listener of incomingDmListeners) {
              try {
                listener(event);
              } catch {
                // ignore
              }
            }
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "direct_messages",
        },
        (payload) => {
          const row = payload.new as DirectMessageRow;
          if (!row?.id || !row.dm_channel_id) return;
          set((prev) => {
            const list = prev.messagesByDm[row.dm_channel_id];
            if (!list) return prev;
            const updated = list.map((m) =>
              m.id === row.id
                ? {
                    ...m,
                    content: row.content,
                    edited_at: row.edited_at,
                    attachments: row.attachments,
                    parsed_attachments: parseDmAttachments(row.attachments),
                  }
                : m,
            );
            return {
              messagesByDm: {
                ...prev.messagesByDm,
                [row.dm_channel_id]: resolveDmReplyLinks(updated),
              },
            };
          });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "direct_messages",
        },
        (payload) => {
          const deletedId = (payload.old as { id?: string } | null)?.id;
          if (!deletedId) return;
          set((prev) => {
            let changed = false;
            const nextByDm = { ...prev.messagesByDm };
            for (const [dmId, list] of Object.entries(nextByDm)) {
              if (list.some((m) => m.id === deletedId)) {
                nextByDm[dmId] = resolveDmReplyLinks(
                  list.filter((m) => m.id !== deletedId),
                );
                changed = true;
              }
            }
            if (!changed) return prev;
            return {
              messagesByDm: nextByDm,
              replyingToDm:
                prev.replyingToDm?.id === deletedId ? null : prev.replyingToDm,
            };
          });
        },
      );
    dbCh.subscribe();
    socialDbChannel = dbCh;

    // 2. Personal Broadcast Inbox for 1:1 Direct Call ringing / cancel / decline / accept
    const inboxCh = supabase
      .channel(`cafofo-user-inbox:${userId}`, {
        config: { broadcast: { self: false, ack: false } },
      })
      .on("broadcast", { event: "dm_call_ring" }, ({ payload }) => {
        if (boundSocialUserId !== userId) return;
        const data = payload as Partial<IncomingDirectCall> | null;
        if (!data?.callId || !data.dmChannelId || !data.roomId || !data.callerId) {
          return;
        }
        if (data.callerId === userId) return;

        // If already connected to this exact 1:1 call room, ignore duplicate ring
        if (useVoiceStore.getState().activeVoiceChannelId === data.roomId) {
          return;
        }

        const nextIncoming: IncomingDirectCall = {
          callId: data.callId,
          dmChannelId: data.dmChannelId,
          roomId: data.roomId,
          callerId: data.callerId,
          callerName: data.callerName || "Amigo",
          callerAvatarUrl: data.callerAvatarUrl ?? null,
          callerAccentColor: data.callerAccentColor || "#B91C1C",
          receivedAt: Date.now(),
        };

        set({ incomingCall: nextIncoming });
        if (incomingTimeoutHandle) clearTimeout(incomingTimeoutHandle);
        incomingTimeoutHandle = setTimeout(() => {
          set((prev) =>
            prev.incomingCall?.callId === nextIncoming.callId
              ? { incomingCall: null }
              : prev,
          );
        }, 35_000);
      })
      .on("broadcast", { event: "dm_call_cancel" }, ({ payload }) => {
        const callId = (payload as { callId?: string } | null)?.callId;
        set((prev) =>
          prev.incomingCall && (!callId || prev.incomingCall.callId === callId)
            ? { incomingCall: null }
            : prev,
        );
      })
      .on("broadcast", { event: "dm_call_decline" }, ({ payload }) => {
        const callId = (payload as { callId?: string } | null)?.callId;
        set((prev) => {
          if (
            !prev.outgoingCall ||
            (callId && prev.outgoingCall.callId !== callId)
          ) {
            return prev;
          }
          return {
            outgoingCall: { ...prev.outgoingCall, status: "declined" },
          };
        });
        setTimeout(() => {
          set((prev) =>
            prev.outgoingCall?.status === "declined"
              ? { outgoingCall: null }
              : prev,
          );
        }, 2500);
      })
      .on("broadcast", { event: "dm_call_accept" }, ({ payload }) => {
        const callId = (payload as { callId?: string } | null)?.callId;
        set((prev) =>
          prev.outgoingCall && (!callId || prev.outgoingCall.callId === callId)
            ? { outgoingCall: null }
            : prev,
        );
      });
    inboxCh.subscribe();
    userInboxChannel = inboxCh;

    // 3. Lightweight global presence channel so Friends Online/Game works across servers & Home
    const globalCh = supabase.channel("cafofo-friends-global", {
      config: {
        presence: { key: userId },
        broadcast: { self: false, ack: false },
      },
    });

    const syncGlobalState = () => {
      if (globalPresenceChannel !== globalCh) return;
      const state = globalCh.presenceState<FriendGlobalPresence>();
      const nextMap: Record<string, FriendGlobalPresence> = {};
      for (const [key, entries] of Object.entries(state)) {
        if (!entries || entries.length === 0) continue;
        const latest = [...entries].sort(
          (a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0),
        )[0];
        if (!latest) continue;
        const uid = latest.user_id || key;
        nextMap[uid] = {
          user_id: uid,
          status: latest.status ?? "online",
          game_presence: latest.game_presence ?? null,
          updated_at: Date.now(),
        };
      }
      set({ friendPresenceByUser: nextMap });
    };

    globalCh
      .on("presence", { event: "sync" }, syncGlobalState)
      .on("presence", { event: "join" }, syncGlobalState)
      .on("presence", { event: "leave" }, syncGlobalState)
      .on("broadcast", { event: "friend_presence_sync" }, ({ payload }) => {
        const data = payload as Partial<FriendGlobalPresence> | null;
        if (!data?.user_id || data.user_id === userId) return;
        set((prev) => ({
          friendPresenceByUser: {
            ...prev.friendPresenceByUser,
            [data.user_id!]: {
              user_id: data.user_id!,
              status: data.status ?? "online",
              game_presence: data.game_presence ?? null,
              updated_at: Date.now(),
            },
          },
        }));
      })
      .subscribe((subStatus) => {
        if (globalPresenceChannel !== globalCh) return;
        if (subStatus === "SUBSCRIBED") {
          const initialStatus =
            loadPreferredPresenceStatus() ??
            usePresenceStore.getState().localStatus ??
            "online";
          const initialGame = usePresenceStore.getState().currentGame ?? null;
          lastGlobalTrackAt = Date.now();
          void globalCh
            .track({
              user_id: userId,
              status: initialStatus,
              game_presence: initialGame,
              updated_at: Date.now(),
            })
            .catch(() => {});
          syncGlobalState();
        }
      });
    globalPresenceChannel = globalCh;
  },

  unbindSocialRealtime: async () => {
    boundSocialUserId = null;
    clearCallTimers();
    if (globalTrackTimer) {
      clearTimeout(globalTrackTimer);
      globalTrackTimer = null;
    }

    const dbCh = socialDbChannel;
    const inboxCh = userInboxChannel;
    const globalCh = globalPresenceChannel;
    socialDbChannel = null;
    userInboxChannel = null;
    globalPresenceChannel = null;

    if (!dbCh && !inboxCh && !globalCh) return;
    const supabase = getSupabaseClientOrThrow();
    if (globalCh && globalCh.state === "joined") {
      await globalCh.untrack().catch(() => {});
    }
    await Promise.all([
      dbCh ? supabase.removeChannel(dbCh).catch(() => {}) : Promise.resolve(),
      inboxCh
        ? supabase.removeChannel(inboxCh).catch(() => {})
        : Promise.resolve(),
      globalCh
        ? supabase.removeChannel(globalCh).catch(() => {})
        : Promise.resolve(),
    ]);
  },

  loadFriendships: async () => {
    const supabase = getSupabaseClientOrThrow();
    const selfId = useAuthStore.getState().user?.id;
    if (!selfId) return [];

    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase
        .from("friendships")
        .select("*")
        .or(`requester_id.eq.${selfId},addressee_id.eq.${selfId}`)
        .order("updated_at", { ascending: false });

      if (error) throw toFriendlyError(error);
      const rows = data ?? [];

      const otherIds = rows.map((r) =>
        r.requester_id === selfId ? r.addressee_id : r.requester_id,
      );
      const cache = await fetchProfilesMap(otherIds, get().profileCache);

      const enriched: FriendshipWithProfile[] = rows.map((r) => {
        const isOutgoing = r.requester_id === selfId;
        const otherId = isOutgoing ? r.addressee_id : r.requester_id;
        return {
          ...r,
          direction: isOutgoing ? "outgoing" : "incoming",
          otherUser: cache[otherId] ?? null,
        };
      });

      set({ friendships: enriched, profileCache: cache });
      return enriched;
    } catch (err) {
      const resolved = toFriendlyError(err);
      set({ error: resolved.message });
      throw resolved;
    } finally {
      set({ loading: false });
    }
  },

  loadDmChannels: async () => {
    const supabase = getSupabaseClientOrThrow();
    const selfId = useAuthStore.getState().user?.id;
    if (!selfId) return [];

    const { data, error } = await supabase
      .from("direct_channels")
      .select("*")
      .or(`user_a.eq.${selfId},user_b.eq.${selfId}`)
      .order("last_message_at", { ascending: false });

    if (error) throw toFriendlyError(error);
    const rows = data ?? [];
    const otherIds = rows.map((r) => (r.user_a === selfId ? r.user_b : r.user_a));
    const cache = await fetchProfilesMap(otherIds, get().profileCache);

    const existingPreviews = new Map(
      get().dmChannels.map((c) => [c.id, c.lastMessagePreview]),
    );

    const enriched: DirectChannelWithPeer[] = rows.map((r) => {
      const otherId = r.user_a === selfId ? r.user_b : r.user_a;
      return {
        ...r,
        otherUserId: otherId,
        otherUser: cache[otherId] ?? null,
        lastMessagePreview: existingPreviews.get(r.id) ?? null,
      };
    });

    set({ dmChannels: enriched, profileCache: cache });
    return enriched;
  },

  sendFriendRequestByUsername: async (username) => {
    const supabase = getSupabaseClientOrThrow();
    const clean = username.trim().replace(/^@+/, "");
    if (!clean) throw new Error("Informe o @username do amigo.");

    const { data, error } = await supabase.rpc(
      "send_friend_request_by_username",
      { p_username: clean },
    );
    if (error) throw toFriendlyError(error);

    const row = data as FriendshipRow;
    const refreshed = await get().loadFriendships();
    if (row.status === "accepted") {
      void get().loadDmChannels().catch(() => {});
    }
    const matched = refreshed.find((f) => f.id === row.id);
    if (!matched) {
      return {
        ...row,
        direction: "outgoing",
        otherUser: null,
      };
    }
    return matched;
  },

  sendFriendRequestByUserId: async (targetUserId) => {
    const supabase = getSupabaseClientOrThrow();
    const selfId = useAuthStore.getState().user?.id;
    if (!selfId) throw new Error("Usuário não autenticado.");
    if (targetUserId === selfId) {
      throw new Error("Você não pode adicionar a si mesmo.");
    }

    const existing = get().friendships.find(
      (f) => f.otherUser?.id === targetUserId || f.requester_id === targetUserId || f.addressee_id === targetUserId,
    );
    if (existing) {
      if (existing.status === "accepted") {
        return existing;
      }
      if (existing.status === "pending" && existing.direction === "incoming") {
        await get().acceptFriendRequest(existing.id);
        return (
          get().friendships.find((f) => f.id === existing.id) ?? {
            ...existing,
            status: "accepted",
          }
        );
      }
      if (existing.status === "pending") {
        throw new Error("Pedido de amizade já enviado e aguardando resposta.");
      }
      throw new Error("Não foi possível enviar pedido para este usuário.");
    }

    const { data, error } = await supabase
      .from("friendships")
      .insert({
        requester_id: selfId,
        addressee_id: targetUserId,
        status: "pending",
      })
      .select("*")
      .single();

    if (error) throw toFriendlyError(error);

    const refreshed = await get().loadFriendships();
    return (
      refreshed.find((f) => f.id === data.id) ?? {
        ...data,
        direction: "outgoing",
        otherUser: get().profileCache[targetUserId] ?? null,
      }
    );
  },

  acceptFriendRequest: async (friendshipId) => {
    const supabase = getSupabaseClientOrThrow();
    const { error } = await supabase.rpc("accept_friend_request", {
      p_friendship_id: friendshipId,
    });
    if (error) throw toFriendlyError(error);
    await Promise.all([get().loadFriendships(), get().loadDmChannels()]);
  },

  removeOrDeclineFriendship: async (friendshipId) => {
    const supabase = getSupabaseClientOrThrow();
    const { error } = await supabase
      .from("friendships")
      .delete()
      .eq("id", friendshipId);
    if (error) throw toFriendlyError(error);

    set((prev) => ({
      friendships: prev.friendships.filter((f) => f.id !== friendshipId),
    }));
  },

  blockUser: async (targetUserId) => {
    const supabase = getSupabaseClientOrThrow();
    const selfId = useAuthStore.getState().user?.id;
    if (!selfId) throw new Error("Usuário não autenticado.");

    const existing = get().friendships.find(
      (f) => f.requester_id === targetUserId || f.addressee_id === targetUserId,
    );
    if (existing) {
      const { error } = await supabase
        .from("friendships")
        .update({ status: "blocked" })
        .eq("id", existing.id);
      if (error) throw toFriendlyError(error);
    } else {
      const { error } = await supabase.from("friendships").insert({
        requester_id: selfId,
        addressee_id: targetUserId,
        status: "blocked",
      });
      if (error) throw toFriendlyError(error);
    }
    await get().loadFriendships();
  },

  openOrCreateDm: async (otherUserId) => {
    const supabase = getSupabaseClientOrThrow();
    const { data, error } = await supabase.rpc("get_or_create_dm_channel", {
      p_other_user_id: otherUserId,
    });
    if (error) throw toFriendlyError(error);
    const channel = data as DirectChannelRow;

    const refreshed = await get().loadDmChannels();
    const matched = refreshed.find((c) => c.id === channel.id) ?? {
      ...channel,
      otherUserId,
      otherUser: get().profileCache[otherUserId] ?? null,
      lastMessagePreview: null,
    };

    get().selectDmChannel(matched.id);
    return matched;
  },

  selectDmChannel: (dmChannelId) => {
    set((prev) => {
      const nextUnread = { ...prev.unreadByDm };
      if (dmChannelId) {
        delete nextUnread[dmChannelId];
      }
      return {
        activeDmChannelId: dmChannelId,
        unreadByDm: nextUnread,
        replyingToDm: null,
        isAtBottomByDm: dmChannelId
          ? {
              ...prev.isAtBottomByDm,
              [dmChannelId]: prev.isAtBottomByDm[dmChannelId] ?? true,
            }
          : prev.isAtBottomByDm,
      };
    });
  },

  setDmAtBottom: (dmChannelId, isAtBottom) => {
    set((prev) => {
      if (prev.isAtBottomByDm[dmChannelId] === isAtBottom) return prev;
      return {
        isAtBottomByDm: { ...prev.isAtBottomByDm, [dmChannelId]: isAtBottom },
      };
    });
  },

  markDmRead: (dmChannelId) => {
    set((prev) => {
      if (!prev.unreadByDm[dmChannelId]) return prev;
      const next = { ...prev.unreadByDm };
      delete next[dmChannelId];
      return { unreadByDm: next };
    });
  },

  loadDmMessages: async (dmChannelId) => {
    const supabase = getSupabaseClientOrThrow();
    set((prev) => ({
      loadingByDm: { ...prev.loadingByDm, [dmChannelId]: true },
      error: null,
    }));

    try {
      const { data, error } = await supabase
        .from("direct_messages")
        .select("*")
        .eq("dm_channel_id", dmChannelId)
        .order("created_at", { ascending: false })
        .limit(DM_PAGE_SIZE);

      if (error) throw toFriendlyError(error);
      const rows = (data ?? []).reverse();
      const cache = await fetchProfilesMap(
        rows.map((r) => r.author_id),
        get().profileCache,
      );

      const hydrated: DirectMessageItem[] = rows.map((row) => ({
        ...row,
        author: cache[row.author_id] ?? null,
        parsed_attachments: parseDmAttachments(row.attachments),
      }));

      const withReplies = resolveDmReplyLinks(hydrated);
      const lastMsg = withReplies[withReplies.length - 1] ?? null;
      const lastPreview = lastMsg
        ? lastMsg.content.trim() ||
          (lastMsg.parsed_attachments.length > 0 ? "[Anexo]" : null)
        : null;

      set((prev) => ({
        profileCache: cache,
        messagesByDm: { ...prev.messagesByDm, [dmChannelId]: withReplies },
        hasMoreByDm: {
          ...prev.hasMoreByDm,
          [dmChannelId]: rows.length === DM_PAGE_SIZE,
        },
        dmChannels: prev.dmChannels.map((c) =>
          c.id === dmChannelId && lastPreview !== null
            ? { ...c, lastMessagePreview: lastPreview }
            : c,
        ),
      }));
      return withReplies;
    } catch (err) {
      const resolved = toFriendlyError(err);
      set({ error: resolved.message });
      throw resolved;
    } finally {
      set((prev) => ({
        loadingByDm: { ...prev.loadingByDm, [dmChannelId]: false },
      }));
    }
  },

  loadOlderDmMessages: async (dmChannelId) => {
    const current = get().messagesByDm[dmChannelId] ?? [];
    if (current.length === 0 || get().loadingByDm[dmChannelId]) {
      return current;
    }
    const oldest = current[0];
    const supabase = getSupabaseClientOrThrow();
    set((prev) => ({
      loadingByDm: { ...prev.loadingByDm, [dmChannelId]: true },
    }));

    try {
      const { data, error } = await supabase
        .from("direct_messages")
        .select("*")
        .eq("dm_channel_id", dmChannelId)
        .lt("created_at", oldest.created_at)
        .order("created_at", { ascending: false })
        .limit(DM_PAGE_SIZE);

      if (error) throw toFriendlyError(error);
      const rows = (data ?? []).reverse();
      const cache = await fetchProfilesMap(
        rows.map((r) => r.author_id),
        get().profileCache,
      );

      const older: DirectMessageItem[] = rows.map((row) => ({
        ...row,
        author: cache[row.author_id] ?? null,
        parsed_attachments: parseDmAttachments(row.attachments),
      }));

      const merged = resolveDmReplyLinks([...older, ...current]);
      set((prev) => ({
        profileCache: cache,
        messagesByDm: { ...prev.messagesByDm, [dmChannelId]: merged },
        hasMoreByDm: {
          ...prev.hasMoreByDm,
          [dmChannelId]: rows.length === DM_PAGE_SIZE,
        },
      }));
      return merged;
    } finally {
      set((prev) => ({
        loadingByDm: { ...prev.loadingByDm, [dmChannelId]: false },
      }));
    }
  },

  sendDmMessage: async ({ dmChannelId, content, replyToId, files = [] }) => {
    const supabase = getSupabaseClientOrThrow();
    const user = useAuthStore.getState().user;
    const profile = useAuthStore.getState().profile;
    if (!user) throw new Error("Usuário não autenticado.");

    const cleanContent = content.trim();
    if (!cleanContent && files.length === 0) {
      throw new Error("Digite uma mensagem ou anexe um arquivo.");
    }

    set({ sending: true, error: null });
    try {
      const uploaded: MessageAttachment[] = [];
      for (const file of files) {
        if (file.size > DM_ATTACHMENT_MAX_BYTES) {
          throw new Error(`Anexo "${file.name}" excede o limite de 25 MB.`);
        }
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${user.id}/dm/${dmChannelId}/${Date.now()}-${safeName}`;

        const { error: uploadError } = await supabase.storage
          .from("attachments")
          .upload(path, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
          });
        if (uploadError) {
          throw new Error(
            `Erro ao enviar anexo "${file.name}": ${uploadError.message}`,
          );
        }

        const {
          data: { publicUrl },
        } = supabase.storage.from("attachments").getPublicUrl(path);

        uploaded.push({
          name: file.name,
          url: publicUrl,
          path,
          mime_type: file.type || "application/octet-stream",
          size: file.size,
        });
      }

      const effectiveReplyId = replyToId ?? get().replyingToDm?.id ?? null;

      const { data, error } = await supabase
        .from("direct_messages")
        .insert({
          dm_channel_id: dmChannelId,
          author_id: user.id,
          content: cleanContent,
          reply_to_id: effectiveReplyId,
          attachments: uploaded as unknown as Json,
        })
        .select("*")
        .single();

      if (error) throw toFriendlyError(error);

      const msg: DirectMessageItem = {
        ...data,
        author: profile ?? null,
        parsed_attachments: uploaded,
      };

      const preview = cleanContent || (uploaded.length > 0 ? "[Anexo]" : "");

      set((prev) => {
        const list = prev.messagesByDm[dmChannelId] ?? [];
        const deduped = list.some((m) => m.id === msg.id)
          ? list
          : [...list, msg];
        return {
          messagesByDm: {
            ...prev.messagesByDm,
            [dmChannelId]: resolveDmReplyLinks(deduped),
          },
          dmChannels: prev.dmChannels
            .map((c) =>
              c.id === dmChannelId
                ? {
                    ...c,
                    last_message_at: msg.created_at,
                    lastMessagePreview: preview,
                  }
                : c,
            )
            .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at)),
          replyingToDm: null,
        };
      });

      return msg;
    } catch (err) {
      const resolved = toFriendlyError(err);
      set({ error: resolved.message });
      throw resolved;
    } finally {
      set({ sending: false });
    }
  },

  editDmMessage: async (messageId, content) => {
    const supabase = getSupabaseClientOrThrow();
    const clean = content.trim();
    if (!clean) throw new Error("A mensagem não pode ficar vazia.");

    const { data, error } = await supabase
      .from("direct_messages")
      .update({
        content: clean,
        edited_at: new Date().toISOString(),
      })
      .eq("id", messageId)
      .select("*")
      .single();

    if (error) throw toFriendlyError(error);

    set((prev) => {
      const list = prev.messagesByDm[data.dm_channel_id] ?? [];
      const updated = list.map((m) =>
        m.id === data.id
          ? { ...m, content: data.content, edited_at: data.edited_at }
          : m,
      );
      return {
        messagesByDm: {
          ...prev.messagesByDm,
          [data.dm_channel_id]: resolveDmReplyLinks(updated),
        },
      };
    });
  },

  deleteDmMessage: async (messageId) => {
    const supabase = getSupabaseClientOrThrow();
    const { error } = await supabase
      .from("direct_messages")
      .delete()
      .eq("id", messageId);
    if (error) throw toFriendlyError(error);

    set((prev) => {
      const nextByDm = { ...prev.messagesByDm };
      for (const [dmId, list] of Object.entries(nextByDm)) {
        if (list.some((m) => m.id === messageId)) {
          nextByDm[dmId] = resolveDmReplyLinks(
            list.filter((m) => m.id !== messageId),
          );
        }
      }
      return {
        messagesByDm: nextByDm,
        replyingToDm:
          prev.replyingToDm?.id === messageId ? null : prev.replyingToDm,
      };
    });
  },

  setReplyingToDm: (message) => {
    set({ replyingToDm: message });
  },

  startDirectCall: async ({
    dmChannelId,
    calleeId,
    calleeName,
    calleeAvatarUrl = null,
  }) => {
    const auth = useAuthStore.getState();
    const selfId = auth.user?.id;
    const selfProfile = auth.profile;
    if (!selfId) throw new Error("Faça login antes de iniciar uma chamada.");

    const roomId = makeDmVoiceRoomId(dmChannelId);
    const callId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    set({
      outgoingCall: {
        callId,
        dmChannelId,
        roomId,
        calleeId,
        calleeName,
        calleeAvatarUrl,
        startedAt: Date.now(),
        status: "ringing",
      },
    });

    // Join the private 1:1 LiveKit room immediately
    await useVoiceStore.getState().joinVoiceChannel({
      channelId: roomId,
      channelName: `Call • ${calleeName}`,
    });

    const ringPayload = {
      callId,
      dmChannelId,
      roomId,
      callerId: selfId,
      callerName:
        selfProfile?.display_name || selfProfile?.username || "Amigo",
      callerAvatarUrl: selfProfile?.avatar_url ?? null,
      callerAccentColor: selfProfile?.card_accent_color || "#B91C1C",
    };

    void sendDirectSignalToUser(calleeId, "dm_call_ring", ringPayload);

    if (outgoingTimeoutHandle) clearTimeout(outgoingTimeoutHandle);
    outgoingTimeoutHandle = setTimeout(() => {
      const curr = get().outgoingCall;
      if (curr && curr.callId === callId && curr.status === "ringing") {
        set({ outgoingCall: { ...curr, status: "missed" } });
        void sendDirectSignalToUser(calleeId, "dm_call_cancel", { callId });
        setTimeout(() => {
          set((prev) =>
            prev.outgoingCall?.callId === callId ? { outgoingCall: null } : prev,
          );
        }, 2200);
      }
    }, 35_000);
  },

  acceptIncomingCall: async () => {
    const call = get().incomingCall;
    if (!call) return null;
    if (incomingTimeoutHandle) {
      clearTimeout(incomingTimeoutHandle);
      incomingTimeoutHandle = null;
    }

    set({ incomingCall: null });
    void sendDirectSignalToUser(call.callerId, "dm_call_accept", {
      callId: call.callId,
    });

    await useVoiceStore.getState().joinVoiceChannel({
      channelId: call.roomId,
      channelName: `Call • ${call.callerName}`,
    });

    get().selectDmChannel(call.dmChannelId);
    return call.dmChannelId;
  },

  declineIncomingCall: async () => {
    const call = get().incomingCall;
    if (!call) return;
    if (incomingTimeoutHandle) {
      clearTimeout(incomingTimeoutHandle);
      incomingTimeoutHandle = null;
    }
    set({ incomingCall: null });
    void sendDirectSignalToUser(call.callerId, "dm_call_decline", {
      callId: call.callId,
    });
  },

  cancelOutgoingCall: async () => {
    const call = get().outgoingCall;
    if (!call) return;
    if (outgoingTimeoutHandle) {
      clearTimeout(outgoingTimeoutHandle);
      outgoingTimeoutHandle = null;
    }
    set({ outgoingCall: null });
    void sendDirectSignalToUser(call.calleeId, "dm_call_cancel", {
      callId: call.callId,
    });
    if (useVoiceStore.getState().activeVoiceChannelId === call.roomId) {
      await useVoiceStore.getState().leaveVoiceChannel();
    }
  },

  reset: async () => {
    await get().unbindSocialRealtime();
    set({
      friendships: [],
      dmChannels: [],
      activeDmChannelId: null,
      messagesByDm: {},
      hasMoreByDm: {},
      loadingByDm: {},
      isAtBottomByDm: {},
      unreadByDm: {},
      replyingToDm: null,
      profileCache: {},
      friendPresenceByUser: {},
      incomingCall: null,
      outgoingCall: null,
      loading: false,
      sending: false,
      error: null,
    });
  },
}));

// Keep friend/DM profiles fresh in real time whenever anyone updates their profile
onProfileRealtimeUpdate((updatedProfile) => {
  useFriendsStore.setState((prev) => {
    const nextCache = { ...prev.profileCache, [updatedProfile.id]: updatedProfile };
    const nextFriendships = prev.friendships.map((f) =>
      f.otherUser?.id === updatedProfile.id
        ? { ...f, otherUser: updatedProfile }
        : f,
    );
    const nextDms = prev.dmChannels.map((c) =>
      c.otherUserId === updatedProfile.id
        ? { ...c, otherUser: updatedProfile }
        : c,
    );
    let dmMsgsChanged = false;
    const nextMsgsByDm: Record<string, DirectMessageItem[]> = {};
    for (const [dmId, list] of Object.entries(prev.messagesByDm)) {
      let chChanged = false;
      const updatedList = list.map((m) => {
        if (m.author_id !== updatedProfile.id) return m;
        chChanged = true;
        return { ...m, author: updatedProfile };
      });
      nextMsgsByDm[dmId] = chChanged ? resolveDmReplyLinks(updatedList) : list;
      if (chChanged) dmMsgsChanged = true;
    }

    return {
      profileCache: nextCache,
      friendships: nextFriendships,
      dmChannels: nextDms,
      ...(dmMsgsChanged ? { messagesByDm: nextMsgsByDm } : {}),
    };
  });
});

// Clear "ringing" banner automatically as soon as callee joins the 1:1 LiveKit room
useVoiceStore.subscribe((voiceState) => {
  const outgoing = useFriendsStore.getState().outgoingCall;
  if (
    outgoing &&
    outgoing.status === "ringing" &&
    voiceState.activeVoiceChannelId === outgoing.roomId &&
    Boolean(voiceState.peers[outgoing.calleeId])
  ) {
    if (outgoingTimeoutHandle) {
      clearTimeout(outgoingTimeoutHandle);
      outgoingTimeoutHandle = null;
    }
    useFriendsStore.setState({ outgoingCall: null });
  }
});

// Sync local status/game changes to global friends presence automatically
usePresenceStore.subscribe((presState, prevPresState) => {
  if (
    presState.localStatus !== prevPresState.localStatus ||
    presState.currentGame !== prevPresState.currentGame
  ) {
    useFriendsStore
      .getState()
      .syncGlobalPresence(presState.localStatus, presState.currentGame);
  }
});
