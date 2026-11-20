import type { RealtimeChannel } from "@supabase/supabase-js";
import { create } from "zustand";
import type {
  Json,
  MessageAttachment,
  MessageRow,
  ProfileRow,
} from "../supabase/types";
import { getSupabaseClientOrThrow, useAuthStore } from "./useAuthStore";
import { onProfileRealtimeUpdate } from "./usePresenceStore";

const CHAT_PAGE_SIZE = 50;
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const REALTIME_FALLBACK_POLL_MS = 4_000;
const REALTIME_RETRY_BASE_MS = 1_500;
const REALTIME_RETRY_MAX_MS = 10_000;

const realtimePollTimers = new Map<string, ReturnType<typeof setInterval>>();
const realtimeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const realtimeDesiredChannels = new Set<string>();

function clearChannelTimers(channelId: string): void {
  const pollTimer = realtimePollTimers.get(channelId);
  if (pollTimer) {
    clearInterval(pollTimer);
    realtimePollTimers.delete(channelId);
  }
  const retryTimer = realtimeRetryTimers.get(channelId);
  if (retryTimer) {
    clearTimeout(retryTimer);
    realtimeRetryTimers.delete(channelId);
  }
}

export interface ChatMessage extends MessageRow {
  author: ProfileRow | null;
  parsed_attachments: MessageAttachment[];
  reply_to?: ChatMessage | null;
}

export interface ChannelUnreadState {
  count: number;
  firstUnreadMessageId: string | null;
  lastAuthorId: string | null;
  lastAuthorName: string | null;
  lastAuthorAvatarUrl: string | null;
  lastAuthorAccentColor: string | null;
}

export interface IncomingChatNotificationEvent {
  channelId: string;
  message: ChatMessage;
  isActiveChannel: boolean;
  isAtBottom: boolean;
}

type IncomingChatNotificationListener = (
  event: IncomingChatNotificationEvent,
) => void;

const incomingChatListeners = new Set<IncomingChatNotificationListener>();
const notifiedChatMessageIds = new Set<string>();

export function onIncomingChatNotification(
  listener: IncomingChatNotificationListener,
): () => void {
  incomingChatListeners.add(listener);
  return () => {
    incomingChatListeners.delete(listener);
  };
}

