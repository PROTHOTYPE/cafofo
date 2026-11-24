import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  useAuthStore,
  useChatStore,
  useServerStore,
  type ChannelRow,
  type ChatMessage,
  type MessageAttachment,
  type ServerMemberWithProfile,
  type ServerRoleRow,
} from "@cafofo/core-logic";
import {
  ArrowDown,
  Check,
  Copy,
  CornerDownRight,
  ExternalLink,
  FileText,
  Film,
  Hash,
  History,
  Image as ImageIcon,
  Maximize2,
  PanelLeft,
  PanelTopClose,
  Paperclip,
  Pencil,
  Reply,
  SendHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { copyPlainText } from "../lib/clipboard";
import { Modal } from "./Modal";
import { AvatarWithFrame } from "./ProfileCardPreview";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_MEMBERS: ServerMemberWithProfile[] = [];
const EMPTY_ROLES: ServerRoleRow[] = [];
const GROUP_WINDOW_MS = 5 * 60 * 1000;

interface AuthorRoleBadge {
  label: string;
  color: string;
}

function isHexColor6(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function resolveAuthorRoleBadge(params: {
  authorId: string;
  member: ServerMemberWithProfile | undefined;
  ownerId: string | undefined;
  rolesById: Map<string, ServerRoleRow>;
  authorBadgeText?: string | null;
  authorBadgeColor?: string | null;
}): AuthorRoleBadge | null {
  const {
    authorId,
    member,
    ownerId,
    rolesById,
    authorBadgeText,
    authorBadgeColor,
  } = params;
  const assignedRole =
    member?.custom_role ??
    (member?.role_id ? (rolesById.get(member.role_id) ?? null) : null);
  if (assignedRole) {
    return {
      label: assignedRole.name,
      color: assignedRole.color || "#B91C1C",
    };
  }
  if (ownerId === authorId || member?.role === "owner") {
    return { label: "DONO", color: "#EF4444" };
  }
  if (member?.role === "admin") {
    return { label: "ADMIN", color: "#EF4444" };
  }
  if (authorBadgeText?.trim()) {
    return {
      label: authorBadgeText.trim(),
      color: authorBadgeColor || "#B91C1C",
    };
  }
  return null;
}

function isImageAttachment(att: MessageAttachment): boolean {
  if (att.mime_type?.toLowerCase().startsWith("image/")) return true;
  return /\.(png|jpe?g|webp|gif|avif|svg)(\?.*)?$/i.test(
    `${att.name} ${att.url}`,
  );
}

function isVideoAttachment(att: MessageAttachment): boolean {
  if (att.mime_type?.toLowerCase().startsWith("video/")) return true;
  return /\.(mp4|webm|mov)(\?.*)?$/i.test(`${att.name} ${att.url}`);
}

function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "1 KB";
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

interface ChatPanelProps {
  channel: ChannelRow | null;
  activeServerName?: string | null;
  onlineCount?: number;
  canModerateMessages?: boolean;
  onOpenLeftDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  onCollapseChat?: () => void;
}

export function ChatPanel({
  channel,
  activeServerName,
  onlineCount = 0,
  canModerateMessages = false,
  onOpenLeftDrawer,
  onOpenRightDrawer,
  onCollapseChat,
}: ChatPanelProps) {
  const userId = useAuthStore((s) => s.user?.id);
  const servers = useServerStore((s) => s.servers);
  const serverMembers = useServerStore((s) =>
    channel
      ? (s.membersByServer[channel.server_id] ?? EMPTY_MEMBERS)
      : EMPTY_MEMBERS,
  );
  const serverRoles = useServerStore((s) =>
    channel
      ? (s.rolesByServer[channel.server_id] ?? EMPTY_ROLES)
      : EMPTY_ROLES,
  );
  const activeServer = useMemo(
    () => (channel ? servers.find((s) => s.id === channel.server_id) ?? null : null),
    [channel, servers],
  );
  const memberByUserId = useMemo(
    () => new Map(serverMembers.map((m) => [m.user_id, m])),
    [serverMembers],
  );
  const rolesById = useMemo(
    () => new Map(serverRoles.map((r) => [r.id, r])),
    [serverRoles],
  );

  const messages = useChatStore((s) =>
    channel
      ? (s.messagesByChannel[channel.id] ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
  );
  const hasMore = useChatStore((s) =>
    channel ? Boolean(s.hasMoreByChannel[channel.id]) : false,
  );
  const loading = useChatStore((s) =>
    channel ? Boolean(s.loadingByChannel[channel.id]) : false,
  );
  const unreadState = useChatStore((s) =>
    channel ? (s.unreadByChannel[channel.id] ?? null) : null,
  );
  const replyingTo = useChatStore((s) => s.replyingTo);
  const sending = useChatStore((s) => s.sending);
  const chatError = useChatStore((s) => s.error);

  const loadMessages = useChatStore((s) => s.loadMessages);
  const loadOlderMessages = useChatStore((s) => s.loadOlderMessages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const editMessage = useChatStore((s) => s.editMessage);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const setReplyingTo = useChatStore((s) => s.setReplyingTo);
  const setActiveChannelId = useChatStore((s) => s.setActiveChannelId);
  const setChannelAtBottom = useChatStore((s) => s.setChannelAtBottom);
  const markChannelRead = useChatStore((s) => s.markChannelRead);
  const subscribeChannel = useChatStore((s) => s.subscribeChannel);
  const unsubscribeChannel = useChatStore((s) => s.unsubscribeChannel);

  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChatMessage | null>(null);
  const [expandedImage, setExpandedImage] = useState<MessageAttachment | null>(
    null,
  );
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [readyChannelId, setReadyChannelId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(
    null,
  );
  const [jumpingToReplyId, setJumpingToReplyId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const unreadMarkerRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const initialScrollChannelRef = useRef<string | null>(null);
  const lastSeenTailIdRef = useRef<string | null>(null);
  const programmaticScrollUntilRef = useRef<number>(0);

  const channelId = channel?.id ?? null;

  useEffect(() => {
    if (!channelId) {
      setActiveChannelId(null);
      setReadyChannelId(null);
      return;
    }

    let cancelled = false;
    initialScrollChannelRef.current = null;
    lastSeenTailIdRef.current = null;
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setReadyChannelId(null);
    setActiveChannelId(channelId);
    setChannelAtBottom(channelId, true);

    void loadMessages(channelId)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setReadyChannelId(channelId);
        }
      });
    subscribeChannel(channelId);

    return () => {
      cancelled = true;
      if (isAtBottomRef.current) {
        markChannelRead(channelId);
      }
      if (useChatStore.getState().activeChannelId === channelId) {
        setActiveChannelId(null);
      }
      void unsubscribeChannel(channelId);
    };
  }, [
    channelId,
    loadMessages,
    markChannelRead,
    setActiveChannelId,
    setChannelAtBottom,
    subscribeChannel,
    unsubscribeChannel,
  ]);

  useEffect(() => {
    if (!channelId || readyChannelId !== channelId) return;
    const container = feedRef.current;
    if (!container) return;

    if (initialScrollChannelRef.current !== channelId) {
      initialScrollChannelRef.current = channelId;
      lastSeenTailIdRef.current =
        messages.length > 0 ? messages[messages.length - 1].id : null;

      requestAnimationFrame(() => {
        const el = feedRef.current;
        if (!el) return;
        programmaticScrollUntilRef.current = Date.now() + 250;
        if (unreadState?.firstUnreadMessageId && unreadMarkerRef.current) {
          unreadMarkerRef.current.scrollIntoView({ block: "center" });
        } else {
          el.scrollTop = el.scrollHeight;
        }
        const atBottomNow =
          el.scrollHeight - el.scrollTop - el.clientHeight <= 100;
        isAtBottomRef.current = atBottomNow;
        setIsAtBottom(atBottomNow);
        setChannelAtBottom(channelId, atBottomNow);
      });
      return;
    }

    const tailMsg = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!tailMsg || tailMsg.id === lastSeenTailIdRef.current) {
      return;
    }
    lastSeenTailIdRef.current = tailMsg.id;

    if (tailMsg.author_id === userId || isAtBottomRef.current) {
      requestAnimationFrame(() => {
        const el = feedRef.current;
        if (!el) return;
        programmaticScrollUntilRef.current = Date.now() + 250;
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        isAtBottomRef.current = true;
        setIsAtBottom(true);
        setChannelAtBottom(channelId, true);
      });
      markChannelRead(channelId);
    }
  }, [
    channelId,
    markChannelRead,
    messages,
    readyChannelId,
    setChannelAtBottom,
    unreadState?.firstUnreadMessageId,
    userId,
  ]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  if (!channel) {
    return (
      <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#16161C] text-[#A1A1AA] select-none">
        <header className="h-14 px-3 sm:px-5 crimson-header-glow crimson-header-animated-border hairline-b flex items-center justify-between gap-2 shrink-0 md:hidden">
          <button
            type="button"
            onClick={onOpenLeftDrawer}
            className="min-h-[40px] min-w-[40px] px-2 rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center justify-center"
            aria-label="Abrir servidores e canais"
          >
            <PanelLeft className="w-4 h-4" strokeWidth={1.5} />
          </button>
          <span className="text-xs font-semibold text-[#FAFAFA] truncate">
            {activeServerName ?? "Cafofo"}
          </span>
          <button
            type="button"
            onClick={onOpenRightDrawer}
            className="min-h-[40px] px-2.5 rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center gap-1.5 font-mono text-[11px]"
            aria-label="Abrir membros"
          >
            <Users className="w-4 h-4" strokeWidth={1.5} />
            <span>{onlineCount}</span>
          </button>
        </header>

        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center animate-cyber-slide">
          <div className="w-12 h-12 rounded-2xl bg-[#101014] hairline-box flex items-center justify-center mb-3">
            <Hash className="w-5 h-5 text-[#B91C1C]" strokeWidth={1.5} />
          </div>
          <p className="text-sm font-medium text-[#FAFAFA]">
            Nenhum canal de texto selecionado
          </p>
          <p className="text-xs text-[#71717A] mt-1">
            Escolha um canal na barra lateral ou crie um novo para iniciar a conversa.
          </p>
        </div>
      </main>
    );
  }

  const handleFeedScroll = () => {
    const el = feedRef.current;
    if (!el || !channel) return;
    const atBottomNow =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 100;
    isAtBottomRef.current = atBottomNow;
    setIsAtBottom(atBottomNow);
    setChannelAtBottom(channel.id, atBottomNow);
    if (
      atBottomNow &&
      Date.now() > programmaticScrollUntilRef.current &&
      unreadState &&
      unreadState.count > 0
    ) {
      markChannelRead(channel.id);
    }
  };

  const handleJumpToBottom = () => {
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setChannelAtBottom(channel.id, true);
    markChannelRead(channel.id);
    const el = feedRef.current;
    if (!el) return;
    programmaticScrollUntilRef.current = Date.now() + 250;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const handleJumpToMessage = async (targetMessageId: string) => {
    if (!channel) return;
    const findNode = (): HTMLElement | null => {
      const container = feedRef.current;
      if (!container) return null;
      const nodes = container.querySelectorAll<HTMLElement>("[data-message-id]");
      for (const node of nodes) {
        if (node.dataset.messageId === targetMessageId) {
          return node;
        }
      }
      return null;
    };

    const focusNode = (node: HTMLElement) => {
      programmaticScrollUntilRef.current = Date.now() + 450;
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedMessageId(null);
      requestAnimationFrame(() => {
        setHighlightedMessageId(targetMessageId);
      });
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedMessageId((curr) =>
          curr === targetMessageId ? null : curr,
        );
      }, 2300);
    };

    const existingNode = findNode();
    if (existingNode) {
      focusNode(existingNode);
      return;
    }

    setJumpingToReplyId(targetMessageId);
    try {
      for (let page = 0; page < 4; page += 1) {
        const state = useChatStore.getState();
        if (!state.hasMoreByChannel[channel.id]) break;
        await loadOlderMessages(channel.id);
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        const found = findNode();
        if (found) {
          focusNode(found);
          return;
        }
      }
    } finally {
      setJumpingToReplyId((curr) => (curr === targetMessageId ? null : curr));
    }
  };

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() && files.length === 0) return;
    await sendMessage({
      channelId: channel.id,
      content: draft,
      files,
    });
    setDraft("");
    setFiles([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    handleJumpToBottom();
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pastedFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) pastedFiles.push(f);
      }
    }
    if (pastedFiles.length > 0) {
      setFiles((prev) => [...prev, ...pastedFiles]);
    }
  };

  const handleSaveEdit = async (messageId: string) => {
    await editMessage(messageId, editingText);
    setEditingId(null);
    setEditingText("");
  };

  return (
    <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#16161C] relative">
      {/* Cabeçalho do Canal com Brilho Radial Difuso + Borda Gradiente Animada */}
      <header className="h-14 px-3 sm:px-5 crimson-header-glow crimson-header-animated-border hairline-b flex items-center justify-between gap-2 shrink-0 select-none">
        <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
          {onOpenLeftDrawer && (
            <button
              type="button"
              onClick={onOpenLeftDrawer}
              className="md:hidden min-h-[40px] min-w-[40px] rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center justify-center shrink-0"
              aria-label="Abrir servidores e canais"
            >
              <PanelLeft className="w-4 h-4" strokeWidth={1.5} />
            </button>
          )}
          <div className="w-7 h-7 rounded-lg bg-[#101014] hairline-box hidden sm:flex items-center justify-center shrink-0">
            <Hash className="w-4 h-4 text-[#EF4444]" strokeWidth={1.5} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <Hash
                className="w-3.5 h-3.5 text-[#EF4444] sm:hidden shrink-0"
                strokeWidth={1.5}
              />
              <h2 className="text-sm font-semibold text-[#FAFAFA] truncate">
                {channel.name}
              </h2>
              {channel.topic && (
                <>
                  <span className="text-[#71717A] hidden sm:inline">•</span>
                  <span className="text-xs text-[#A1A1AA] truncate hidden sm:inline">
                    {channel.topic}
                  </span>
                </>
              )}
            </div>
            {activeServerName && (
              <p className="text-[10px] font-mono text-[#71717A] truncate md:hidden">
                {activeServerName}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden sm:flex items-center gap-2 font-mono text-[11px] text-[#A1A1AA]">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-radar-pulse" />
            <span>REALTIME SYNC</span>
          </div>
          {onCollapseChat && (
            <button
              type="button"
              onClick={onCollapseChat}
              className="min-h-[34px] px-2.5 py-1 rounded-lg bg-[#101014] hover:bg-[#1E1E26] hairline-box text-[11px] text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1.5 transition-colors"
              title="Recolher chat e expandir palco de voz/transmissão"
            >
              <PanelTopClose className="w-3.5 h-3.5 text-[#EF4444]" strokeWidth={1.5} />
              <span className="hidden lg:inline">Recolher Chat</span>
            </button>
          )}
          {onOpenRightDrawer && (
            <button
              type="button"
              onClick={onOpenRightDrawer}
              className="md:hidden min-h-[40px] px-2.5 rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center gap-1.5 font-mono text-[11px]"
              aria-label="Abrir lista de membros"
            >
              <Users className="w-4 h-4 text-[#A1A1AA]" strokeWidth={1.5} />
              <span>{onlineCount}</span>
            </button>
          )}
        </div>
      </header>

      {/* Feed de Mensagens com Transição Suave ao Alternar Canais */}
      <div
        key={channel.id}
        ref={feedRef}
        onScroll={handleFeedScroll}
        className="flex-1 overflow-y-auto px-3 sm:px-5 py-3 sm:py-4 space-y-0.5 animate-cyber-slide"
      >
        {hasMore && (
          <div className="flex justify-center pb-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadOlderMessages(channel.id)}
              className="px-3 py-1.5 rounded-full bg-[#101014] hover:bg-[#1E1E26] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1.5 transition-colors"
            >
              <History className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span>
                {loading
                  ? "Sincronizando histórico..."
                  : "Carregar mensagens anteriores"}
              </span>
            </button>
          </div>
        )}

        {messages.length === 0 && !loading && (
          <div className="py-12 text-center space-y-2 select-none">
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#101014] hairline-box text-[11px] font-mono text-[#A1A1AA]">
              <Sparkles className="w-3 h-3 text-[#EF4444]" strokeWidth={1.5} />
              INÍCIO DO CANAL #{channel.name.toUpperCase()}
            </div>
            <p className="text-xs text-[#71717A]">
              Envie a primeira mensagem ou compartilhe uma foto ou vídeo curto com o grupo.
            </p>
          </div>
        )}

        {messages.map((msg, idx) => {
          const prevMsg = idx > 0 ? messages[idx - 1] : null;
          const authorChanged = Boolean(
            prevMsg && prevMsg.author_id !== msg.author_id,
          );
          const showUnreadDivider = Boolean(
            unreadState &&
              unreadState.count > 0 &&
              unreadState.firstUnreadMessageId === msg.id,
          );
          const timeDiffMs = prevMsg
            ? Math.abs(
                new Date(msg.created_at).getTime() -
                  new Date(prevMsg.created_at).getTime(),
              )
            : Infinity;
          const isGrouped = Boolean(
            prevMsg &&
              prevMsg.author_id === msg.author_id &&
              timeDiffMs < GROUP_WINDOW_MS &&
              !msg.reply_to_id,
          );

          const member = memberByUserId.get(msg.author_id);
          const authorName =
            member?.nickname ??
            msg.author?.display_name ??
            msg.author?.username ??
            msg.author_id.slice(0, 8);
          const initials = authorName.slice(0, 2).toUpperCase();
          const timeFormatted = new Date(msg.created_at).toLocaleTimeString(
            [],
            { hour: "2-digit", minute: "2-digit" },
          );
          const roleBadge = resolveAuthorRoleBadge({
            authorId: msg.author_id,
            member,
            ownerId: activeServer?.owner_id,
            rolesById,
            authorBadgeText: msg.author?.custom_badge_text,
            authorBadgeColor: msg.author?.custom_badge_color,
          });
          const authorNameColor =
            roleBadge?.color ?? msg.author?.card_text_color ?? "#FAFAFA";
          const badgeIsHex = roleBadge ? isHexColor6(roleBadge.color) : false;

          const isAuthor = msg.author_id === userId;
          const canDelete = isAuthor || canModerateMessages;

          return (
            <div key={msg.id}>
              {authorChanged && !showUnreadDivider && (
                <div className="my-2.5 h-px w-full bg-gradient-to-r from-white/[0.10] via-white/[0.04] to-transparent" />
              )}

              {showUnreadDivider && (
                <div
                  ref={unreadMarkerRef}
                  className="my-3 flex items-center gap-2.5 select-none animate-cyber-slide"
                >
                  <span className="h-px flex-1 bg-gradient-to-r from-transparent via-[#B91C1C]/45 to-[#B91C1C]/80" />
                  <span className="px-2 py-0.5 rounded-full bg-[#7F1D1D]/30 border border-[#EF4444]/40 text-[10px] font-mono font-semibold tracking-wider text-[#EF4444] shrink-0">
                    NOVAS MENSAGENS
                  </span>
                  <span className="h-px flex-1 bg-gradient-to-r from-[#B91C1C]/80 via-[#B91C1C]/25 to-transparent" />
                </div>
              )}

              <ContextMenu.Root>
                <ContextMenu.Trigger asChild>
                  <article
                    data-message-id={msg.id}
                    className={`group relative hover:bg-white/[0.025] rounded-lg px-3 transition-colors ${
                      isGrouped ? "py-1" : "py-1.5"
                    } ${
                      highlightedMessageId === msg.id
                        ? "animate-message-jump-highlight"
                        : ""
                    }`}
                  >
                    {/* Ações Rápidas Discretas no Hover */}
                    <div className="absolute right-2 -top-2.5 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center gap-0.5 rounded-lg scoped-glass px-1 py-0.5 shadow-lg">
                      <button
                        type="button"
                        onClick={() => setReplyingTo(msg)}
                        className="px-2 py-1 rounded-md hover:bg-white/[0.06] text-[11px] text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1 transition-colors"
                        title="Responder"
                      >
                        <Reply className="w-3 h-3" strokeWidth={1.5} />
                        <span className="hidden sm:inline">Responder</span>
                      </button>
                      {isAuthor && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(msg.id);
                            setEditingText(msg.content);
                          }}
                          className="px-2 py-1 rounded-md hover:bg-white/[0.06] text-[11px] text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1 transition-colors"
                          title="Editar"
                        >
                          <Pencil className="w-3 h-3" strokeWidth={1.5} />
                          <span className="hidden sm:inline">Editar</span>
                        </button>
                      )}
                    </div>

                    {/* Preview de Resposta Encadeada (Threaded Reply Clicável -> Jump-to-Reply) */}
                    {(msg.reply_to || msg.reply_to_id) && (
                      <button
                        type="button"
                        onClick={() => {
                          const targetId = msg.reply_to?.id ?? msg.reply_to_id;
                          if (targetId) void handleJumpToMessage(targetId);
                        }}
                        className="group/reply w-full text-left flex items-center gap-1.5 text-xs text-[#A1A1AA] hover:text-[#FAFAFA] pl-12 pb-1 transition-colors cursor-pointer"
                        title="Clique para pular até a mensagem original"
                      >
                        <CornerDownRight
                          className="w-3.5 h-3.5 text-[#B91C1C] group-hover/reply:text-[#EF4444] shrink-0 transition-colors"
                          strokeWidth={1.5}
                        />
                        {msg.reply_to ? (
                          <>
                            <span className="font-medium text-[#FAFAFA] group-hover/reply:underline truncate shrink-0 max-w-[160px]">
                              @
                              {msg.reply_to.author?.display_name ??
                                msg.reply_to.author?.username ??
                                msg.reply_to.author_id.slice(0, 6)}
                            </span>
                            <span className="text-[#71717A] group-hover/reply:text-[#D4D4D8] truncate">
                              {msg.reply_to.content ||
                                (msg.reply_to.parsed_attachments.length > 0
                                  ? "[Anexo]"
                                  : "Mensagem")}
                            </span>
                          </>
                        ) : (
                          <span className="text-[#71717A] group-hover/reply:text-[#FAFAFA] italic truncate">
                            {jumpingToReplyId === msg.reply_to_id
                              ? "Carregando mensagem original..."
                              : "Ir para mensagem original..."}
                          </span>
                        )}
                      </button>
                    )}

                    <div className="flex items-start gap-3">
                      {/* Avatar com Moldura (ou Horário Discreto em Mensagens Agrupadas) */}
                      <div className="w-9 shrink-0 flex justify-center">
                        {isGrouped ? (
                          <span className="w-9 text-right pr-0.5 pt-1 font-mono text-[10px] leading-none text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity select-none tabular-nums">
                            {timeFormatted}
                          </span>
                        ) : (
                          <div className="pt-0.5">
                            <AvatarWithFrame
                              avatarUrl={msg.author?.avatar_url}
                              initials={initials}
                              frame={msg.author?.avatar_frame ?? "none"}
                              bgColor={msg.author?.card_bg_color ?? "#101014"}
                              accentColor={
                                msg.author?.card_accent_color ??
                                roleBadge?.color ??
                                "#B91C1C"
                              }
                              borderColor={
                                msg.author?.card_border_color ??
                                "rgba(255, 255, 255, 0.14)"
                              }
                              sizePx={36}
                            />
                          </div>
                        )}
                      </div>

                      {/* Coluna de Conteúdo Principal Alinhada */}
                      <div className="min-w-0 flex-1 space-y-1">
                        {!isGrouped && (
                          <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            <span
                              className="text-xs font-semibold truncate"
                              style={{ color: authorNameColor }}
                            >
                              {authorName}
                            </span>
                            {roleBadge && (
                              <span
                                className="px-1.5 py-0.5 rounded-full text-[9px] font-mono font-semibold uppercase tracking-wide border shrink-0 leading-none"
                                style={{
                                  color: roleBadge.color,
                                  borderColor: badgeIsHex
                                    ? `${roleBadge.color}55`
                                    : "rgba(185, 28, 28, 0.35)",
                                  backgroundColor: badgeIsHex
                                    ? `${roleBadge.color}18`
                                    : "rgba(185, 28, 28, 0.12)",
                                }}
                              >
                                {roleBadge.label}
                              </span>
                            )}
                            <span className="font-mono text-[10px] text-[#71717A] tabular-nums">
                              {timeFormatted}
                            </span>
                            {msg.edited_at && (
                              <span className="font-mono text-[10px] text-[#71717A]">
                                (editada)
                              </span>
                            )}
                          </div>
                        )}

                        {/* Texto ou Edição Inline */}
                        {editingId === msg.id ? (
                          <div className="flex items-center gap-2 pt-1">
                            <input
                              type="text"
                              value={editingText}
                              onChange={(e) => setEditingText(e.target.value)}
                              className="flex-1 px-3 py-1.5 rounded-lg bg-[#09090B] hairline-box text-xs text-[#FAFAFA] focus:outline-none focus:border-[#B91C1C]"
                            />
                            <button
                              type="button"
                              onClick={() => void handleSaveEdit(msg.id)}
                              className="px-2.5 py-1.5 rounded-lg bg-[#B91C1C] hover:bg-[#991B1B] text-[#FAFAFA] text-xs font-medium flex items-center gap-1"
                            >
                              <Check className="w-3.5 h-3.5" strokeWidth={1.5} />
                              <span>Salvar</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="px-2.5 py-1.5 rounded-lg bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA]"
                            >
                              Cancelar
                            </button>
                          </div>
                        ) : (
                          msg.content && (
                            <p className="text-sm text-[#FAFAFA]/90 leading-relaxed whitespace-pre-wrap break-words">
                              {msg.content}
                              {isGrouped && msg.edited_at && (
                                <span className="ml-1.5 font-mono text-[10px] text-[#71717A] select-none">
                                  (editada)
                                </span>
                              )}
                            </p>
                          )
                        )}

                      {/* Galeria de Anexos (Miniaturas de Imagem Expansíveis, Vídeos Curtos <video controls> & Arquivos) */}
                      {msg.parsed_attachments.length > 0 && (
                        <div className="flex flex-wrap gap-2.5 pt-1.5">
                          {msg.parsed_attachments.map((att) => {
                            if (isImageAttachment(att)) {
                              return (
                                <button
                                  key={att.path || att.url}
                                  type="button"
                                  onClick={() => setExpandedImage(att)}
                                  className="group/media relative max-w-[280px] sm:max-w-[340px] max-h-64 rounded-xl overflow-hidden bg-[#09090B] hairline-box hover:border-[#B91C1C]/70 transition-all cursor-zoom-in"
                                  title={`Ampliar ${att.name}`}
                                >
                                  <img
                                    src={att.url}
                                    alt={att.name}
                                    loading="lazy"
                                    className="max-h-64 w-auto object-contain transition-transform duration-200 group-hover/media:scale-[1.02]"
                                  />
                                  <span className="scoped-glass absolute bottom-2 right-2 px-2 py-0.5 rounded-full font-mono text-[10px] text-[#FAFAFA] opacity-90 md:opacity-0 md:group-hover/media:opacity-100 transition-opacity flex items-center gap-1">
                                    <Maximize2
                                      className="w-3 h-3 text-[#EF4444]"
                                      strokeWidth={1.5}
                                    />
                                    <span>{formatAttachmentBytes(att.size)}</span>
                                  </span>
                                </button>
                              );
                            }

                            if (isVideoAttachment(att)) {
                              return (
                                <div
                                  key={att.path || att.url}
                                  className="w-full max-w-[320px] sm:max-w-[400px] rounded-xl overflow-hidden bg-[#09090B] hairline-box flex flex-col"
                                >
                                  <video
                                    src={att.url}
                                    controls
                                    preload="metadata"
                                    playsInline
                                    className="max-h-64 w-full bg-black object-contain"
                                  />
                                  <div className="px-3 py-1.5 bg-[#101014] hairline-t flex items-center justify-between gap-2 text-[11px]">
                                    <span className="flex items-center gap-1.5 text-[#FAFAFA] truncate">
                                      <Film
                                        className="w-3.5 h-3.5 text-[#EF4444] shrink-0"
                                        strokeWidth={1.5}
                                      />
                                      <span className="truncate">{att.name}</span>
                                    </span>
                                    <span className="font-mono text-[10px] text-[#71717A] shrink-0">
                                      {formatAttachmentBytes(att.size)}
                                    </span>
                                  </div>
                                </div>
                              );
                            }

                            return (
                              <a
                                key={att.path || att.url}
                                href={att.url}
                                target="_blank"
                                rel="noreferrer"
                                className="px-3 py-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-xs text-[#FAFAFA] flex items-center gap-2 transition-colors"
                              >
                                <FileText
                                  className="w-3.5 h-3.5 text-[#EF4444]"
                                  strokeWidth={1.5}
                                />
                                <span className="truncate max-w-[200px]">
                                  {att.name}
                                </span>
                                <span className="font-mono text-[10px] text-[#71717A]">
                                  {formatAttachmentBytes(att.size)}
                                </span>
                              </a>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              </ContextMenu.Trigger>

              {/* Menu de Contexto (Botão Direito na Mensagem) */}
              <ContextMenu.Portal>
                <ContextMenu.Content
                  collisionPadding={16}
                  className="min-w-[190px] rounded-xl scoped-glass p-1.5 shadow-2xl z-[75] text-xs text-[#FAFAFA] space-y-0.5 animate-popover-in"
                >
                  <ContextMenu.Item
                    onSelect={() => setReplyingTo(msg)}
                    className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]"
                  >
                    <Reply className="w-3.5 h-3.5 text-[#A1A1AA]" strokeWidth={1.5} />
                    <span>Responder</span>
                  </ContextMenu.Item>

                  {msg.content && (
                    <ContextMenu.Item
                      onSelect={() => void copyPlainText(msg.content)}
                      className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]"
                    >
                      <Copy className="w-3.5 h-3.5 text-[#A1A1AA]" strokeWidth={1.5} />
                      <span>Copiar Texto</span>
                    </ContextMenu.Item>
                  )}

                  {isAuthor && (
                    <ContextMenu.Item
                      onSelect={() => {
                        setEditingId(msg.id);
                        setEditingText(msg.content);
                      }}
                      className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]"
                    >
                      <Pencil className="w-3.5 h-3.5 text-[#A1A1AA]" strokeWidth={1.5} />
                      <span>Editar Mensagem</span>
                    </ContextMenu.Item>
                  )}

                  {canDelete && (
                    <>
                      <ContextMenu.Separator className="h-[1px] bg-white/[0.07] my-1" />
                      <ContextMenu.Item
                        onSelect={() => setDeleteTarget(msg)}
                        className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none text-[#F87171] hover:bg-[#1E1E26] focus:bg-[#1E1E26]"
                      >
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                        <span>Excluir Mensagem</span>
                      </ContextMenu.Item>
                    </>
                  )}
                    </ContextMenu.Content>
                  </ContextMenu.Portal>
                </ContextMenu.Root>
              </div>
          );
        })}
      </div>

      {/* Input de mensagem */}
      <form onSubmit={handleSend} className="relative px-3 sm:px-5 pb-3 pt-2 space-y-2">
        {!isAtBottom && unreadState && unreadState.count > 0 && (
          <div className="absolute left-1/2 -translate-x-1/2 bottom-[calc(100%+8px)] z-30 pointer-events-auto">
            <button
              type="button"
              onClick={handleJumpToBottom}
              className="backdrop-blur-md bg-[#16161C]/90 hover:bg-[#1E1E26]/95 border border-[#B91C1C]/45 hover:border-[#EF4444]/75 shadow-[0_8px_28px_rgba(0,0,0,0.65)] animate-cyber-slide rounded-full pl-1.5 pr-3 py-1.5 flex items-center gap-2 transition-colors cursor-pointer"
            >
              <span
                className="w-5 h-5 rounded-full overflow-hidden bg-[#101014] border border-white/15 flex items-center justify-center text-[9px] font-bold shrink-0"
                style={{
                  color: unreadState.lastAuthorAccentColor ?? "#EF4444",
                }}
              >
                {unreadState.lastAuthorAvatarUrl ? (
                  <img
                    src={unreadState.lastAuthorAvatarUrl}
                    alt={unreadState.lastAuthorName ?? "Novo"}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  (unreadState.lastAuthorName ?? "?")
                    .slice(0, 2)
                    .toUpperCase()
                )}
              </span>
              <span className="font-mono text-[11px] font-medium text-[#FAFAFA] whitespace-nowrap">
                {unreadState.count === 1
                  ? "1 nova mensagem"
                  : `${unreadState.count} novas mensagens`}
              </span>
              <ArrowDown
                className="w-3.5 h-3.5 text-[#EF4444] shrink-0"
                strokeWidth={1.75}
              />
            </button>
          </div>
        )}
        {/* Banner de Resposta Encadeada */}
        {replyingTo && (
          <div className="px-4 py-2 rounded-2xl bg-[#101014] hairline-box flex items-center justify-between gap-2 text-xs animate-cyber-slide">
            <div className="flex items-center gap-2 min-w-0">
              <Reply className="w-3.5 h-3.5 text-[#EF4444] shrink-0" strokeWidth={1.5} />
              <span className="text-[#A1A1AA]">Respondendo a</span>
              <span className="font-semibold text-[#FAFAFA] truncate">
                {replyingTo.author?.display_name ?? "membro"}
              </span>
              <span className="text-[#71717A] truncate">
                — {replyingTo.content.slice(0, 65)}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              className="p-1 rounded-full hover:bg-[#16161C] text-[#A1A1AA] hover:text-[#FAFAFA]"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.5} />
            </button>
          </div>
        )}

        {/* Chips de Arquivos Selecionados (Fotos / Vídeos Curtos / Documentos) */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 animate-cyber-slide">
            {files.map((file, i) => {
              const isImg = file.type.startsWith("image/");
              const isVid = file.type.startsWith("video/");
              return (
                <span
                  key={`${file.name}-${i}`}
                  className="px-2.5 py-1 rounded-full bg-[#101014] hairline-box text-xs text-[#FAFAFA] flex items-center gap-1.5"
                >
                  {isImg ? (
                    <ImageIcon
                      className="w-3.5 h-3.5 text-[#EF4444]"
                      strokeWidth={1.5}
                    />
                  ) : isVid ? (
                    <Film
                      className="w-3.5 h-3.5 text-[#EF4444]"
                      strokeWidth={1.5}
                    />
                  ) : (
                    <Paperclip
                      className="w-3 h-3 text-[#EF4444]"
                      strokeWidth={1.5}
                    />
                  )}
                  <span className="max-w-[160px] truncate">{file.name}</span>
                  <span className="font-mono text-[10px] text-[#71717A]">
                    {formatAttachmentBytes(file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setFiles((prev) => prev.filter((_, idx) => idx !== i))
                    }
                    className="text-[#71717A] hover:text-[#FAFAFA]"
                  >
                    <X className="w-3 h-3" strokeWidth={1.5} />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {chatError && (
          <div className="px-3 text-xs text-[#F87171] font-mono">
            {chatError}
          </div>
        )}

        {/* Barra Flutuante em Formato de Pílula (rounded-full) */}
        <div className="flex items-center gap-1.5 sm:gap-2 pl-2 sm:pl-3.5 pr-1.5 sm:pr-2 py-1 rounded-full bg-[#101014] hairline-box focus-within:border-[#B91C1C]/70 shadow-lg transition-colors">
          <label
            className="min-w-[40px] min-h-[40px] rounded-full hover:bg-[#16161C] text-[#A1A1AA] hover:text-[#FAFAFA] cursor-pointer transition-colors shrink-0 flex items-center justify-center"
            title="Anexar fotos ou vídeos curtos (máx 25MB)"
          >
            <Paperclip className="w-4 h-4" strokeWidth={1.5} />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/mp4,video/webm,video/quicktime,audio/*,.pdf,.txt"
              className="hidden"
              onChange={(e) => {
                const selected = Array.from(e.target.files ?? []);
                if (selected.length > 0) {
                  setFiles((prev) => [...prev, ...selected]);
                }
                e.target.value = "";
              }}
            />
          </label>

          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={handlePaste}
            placeholder={`Conversar em #${channel.name}...`}
            className="flex-1 min-w-0 bg-transparent text-sm text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none py-2"
          />

          <button
            type="submit"
            disabled={sending || (!draft.trim() && files.length === 0)}
            className="min-h-[40px] min-w-[40px] px-3 sm:px-4 rounded-full btn-crimson-vivid disabled:opacity-40 text-[#FAFAFA] text-xs font-medium flex items-center justify-center gap-1.5 shrink-0"
          >
            <span className="hidden sm:inline">
              {sending ? "Enviando" : "Enviar"}
            </span>
            <SendHorizontal className="w-4 h-4" strokeWidth={1.75} />
          </button>
        </div>
      </form>

      {/* Modal Lightbox Centralizado com Scoped Glass para Fotos Expandidas */}
      <Modal
        open={Boolean(expandedImage)}
        onOpenChange={(open) => !open && setExpandedImage(null)}
        overlayZIndexClass="z-[85]"
        contentClassName="w-[94vw] max-w-4xl max-h-[90dvh] rounded-2xl scoped-glass p-3 sm:p-4 shadow-2xl flex flex-col gap-3"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2 min-w-0">
            <ImageIcon
              className="w-4 h-4 text-[#EF4444] shrink-0"
              strokeWidth={1.5}
            />
            <Dialog.Title className="text-xs font-semibold text-[#FAFAFA] truncate">
              {expandedImage?.name ?? "Imagem"}
            </Dialog.Title>
            {expandedImage && (
              <span className="font-mono text-[10px] text-[#A1A1AA] shrink-0">
                {formatAttachmentBytes(expandedImage.size)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {expandedImage?.url && (
              <a
                href={expandedImage.url}
                target="_blank"
                rel="noreferrer"
                className="px-2.5 py-1.5 rounded-lg bg-[#101014]/85 hover:bg-[#16161C] hairline-box text-xs text-[#FAFAFA] flex items-center gap-1.5"
              >
                <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.5} />
                <span className="hidden sm:inline">Abrir Original</span>
              </a>
            )}
            <Dialog.Close asChild>
              <button
                type="button"
                className="p-1.5 rounded-lg bg-[#101014]/85 hover:bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
                aria-label="Fechar imagem"
              >
                <X className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden rounded-xl bg-black/75 hairline-box p-2">
          {expandedImage && (
            <img
              src={expandedImage.url}
              alt={expandedImage.name}
              className="max-h-[75dvh] max-w-full object-contain rounded-lg"
            />
          )}
        </div>
      </Modal>

      {/* Modal Centralizado de Confirmação para Excluir Mensagem */}
      <Modal
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        overlayZIndexClass="z-[75]"
        contentClassName="w-[90vw] max-w-sm rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl space-y-4"
      >
        <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]">
          Excluir mensagem?
        </Dialog.Title>
        <Dialog.Description className="text-xs text-[#A1A1AA]">
          Esta ação removerá a mensagem permanentemente para todos os participantes do canal.
        </Dialog.Description>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setDeleteTarget(null)}
            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA]"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!deleteTarget) return;
              await deleteMessage(deleteTarget.id);
              setDeleteTarget(null);
            }}
            className="min-h-[40px] px-4 py-2 rounded-xl btn-non-destructive-active text-xs font-medium"
          >
            Excluir Mensagem
          </button>
        </div>
      </Modal>
    </main>
  );
}