function emitIncomingChatNotifications(
  state: ChatState,
  channelId: string,
  incomingMessages: ChatMessage[],
  selfUserId: string | null,
): void {
  if (incomingChatListeners.size === 0 || incomingMessages.length === 0) return;

  const isActiveChannel = state.activeChannelId === channelId;
  const isAtBottom = state.isAtBottomByChannel[channelId] ?? true;

  for (const msg of incomingMessages) {
    if (selfUserId && msg.author_id === selfUserId) continue;
    if (notifiedChatMessageIds.has(msg.id)) continue;
    notifiedChatMessageIds.add(msg.id);
    if (notifiedChatMessageIds.size > 250) {
      const oldest = notifiedChatMessageIds.values().next().value;
      if (oldest) notifiedChatMessageIds.delete(oldest);
    }

    const event: IncomingChatNotificationEvent = {
      channelId,
      message: msg,
      isActiveChannel,
      isAtBottom,
    };
    for (const listener of incomingChatListeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }
}

interface ChatState {
  messagesByChannel: Record<string, ChatMessage[]>;
  hasMoreByChannel: Record<string, boolean>;
  loadingByChannel: Record<string, boolean>;
  replyingTo: ChatMessage | null;
  sending: boolean;
  error: string | null;
  activeSubscriptions: Record<string, RealtimeChannel>;
  realtimeStatusByChannel: Record<string, string>;
  profileCache: Record<string, ProfileRow>;
  activeChannelId: string | null;
  watchedTextChannelIds: string[];
  isAtBottomByChannel: Record<string, boolean>;
  unreadByChannel: Record<string, ChannelUnreadState>;
  serverUnreadSubscription: { serverId: string; channel: RealtimeChannel } | null;

  loadMessages: (channelId: string) => Promise<ChatMessage[]>;
  syncRecentMessages: (channelId: string) => Promise<void>;
  loadOlderMessages: (channelId: string) => Promise<ChatMessage[]>;
  sendMessage: (params: {
    channelId: string;
    content: string;
    replyToId?: string | null;
    files?: File[];
  }) => Promise<ChatMessage>;
  editMessage: (messageId: string, content: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  setReplyingTo: (message: ChatMessage | null) => void;
  setActiveChannelId: (channelId: string | null) => void;
  setChannelAtBottom: (channelId: string, isAtBottom: boolean) => void;
  markChannelRead: (channelId: string) => void;
  watchServerTextChannels: (serverId: string | null, channelIds: string[]) => void;
  subscribeChannel: (channelId: string, attempt?: number) => void;
  unsubscribeChannel: (channelId: string) => Promise<void>;
  unsubscribeAll: () => Promise<void>;
}

function applyIncomingMessagesUnread(
  prev: ChatState,
  channelId: string,
  incomingMessages: ChatMessage[],
  selfUserId: string | null,
): Record<string, ChannelUnreadState> {
  if (incomingMessages.length === 0) return prev.unreadByChannel;

  const isViewingAtBottom =
    prev.activeChannelId === channelId &&
    (prev.isAtBottomByChannel[channelId] ?? true);
  if (isViewingAtBottom) {
    return prev.unreadByChannel;
  }

  const fromOthers = incomingMessages.filter(
    (m) => !selfUserId || m.author_id !== selfUserId,
  );
  if (fromOthers.length === 0) {
    return prev.unreadByChannel;
  }

  const existingUnread = prev.unreadByChannel[channelId];
  const firstId = existingUnread?.firstUnreadMessageId ?? fromOthers[0].id;
  const latestMsg = fromOthers[fromOthers.length - 1];
  const latestName =
    latestMsg.author?.display_name ??
    latestMsg.author?.username ??
    latestMsg.author_id.slice(0, 8);

  return {
    ...prev.unreadByChannel,
    [channelId]: {
      count: (existingUnread?.count ?? 0) + fromOthers.length,
      firstUnreadMessageId: firstId,
      lastAuthorId: latestMsg.author_id,
      lastAuthorName: latestName,
      lastAuthorAvatarUrl: latestMsg.author?.avatar_url ?? null,
      lastAuthorAccentColor: latestMsg.author?.card_accent_color ?? null,
    },
  };
}

function parseAttachments(raw: Json): MessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, Json> => typeof item === "object" && item !== null)
    .map((item) => ({
      name: String(item.name ?? "arquivo"),
      url: String(item.url ?? ""),
      path: String(item.path ?? ""),
      mime_type: String(item.mime_type ?? "application/octet-stream"),
      size: Number(item.size ?? 0),
    }))
    .filter((a) => Boolean(a.url));
}

function resolveReplyLinks(messages: ChatMessage[]): ChatMessage[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return messages.map((m) => ({
    ...m,
    reply_to: m.reply_to_id ? byId.get(m.reply_to_id) ?? null : null,
  }));
}

async function fetchProfileCached(
  authorId: string,
  cache: Record<string, ProfileRow>,
): Promise<ProfileRow | null> {
  if (cache[authorId]) return cache[authorId];
  const supabase = getSupabaseClientOrThrow();
  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", authorId)
    .maybeSingle();
  return data ?? null;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messagesByChannel: {},
  hasMoreByChannel: {},
  loadingByChannel: {},
  replyingTo: null,
  sending: false,
  error: null,
  activeSubscriptions: {},
  realtimeStatusByChannel: {},
  profileCache: {},
  activeChannelId: null,
  watchedTextChannelIds: [],
  isAtBottomByChannel: {},
  unreadByChannel: {},
  serverUnreadSubscription: null,

  syncRecentMessages: async (channelId) => {
    try {
      const supabase = getSupabaseClientOrThrow();
      const { data, error } = await supabase
        .from("messages")
        .select("*, author:profiles!messages_author_id_fkey(*)")
        .eq("channel_id", channelId)
        .order("created_at", { ascending: false })
        .limit(CHAT_PAGE_SIZE);

      if (error || !data) return;

      const recentRows = [...data].reverse();
      const cachePatch: Record<string, ProfileRow> = {};

      const recentHydrated: ChatMessage[] = recentRows.map((row) => {
        const rawAuthor = (row as { author?: ProfileRow | ProfileRow[] | null }).author;
        const author = Array.isArray(rawAuthor) ? rawAuthor[0] ?? null : rawAuthor ?? null;
        if (author) {
          cachePatch[author.id] = author;
        }
        return {
          id: row.id,
          channel_id: row.channel_id,
          author_id: row.author_id,
          content: row.content,
          reply_to_id: row.reply_to_id,
          attachments: row.attachments,
          edited_at: row.edited_at,
          created_at: row.created_at,
          author,
          parsed_attachments: parseAttachments(row.attachments),
        };
      });

      const selfUserId = useAuthStore.getState().user?.id ?? null;
      let arrivedForNotify: ChatMessage[] = [];
      let snapshotForNotify: ChatState | null = null;

      set((prev) => {
        const existing = prev.messagesByChannel[channelId] ?? [];
        const existingIds = new Set(existing.map((m) => m.id));
        const lastExistingAt =
          existing.length > 0 ? existing[existing.length - 1].created_at : null;
        const newlyArrived = lastExistingAt
          ? recentHydrated.filter(
              (m) => !existingIds.has(m.id) && m.created_at >= lastExistingAt,
            )
          : [];
        arrivedForNotify = newlyArrived;
        snapshotForNotify = prev;
        const recentById = new Map(recentHydrated.map((m) => [m.id, m]));
        const preservedOlder = existing.filter(
          (m) =>
            !recentById.has(m.id) &&
            (recentHydrated.length === 0 || m.created_at < recentHydrated[0].created_at),
        );
        const merged = resolveReplyLinks([...preservedOlder, ...recentHydrated]);
        return {
          profileCache: { ...prev.profileCache, ...cachePatch },
          messagesByChannel: {
            ...prev.messagesByChannel,
            [channelId]: merged,
          },
          unreadByChannel: applyIncomingMessagesUnread(
            prev,
            channelId,
            newlyArrived,
            selfUserId,
          ),
        };
      });

      if (snapshotForNotify && arrivedForNotify.length > 0) {
        emitIncomingChatNotifications(
          snapshotForNotify,
          channelId,
          arrivedForNotify,
          selfUserId,
        );
      }
    } catch {
      // Background fallback sync must never interrupt the active chat UI
    }
  },

  loadMessages: async (channelId) => {
    const supabase = getSupabaseClientOrThrow();
    set((prev) => ({
      loadingByChannel: { ...prev.loadingByChannel, [channelId]: true },
      error: null,
    }));

    try {
      const { data, error } = await supabase
        .from("messages")
        .select("*, author:profiles!messages_author_id_fkey(*)")
        .eq("channel_id", channelId)
        .order("created_at", { ascending: false })
        .limit(CHAT_PAGE_SIZE);

      if (error) throw error;

      const rows = (data ?? []).reverse();
      const cachePatch: Record<string, ProfileRow> = {};

      const hydrated: ChatMessage[] = rows.map((row) => {
        const rawAuthor = (row as { author?: ProfileRow | ProfileRow[] | null }).author;
        const author = Array.isArray(rawAuthor) ? rawAuthor[0] ?? null : rawAuthor ?? null;
        if (author) {
          cachePatch[author.id] = author;
        }
        return {
          id: row.id,
          channel_id: row.channel_id,
          author_id: row.author_id,
          content: row.content,
          reply_to_id: row.reply_to_id,
          attachments: row.attachments,
          edited_at: row.edited_at,
          created_at: row.created_at,
          author,
          parsed_attachments: parseAttachments(row.attachments),
        };
      });

      const withReplies = resolveReplyLinks(hydrated);
      set((prev) => ({
        messagesByChannel: { ...prev.messagesByChannel, [channelId]: withReplies },
        hasMoreByChannel: {
          ...prev.hasMoreByChannel,
          [channelId]: rows.length === CHAT_PAGE_SIZE,
        },
        profileCache: { ...prev.profileCache, ...cachePatch },
      }));
      return withReplies;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    } finally {
      set((prev) => ({
        loadingByChannel: { ...prev.loadingByChannel, [channelId]: false },
      }));
    }
  },

  loadOlderMessages: async (channelId) => {
    const current = get().messagesByChannel[channelId] ?? [];
    if (current.length === 0 || get().loadingByChannel[channelId]) {
      return current;
    }
    const oldest = current[0];
    const supabase = getSupabaseClientOrThrow();

    set((prev) => ({
      loadingByChannel: { ...prev.loadingByChannel, [channelId]: true },
    }));

    try {
      const { data, error } = await supabase
        .from("messages")
        .select("*, author:profiles!messages_author_id_fkey(*)")
        .eq("channel_id", channelId)
        .lt("created_at", oldest.created_at)
        .order("created_at", { ascending: false })
        .limit(CHAT_PAGE_SIZE);

      if (error) throw error;

      const rows = (data ?? []).reverse();
      const cachePatch: Record<string, ProfileRow> = {};

      const older: ChatMessage[] = rows.map((row) => {
        const rawAuthor = (row as { author?: ProfileRow | ProfileRow[] | null }).author;
        const author = Array.isArray(rawAuthor) ? rawAuthor[0] ?? null : rawAuthor ?? null;
        if (author) {
          cachePatch[author.id] = author;
        }
        return {
          id: row.id,
          channel_id: row.channel_id,
          author_id: row.author_id,
          content: row.content,
          reply_to_id: row.reply_to_id,
          attachments: row.attachments,
          edited_at: row.edited_at,
          created_at: row.created_at,
          author,
          parsed_attachments: parseAttachments(row.attachments),
        };
      });

      const merged = resolveReplyLinks([...older, ...current]);
      set((prev) => ({
        messagesByChannel: { ...prev.messagesByChannel, [channelId]: merged },
        hasMoreByChannel: {
          ...prev.hasMoreByChannel,
          [channelId]: rows.length === CHAT_PAGE_SIZE,
        },
        profileCache: { ...prev.profileCache, ...cachePatch },
      }));
      return merged;
    } finally {
      set((prev) => ({
        loadingByChannel: { ...prev.loadingByChannel, [channelId]: false },
      }));
    }
  },

  sendMessage: async ({ channelId, content, replyToId, files = [] }) => {
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
        if (file.size > ATTACHMENT_MAX_BYTES) {
          throw new Error(`Anexo "${file.name}" excede o limite de 25 MB.`);
        }
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${user.id}/${channelId}/${Date.now()}-${safeName}`;

        const { error: uploadError } = await supabase.storage
          .from("attachments")
          .upload(path, file, {
            contentType: file.type || "application/octet-stream",
            upsert: false,
          });
        if (uploadError) {
          throw new Error(`Erro ao enviar anexo "${file.name}": ${uploadError.message}`);
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

      const effectiveReplyId = replyToId ?? get().replyingTo?.id ?? null;

      const { data, error } = await supabase
        .from("messages")
        .insert({
          channel_id: channelId,
          author_id: user.id,
          content: cleanContent,
          reply_to_id: effectiveReplyId,
          attachments: uploaded as unknown as Json,
        })
        .select("*")
        .single();

      if (error) throw error;

      const msg: ChatMessage = {
        ...data,
        author: profile ?? null,
        parsed_attachments: uploaded,
      };

      set((prev) => {
        const list = prev.messagesByChannel[channelId] ?? [];
        const deduped = list.some((m) => m.id === msg.id)
          ? list
          : [...list, msg];
        return {
          messagesByChannel: {
            ...prev.messagesByChannel,
            [channelId]: resolveReplyLinks(deduped),
          },
          replyingTo: null,
        };
      });

      return msg;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    } finally {
      set({ sending: false });
    }
  },

  editMessage: async (messageId, content) => {
    const supabase = getSupabaseClientOrThrow();
    const clean = content.trim();
    if (!clean) throw new Error("A mensagem não pode ficar vazia.");

    const { data, error } = await supabase
      .from("messages")
      .update({
        content: clean,
        edited_at: new Date().toISOString(),
      })
      .eq("id", messageId)
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    set((prev) => {
      const channelMessages = prev.messagesByChannel[data.channel_id] ?? [];
      const updated = channelMessages.map((m) =>
        m.id === data.id
          ? { ...m, content: data.content, edited_at: data.edited_at }
          : m,
      );
      return {
        messagesByChannel: {
          ...prev.messagesByChannel,
          [data.channel_id]: resolveReplyLinks(updated),
        },
      };
    });
  },

  deleteMessage: async (messageId) => {
    const supabase = getSupabaseClientOrThrow();
    const { error } = await supabase
      .from("messages")
      .delete()
      .eq("id", messageId);

    if (error) throw new Error(error.message);

    set((prev) => {
      const nextByChannel = { ...prev.messagesByChannel };
      for (const [channelId, list] of Object.entries(nextByChannel)) {
        if (list.some((m) => m.id === messageId)) {
          nextByChannel[channelId] = resolveReplyLinks(
            list.filter((m) => m.id !== messageId),
          );
        }
      }
      return {
        messagesByChannel: nextByChannel,
        replyingTo:
          prev.replyingTo?.id === messageId ? null : prev.replyingTo,
      };
    });
  },

  setReplyingTo: (message) => {
    set({ replyingTo: message });
  },

  setActiveChannelId: (channelId) => {
    set((prev) => ({
      activeChannelId: channelId,
      isAtBottomByChannel: channelId
        ? { ...prev.isAtBottomByChannel, [channelId]: prev.isAtBottomByChannel[channelId] ?? true }
        : prev.isAtBottomByChannel,
    }));
  },

  setChannelAtBottom: (channelId, isAtBottom) => {
    set((prev) => {
      if (prev.isAtBottomByChannel[channelId] === isAtBottom) return prev;
      return {
        isAtBottomByChannel: {
          ...prev.isAtBottomByChannel,
          [channelId]: isAtBottom,
        },
      };
    });
  },

  markChannelRead: (channelId) => {
    set((prev) => {
      if (!prev.unreadByChannel[channelId]) return prev;
      const nextUnread = { ...prev.unreadByChannel };
      delete nextUnread[channelId];
      return { unreadByChannel: nextUnread };
    });
  },

  watchServerTextChannels: (serverId, channelIds) => {
    const uniqueIds = Array.from(new Set(channelIds));
    const current = get().serverUnreadSubscription;

    if (
      current &&
      current.serverId === serverId &&
      uniqueIds.length > 0
    ) {
      set({ watchedTextChannelIds: uniqueIds });
      return;
    }

    if (current) {
      const supabase = getSupabaseClientOrThrow();
      void supabase.removeChannel(current.channel).catch(() => {});
      set({ serverUnreadSubscription: null });
    }

    set({ watchedTextChannelIds: uniqueIds });

    if (!serverId || uniqueIds.length === 0) {
      return;
    }

    const supabase = getSupabaseClientOrThrow();
    const accessToken = useAuthStore.getState().session?.access_token;
    if (accessToken) {
      void supabase.realtime.setAuth(accessToken);
    }

    const watcherChannel = supabase
      .channel(`chat:server-unread:${serverId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
        },
        async (payload) => {
          const row = payload.new as MessageRow;
          const state = get();
          if (!state.watchedTextChannelIds.includes(row.channel_id)) return;
          if (state.activeSubscriptions[row.channel_id]) return;

          const selfUserId = useAuthStore.getState().user?.id ?? null;
          const author = await fetchProfileCached(
            row.author_id,
            get().profileCache,
          );
          const nextMsg: ChatMessage = {
            ...row,
            author,
            parsed_attachments: parseAttachments(row.attachments),
          };

          let shouldNotify = false;
          let snapshotBefore: ChatState | null = null;

          set((prev) => {
            const existing = prev.messagesByChannel[row.channel_id];
            const alreadyKnown =
              existing?.some((m) => m.id === nextMsg.id) ?? false;
            shouldNotify = !alreadyKnown;
            snapshotBefore = prev;
            const nextCache = author
              ? { ...prev.profileCache, [author.id]: author }
              : prev.profileCache;
            const nextUnread = alreadyKnown
              ? prev.unreadByChannel
              : applyIncomingMessagesUnread(
                  prev,
                  row.channel_id,
                  [nextMsg],
                  selfUserId,
                );
            const nextMessagesByChannel =
              existing && !alreadyKnown
                ? {
                    ...prev.messagesByChannel,
                    [row.channel_id]: resolveReplyLinks([...existing, nextMsg]),
                  }
                : prev.messagesByChannel;

            return {
              profileCache: nextCache,
              messagesByChannel: nextMessagesByChannel,
              unreadByChannel: nextUnread,
            };
          });

          if (shouldNotify && snapshotBefore) {
            emitIncomingChatNotifications(
              snapshotBefore,
              row.channel_id,
              [nextMsg],
              selfUserId,
            );
          }
        },
      )
      .subscribe();

    set({
      serverUnreadSubscription: {
        serverId,
        channel: watcherChannel,
      },
    });
  },

  subscribeChannel: (channelId, attempt = 0) => {
    realtimeDesiredChannels.add(channelId);
    if (get().activeSubscriptions[channelId]) return;

    const supabase = getSupabaseClientOrThrow();

    const startFallbackPolling = () => {
      if (realtimePollTimers.has(channelId)) return;
      const pollId = setInterval(() => {
        if (!realtimeDesiredChannels.has(channelId)) {
          clearChannelTimers(channelId);
          return;
        }
        if (get().realtimeStatusByChannel[channelId] !== "SUBSCRIBED") {
          void get().syncRecentMessages(channelId);
        }
      }, REALTIME_FALLBACK_POLL_MS);
      realtimePollTimers.set(channelId, pollId);
    };

    const stopFallbackPolling = () => {
      const pollId = realtimePollTimers.get(channelId);
      if (pollId) {
        clearInterval(pollId);
        realtimePollTimers.delete(channelId);
      }
    };

    startFallbackPolling();

    const accessToken = useAuthStore.getState().session?.access_token;
    if (accessToken) {
      void supabase.realtime.setAuth(accessToken);
    } else {
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session?.access_token) {
          void supabase.realtime.setAuth(data.session.access_token);
        }
      });
    }

    const channel = supabase
      .channel(`chat:channel:${channelId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `channel_id=eq.${channelId}`,
        },
        async (payload) => {
          const row = payload.new as MessageRow;
          const author = await fetchProfileCached(
            row.author_id,
            get().profileCache,
          );

          const nextMsg: ChatMessage = {
            ...row,
            author,
            parsed_attachments: parseAttachments(row.attachments),
          };

          const selfUserId = useAuthStore.getState().user?.id ?? null;
          let shouldNotify = false;
          let snapshotBefore: ChatState | null = null;

          set((prev) => {
            const list = prev.messagesByChannel[channelId] ?? [];
            if (list.some((m) => m.id === nextMsg.id)) {
              return prev;
            }
            shouldNotify = true;
            snapshotBefore = prev;
            const nextCache = author
              ? { ...prev.profileCache, [author.id]: author }
              : prev.profileCache;
            return {
              profileCache: nextCache,
              messagesByChannel: {
                ...prev.messagesByChannel,
                [channelId]: resolveReplyLinks([...list, nextMsg]),
              },
              unreadByChannel: applyIncomingMessagesUnread(
                prev,
                channelId,
                [nextMsg],
                selfUserId,
              ),
            };
          });

          if (shouldNotify && snapshotBefore) {
            emitIncomingChatNotifications(
              snapshotBefore,
              channelId,
              [nextMsg],
              selfUserId,
            );
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const row = payload.new as MessageRow;
          set((prev) => {
            const list = prev.messagesByChannel[channelId] ?? [];
            const updated = list.map((m) =>
              m.id === row.id
                ? {
                    ...m,
                    content: row.content,
                    edited_at: row.edited_at,
                    attachments: row.attachments,
                    parsed_attachments: parseAttachments(row.attachments),
                  }
                : m,
            );
            return {
              messagesByChannel: {
                ...prev.messagesByChannel,
                [channelId]: resolveReplyLinks(updated),
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
          table: "messages",
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const deletedId = (payload.old as { id?: string } | null)?.id;
          if (!deletedId) return;
          set((prev) => {
            const list = prev.messagesByChannel[channelId] ?? [];
            if (!list.some((m) => m.id === deletedId)) return prev;
            const filtered = list.filter((m) => m.id !== deletedId);
            let nextUnreadByChannel = prev.unreadByChannel;
            const currentUnread = prev.unreadByChannel[channelId];
            if (currentUnread && currentUnread.firstUnreadMessageId === deletedId) {
              const deletedIdx = list.findIndex((m) => m.id === deletedId);
              const nextFirst = filtered[deletedIdx] ?? null;
              if (!nextFirst) {
                nextUnreadByChannel = { ...prev.unreadByChannel };
                delete nextUnreadByChannel[channelId];
              } else {
                nextUnreadByChannel = {
                  ...prev.unreadByChannel,
                  [channelId]: {
                    ...currentUnread,
                    count: Math.max(0, currentUnread.count - 1),
                    firstUnreadMessageId: nextFirst.id,
                  },
                };
              }
            }
            return {
              messagesByChannel: {
                ...prev.messagesByChannel,
                [channelId]: resolveReplyLinks(filtered),
              },
              unreadByChannel: nextUnreadByChannel,
              replyingTo:
                prev.replyingTo?.id === deletedId ? null : prev.replyingTo,
            };
          });
        },
      )
      .subscribe((status) => {
        set((prev) => ({
          realtimeStatusByChannel: {
            ...prev.realtimeStatusByChannel,
            [channelId]: status,
          },
        }));

        if (status === "SUBSCRIBED") {
          stopFallbackPolling();
          const retryId = realtimeRetryTimers.get(channelId);
          if (retryId) {
            clearTimeout(retryId);
            realtimeRetryTimers.delete(channelId);
          }
          if (attempt > 0) {
            void get().syncRecentMessages(channelId);
          }
          return;
        }

        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          startFallbackPolling();
          void get().syncRecentMessages(channelId);

          if (!realtimeDesiredChannels.has(channelId) || realtimeRetryTimers.has(channelId)) {
            return;
          }

          const delay = Math.min(
            REALTIME_RETRY_MAX_MS,
            REALTIME_RETRY_BASE_MS * Math.pow(2, Math.min(attempt, 3)),
          );
          const timer = setTimeout(() => {
            realtimeRetryTimers.delete(channelId);
            if (!realtimeDesiredChannels.has(channelId)) return;

            const currentChannel = get().activeSubscriptions[channelId];
            set((prev) => {
              const nextSubs = { ...prev.activeSubscriptions };
              delete nextSubs[channelId];
              return { activeSubscriptions: nextSubs };
            });

            const finishResubscribe = () => {
              if (realtimeDesiredChannels.has(channelId)) {
                get().subscribeChannel(channelId, attempt + 1);
              }
            };

            if (currentChannel) {
              void supabase
                .removeChannel(currentChannel)
                .catch(() => {})
                .finally(finishResubscribe);
            } else {
              finishResubscribe();
            }
          }, delay);

          realtimeRetryTimers.set(channelId, timer);
        }
      });

    set((prev) => ({
      activeSubscriptions: {
        ...prev.activeSubscriptions,
        [channelId]: channel,
      },
      realtimeStatusByChannel: {
        ...prev.realtimeStatusByChannel,
        [channelId]: "JOINING",
      },
    }));
  },

  unsubscribeChannel: async (channelId) => {
    realtimeDesiredChannels.delete(channelId);
    clearChannelTimers(channelId);

    const channel = get().activeSubscriptions[channelId];
    set((prev) => {
      const nextSubs = { ...prev.activeSubscriptions };
      const nextStatus = { ...prev.realtimeStatusByChannel };
      delete nextSubs[channelId];
      delete nextStatus[channelId];
      return {
        activeSubscriptions: nextSubs,
        realtimeStatusByChannel: nextStatus,
      };
    });

    if (channel) {
      const supabase = getSupabaseClientOrThrow();
      await supabase.removeChannel(channel);
    }
  },

  unsubscribeAll: async () => {
    for (const channelId of Array.from(realtimeDesiredChannels)) {
      clearChannelTimers(channelId);
    }
    realtimeDesiredChannels.clear();

    const subs = Object.values(get().activeSubscriptions);
    const serverUnreadSub = get().serverUnreadSubscription?.channel ?? null;
    if (subs.length > 0 || serverUnreadSub) {
      const supabase = getSupabaseClientOrThrow();
      await Promise.all([
        ...subs.map((c) => supabase.removeChannel(c)),
        ...(serverUnreadSub ? [supabase.removeChannel(serverUnreadSub)] : []),
      ]);
    }
    set({
      activeSubscriptions: {},
      realtimeStatusByChannel: {},
      serverUnreadSubscription: null,
      watchedTextChannelIds: [],
      activeChannelId: null,
      isAtBottomByChannel: {},
      unreadByChannel: {},
    });
  },
}));

onProfileRealtimeUpdate((updatedProfile) => {
  useChatStore.setState((prev) => {
    const nextCache = {
      ...prev.profileCache,
      [updatedProfile.id]: updatedProfile,
    };
    let msgsChanged = false;
    const nextByChannel: Record<string, ChatMessage[]> = {};
    for (const [channelId, list] of Object.entries(prev.messagesByChannel)) {
      let channelChanged = false;
      const updatedList = list.map((msg) => {
        if (msg.author_id !== updatedProfile.id) return msg;
        channelChanged = true;
        return {
          ...msg,
          author: updatedProfile,
        };
      });
      nextByChannel[channelId] = channelChanged
        ? resolveReplyLinks(updatedList)
        : list;
      if (channelChanged) msgsChanged = true;
    }
    return {
      profileCache: nextCache,
      ...(msgsChanged ? { messagesByChannel: nextByChannel } : {}),
    };
  });
});
