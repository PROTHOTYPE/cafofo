import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
} from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  makeDmVoiceRoomId,
  useAuthStore,
  useFriendsStore,
  usePresenceStore,
  useVoiceStore,
  type DirectChannelWithPeer,
  type DirectMessageItem,
  type MessageAttachment,
  type PresenceStatus,
} from "@cafofo/core-logic";
import {
  Check,
  Copy,
  CornerDownRight,
  ExternalLink,
  FileText,
  Film,
  History,
  Image as ImageIcon,
  Maximize2,
  PanelLeft,
  PanelTopClose,
  Paperclip,
  Pencil,
  Phone,
  PhoneOff,
  Reply,
  SendHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { copyPlainText } from "../lib/clipboard";
import { resolveGameIconUrl, useGameIcons } from "../lib/gameIcons";
import { buildMemberCardData } from "./MemberContextMenu";
import { Modal } from "./Modal";
import {
  AvatarWithFrame,
  ProfileCardPreview,
  type ProfileCardData,
} from "./ProfileCardPreview";

const EMPTY_DM_MESSAGES: DirectMessageItem[] = [];
const GROUP_WINDOW_MS = 5 * 60 * 1000;

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

interface DirectChatPanelProps {
  dmChannel: DirectChannelWithPeer;
  onOpenLeftDrawer?: () => void;
  onCollapseChat?: () => void;
}

export function DirectChatPanel({
  dmChannel,
  onOpenLeftDrawer,
  onCollapseChat,
}: DirectChatPanelProps) {
  const userId = useAuthStore((s) => s.user?.id);
  const messages = useFriendsStore(
    (s) => s.messagesByDm[dmChannel.id] ?? EMPTY_DM_MESSAGES,
  );
  const hasMore = useFriendsStore((s) => Boolean(s.hasMoreByDm[dmChannel.id]));
  const loading = useFriendsStore((s) => Boolean(s.loadingByDm[dmChannel.id]));
  const replyingToDm = useFriendsStore((s) => s.replyingToDm);
  const sending = useFriendsStore((s) => s.sending);
  const dmError = useFriendsStore((s) => s.error);
  const friendPresenceByUser = useFriendsStore((s) => s.friendPresenceByUser);
  const outgoingCall = useFriendsStore((s) => s.outgoingCall);

  const loadDmMessages = useFriendsStore((s) => s.loadDmMessages);
  const loadOlderDmMessages = useFriendsStore((s) => s.loadOlderDmMessages);
  const sendDmMessage = useFriendsStore((s) => s.sendDmMessage);
  const editDmMessage = useFriendsStore((s) => s.editDmMessage);
  const deleteDmMessage = useFriendsStore((s) => s.deleteDmMessage);
  const setReplyingToDm = useFriendsStore((s) => s.setReplyingToDm);
  const setDmAtBottom = useFriendsStore((s) => s.setDmAtBottom);
  const markDmRead = useFriendsStore((s) => s.markDmRead);
  const startDirectCall = useFriendsStore((s) => s.startDirectCall);

  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId);
  const leaveVoiceChannel = useVoiceStore((s) => s.leaveVoiceChannel);
  const onlineByServer = usePresenceStore((s) => s.onlineByServer);
  const gameCatalog = usePresenceStore((s) => s.gameCatalog);
  const gameIcons = useGameIcons();

  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DirectMessageItem | null>(
    null,
  );
  const [expandedImage, setExpandedImage] = useState<MessageAttachment | null>(
    null,
  );
  const [inspectedCard, setInspectedCard] = useState<ProfileCardData | null>(
    null,
  );
  const [readyDmId, setReadyDmId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const initialScrollRef = useRef<string | null>(null);
  const lastTailIdRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dmId = dmChannel.id;
  const dmRoomId = makeDmVoiceRoomId(dmId);
  const isInThisDmCall = activeVoiceChannelId === dmRoomId;
  const isRingingThisDm =
    outgoingCall?.dmChannelId === dmId && outgoingCall.status === "ringing";

  const peerProfile = dmChannel.otherUser;
  const peerName =
    peerProfile?.display_name ||
    peerProfile?.username ||
    dmChannel.otherUserId.slice(0, 8);
  const peerUsername =
    peerProfile?.username || dmChannel.otherUserId.slice(0, 8);

  const resolvedPresence = (() => {
    const g = friendPresenceByUser[dmChannel.otherUserId];
    if (g) return { status: g.status, game: g.game_presence };
    for (const sMap of Object.values(onlineByServer)) {
      if (sMap[dmChannel.otherUserId]) {
        return {
          status: sMap[dmChannel.otherUserId].status,
          game: sMap[dmChannel.otherUserId].game_presence,
        };
      }
    }
    return { status: "offline" as PresenceStatus, game: null };
  })();

  const peerStatusDot =
    resolvedPresence.status === "online"
      ? "bg-emerald-400"
      : resolvedPresence.status === "idle"
        ? "bg-amber-400"
        : resolvedPresence.status === "dnd"
          ? "bg-[#EF4444]"
          : "bg-[#52525B]";

  useEffect(() => {
    let cancelled = false;
    initialScrollRef.current = null;
    lastTailIdRef.current = null;
    isAtBottomRef.current = true;
    setReadyDmId(null);
    setDmAtBottom(dmId, true);
    markDmRead(dmId);

    void loadDmMessages(dmId)
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setReadyDmId(dmId);
      });

    return () => {
      cancelled = true;
    };
  }, [dmId, loadDmMessages, markDmRead, setDmAtBottom]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (readyDmId !== dmId) return;
    const container = feedRef.current;
    if (!container) return;

    if (initialScrollRef.current !== dmId) {
      initialScrollRef.current = dmId;
      lastTailIdRef.current =
        messages.length > 0 ? messages[messages.length - 1].id : null;
      requestAnimationFrame(() => {
        const el = feedRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
      return;
    }

    const tail = messages.length > 0 ? messages[messages.length - 1] : null;
    if (!tail || tail.id === lastTailIdRef.current) return;
    lastTailIdRef.current = tail.id;

    if (tail.author_id === userId || isAtBottomRef.current) {
      requestAnimationFrame(() => {
        const el = feedRef.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
      markDmRead(dmId);
    }
  }, [dmId, markDmRead, messages, readyDmId, userId]);

  const handleFeedScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    const atBottomNow =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 100;
    isAtBottomRef.current = atBottomNow;
    setDmAtBottom(dmId, atBottomNow);
    if (atBottomNow) markDmRead(dmId);
  };

  const handleJumpToMessage = async (targetId: string) => {
    const findNode = (): HTMLElement | null => {
      const container = feedRef.current;
      if (!container) return null;
      const nodes = container.querySelectorAll<HTMLElement>("[data-message-id]");
      for (const node of nodes) {
        if (node.dataset.messageId === targetId) return node;
      }
      return null;
    };

    const focusNode = (node: HTMLElement) => {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedId(null);
      requestAnimationFrame(() => setHighlightedId(targetId));
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => {
        setHighlightedId((curr) => (curr === targetId ? null : curr));
      }, 2300);
    };

    const existing = findNode();
    if (existing) {
      focusNode(existing);
      return;
    }
    for (let page = 0; page < 4; page += 1) {
      if (!useFriendsStore.getState().hasMoreByDm[dmId]) break;
      await loadOlderDmMessages(dmId);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const found = findNode();
      if (found) {
        focusNode(found);
        return;
      }
    }
  };

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() && files.length === 0) return;
    await sendDmMessage({
      dmChannelId: dmId,
      content: draft,
      files,
    });
    setDraft("");
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    requestAnimationFrame(() => {
      const el = feedRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    });
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pasted: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) pasted.push(f);
      }
    }
    if (pasted.length > 0) setFiles((prev) => [...prev, ...pasted]);
  };

  const handleInspectPeer = () => {
    const gameIconUrl = resolvedPresence.game
      ? resolveGameIconUrl({
          icons: gameIcons,
          gameId: resolvedPresence.game.game_id,
          processName: resolvedPresence.game.process_name,
          gameCatalog,
        })
      : null;
    setInspectedCard(
      buildMemberCardData({
        userId: dmChannel.otherUserId,
        displayName: peerName,
        profile: peerProfile,
        role: null,
        status: resolvedPresence.status,
        activeGame: resolvedPresence.game,
        gameIconUrl,
      }),
    );
  };

  return (
    <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#16161C] relative">
      {/* Cabeçalho da Conversa Direta + Botão Call 1:1 */}
      <header className="h-14 px-3 sm:px-5 crimson-header-glow crimson-header-animated-border hairline-b flex items-center justify-between gap-2 shrink-0 select-none">
        <div className="flex items-center gap-2.5 min-w-0">
          {onOpenLeftDrawer && (
            <button
              type="button"
              onClick={onOpenLeftDrawer}
              className="md:hidden min-h-[38px] min-w-[38px] rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center justify-center shrink-0"
              aria-label="Abrir conversas diretas"
            >
              <PanelLeft className="w-4 h-4" strokeWidth={1.5} />
            </button>
          )}

          <button
            type="button"
            onClick={handleInspectPeer}
            className="flex items-center gap-2.5 min-w-0 text-left group cursor-pointer"
            title="Ver cartão de perfil"
          >
            <div className="relative shrink-0">
              <AvatarWithFrame
                avatarUrl={peerProfile?.avatar_url}
                initials={peerName.slice(0, 2).toUpperCase()}
                frame={peerProfile?.avatar_frame ?? "none"}
                accentColor={peerProfile?.card_accent_color ?? "#B91C1C"}
                sizePx={32}
              />
              <span
                className={`w-2.5 h-2.5 rounded-full absolute -bottom-0.5 -right-0.5 border-2 border-[#16161C] ${peerStatusDot}`}
              />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-sm font-semibold text-[#FAFAFA] group-hover:text-[#EF4444] transition-colors truncate">
                  {peerName}
                </h2>
                <span className="font-mono text-[10px] text-[#71717A] hidden sm:inline truncate">
                  @{peerUsername}
                </span>
              </div>
              {resolvedPresence.game && (
                <p className="text-[10px] font-mono text-[#A1A1AA] truncate">
                  Jogando {resolvedPresence.game.game_name}
                </p>
              )}
            </div>
          </button>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {isInThisDmCall ? (
            <button
              type="button"
              onClick={() => void leaveVoiceChannel()}
              className="min-h-[34px] px-3 py-1.5 rounded-lg btn-non-destructive-active text-xs font-medium flex items-center gap-1.5"
              title="Encerrar Call 1:1"
            >
              <PhoneOff className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">Encerrar Call</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={isRingingThisDm}
              onClick={() =>
                void startDirectCall({
                  dmChannelId: dmId,
                  calleeId: dmChannel.otherUserId,
                  calleeName: peerName,
                  calleeAvatarUrl: peerProfile?.avatar_url ?? null,
                })
              }
              className="min-h-[34px] px-3 py-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/45 text-emerald-300 text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-50"
              title="Iniciar chamada de voz 1:1"
            >
              <Phone className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">
                {isRingingThisDm ? "Chamando..." : "Ligar (1:1)"}
              </span>
            </button>
          )}

          {onCollapseChat && (
            <button
              type="button"
              onClick={onCollapseChat}
              className="min-h-[34px] px-2.5 py-1 rounded-lg bg-[#101014] hover:bg-[#1E1E26] hairline-box text-[11px] text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1.5 transition-colors"
              title="Recolher chat e expandir palco da call"
            >
              <PanelTopClose className="w-3.5 h-3.5 text-[#EF4444]" strokeWidth={1.5} />
              <span className="hidden lg:inline">Recolher Chat</span>
            </button>
          )}
        </div>
      </header>

      {/* Feed de Mensagens Diretas */}
      <div
        key={dmId}
        ref={feedRef}
        onScroll={handleFeedScroll}
        className="flex-1 overflow-y-auto px-3 sm:px-5 py-3 sm:py-4 space-y-0.5 animate-cyber-slide"
      >
        {hasMore && (
          <div className="flex justify-center pb-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadOlderDmMessages(dmId)}
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
          <div className="py-12 text-center space-y-2.5 select-none">
            <div className="flex justify-center">
              <AvatarWithFrame
                avatarUrl={peerProfile?.avatar_url}
                initials={peerName.slice(0, 2).toUpperCase()}
                frame={peerProfile?.avatar_frame ?? "none"}
                accentColor={peerProfile?.card_accent_color ?? "#B91C1C"}
                sizePx={56}
              />
            </div>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#101014] hairline-box text-[11px] font-mono text-[#A1A1AA]">
              <Sparkles className="w-3 h-3 text-[#EF4444]" strokeWidth={1.5} />
              INÍCIO DA CONVERSA COM @{peerUsername.toUpperCase()}
            </div>
            <p className="text-xs text-[#71717A]">
              Envie uma mensagem direta ou clique em Ligar para iniciar uma call 1:1 privada.
            </p>
          </div>
        )}

        {messages.map((msg, idx) => {
          const prevMsg = idx > 0 ? messages[idx - 1] : null;
          const authorChanged = Boolean(
            prevMsg && prevMsg.author_id !== msg.author_id,
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

          const authorName =
            msg.author?.display_name ??
            msg.author?.username ??
            msg.author_id.slice(0, 8);
          const initials = authorName.slice(0, 2).toUpperCase();
          const timeFormatted = new Date(msg.created_at).toLocaleTimeString(
            [],
            { hour: "2-digit", minute: "2-digit" },
          );
          const isAuthor = msg.author_id === userId;

          return (
            <div key={msg.id}>
              {authorChanged && (
                <div className="my-2.5 h-px w-full bg-gradient-to-r from-white/[0.10] via-white/[0.04] to-transparent" />
              )}

              <ContextMenu.Root>
                <ContextMenu.Trigger asChild>
                  <article
                    data-message-id={msg.id}
                    className={`group relative hover:bg-white/[0.025] rounded-lg px-3 transition-colors ${
                      isGrouped ? "py-1" : "py-1.5"
                    } ${
                      highlightedId === msg.id
                        ? "animate-message-jump-highlight"
                        : ""
                    }`}
                  >
                    <div className="absolute right-2 -top-2.5 z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center gap-0.5 rounded-lg scoped-glass px-1 py-0.5 shadow-lg">
                      <button
                        type="button"
                        onClick={() => setReplyingToDm(msg)}
                        className="px-2 py-1 rounded-md hover:bg-white/[0.06] text-[11px] text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1"
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
                          className="px-2 py-1 rounded-md hover:bg-white/[0.06] text-[11px] text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1"
                        >
                          <Pencil className="w-3 h-3" strokeWidth={1.5} />
                          <span className="hidden sm:inline">Editar</span>
                        </button>
                      )}
                    </div>

                    {(msg.reply_to || msg.reply_to_id) && (
                      <button
                        type="button"
                        onClick={() => {
                          const tid = msg.reply_to?.id ?? msg.reply_to_id;
                          if (tid) void handleJumpToMessage(tid);
                        }}
                        className="group/reply w-full text-left flex items-center gap-1.5 text-xs text-[#A1A1AA] hover:text-[#FAFAFA] pl-12 pb-1 transition-colors cursor-pointer"
                      >
                        <CornerDownRight
                          className="w-3.5 h-3.5 text-[#B91C1C] shrink-0"
                          strokeWidth={1.5}
                        />
                        {msg.reply_to ? (
                          <>
                            <span className="font-medium text-[#FAFAFA] group-hover/reply:underline truncate max-w-[160px] shrink-0">
                              @
                              {msg.reply_to.author?.display_name ??
                                msg.reply_to.author?.username ??
                                msg.reply_to.author_id.slice(0, 6)}
                            </span>
                            <span className="text-[#71717A] truncate">
                              {msg.reply_to.content || "[Anexo]"}
                            </span>
                          </>
                        ) : (
                          <span className="text-[#71717A] italic">
                            Ir para mensagem original...
                          </span>
                        )}
                      </button>
                    )}

                    <div className="flex items-start gap-3">
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
                                msg.author?.card_accent_color ?? "#B91C1C"
                              }
                              sizePx={36}
                            />
                          </div>
                        )}
                      </div>

                      <div className="min-w-0 flex-1 space-y-1">
                        {!isGrouped && (
                          <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            <span
                              className="text-xs font-semibold truncate"
                              style={{
                                color: msg.author?.card_text_color ?? "#FAFAFA",
                              }}
                            >
                              {authorName}
                            </span>
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
                              onClick={async () => {
                                await editDmMessage(msg.id, editingText);
                                setEditingId(null);
                                setEditingText("");
                              }}
                              className="px-2.5 py-1.5 rounded-lg bg-[#B91C1C] hover:bg-[#991B1B] text-[#FAFAFA] text-xs font-medium flex items-center gap-1"
                            >
                              <Check className="w-3.5 h-3.5" strokeWidth={1.5} />
                              <span>Salvar</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingId(null)}
                              className="px-2.5 py-1.5 rounded-lg bg-[#16161C] hairline-box text-xs text-[#A1A1AA]"
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
                                  >
                                    <img
                                      src={att.url}
                                      alt={att.name}
                                      loading="lazy"
                                      className="max-h-64 w-auto object-contain"
                                    />
                                    <span className="scoped-glass absolute bottom-2 right-2 px-2 py-0.5 rounded-full font-mono text-[10px] text-[#FAFAFA] opacity-90 md:opacity-0 md:group-hover/media:opacity-100 transition-opacity flex items-center gap-1">
                                      <Maximize2 className="w-3 h-3 text-[#EF4444]" strokeWidth={1.5} />
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
                                        <Film className="w-3.5 h-3.5 text-[#EF4444] shrink-0" strokeWidth={1.5} />
                                        <span className="truncate">{att.name}</span>
                                      </span>
                                      <span className="font-mono text-[10px] text-[#71717A] shrink-0">
                                        {formatAttachmentBytes(att.size)}
                                      </span>
                                    </div>
                                  </div>
                                );
                              }
                              const safeAttUrl =
                                /^https?:\/\//i.test(att.url ?? "") ? att.url : "#";
                              return (
                                <a
                                  key={att.path || att.url}
                                  href={safeAttUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="px-3 py-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-xs text-[#FAFAFA] flex items-center gap-2"
                                >
                                  <FileText className="w-3.5 h-3.5 text-[#EF4444]" strokeWidth={1.5} />
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

                <ContextMenu.Portal>
                  <ContextMenu.Content
                    collisionPadding={16}
                    className="min-w-[190px] rounded-xl scoped-glass p-1.5 shadow-2xl z-[75] text-xs text-[#FAFAFA] space-y-0.5 animate-popover-in"
                  >
                    <ContextMenu.Item
                      onSelect={() => setReplyingToDm(msg)}
                      className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none hover:bg-[#16161C]"
                    >
                      <Reply className="w-3.5 h-3.5 text-[#A1A1AA]" strokeWidth={1.5} />
                      <span>Responder</span>
                    </ContextMenu.Item>
                    {msg.content && (
                      <ContextMenu.Item
                        onSelect={() => void copyPlainText(msg.content)}
                        className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none hover:bg-[#16161C]"
                      >
                        <Copy className="w-3.5 h-3.5 text-[#A1A1AA]" strokeWidth={1.5} />
                        <span>Copiar Texto</span>
                      </ContextMenu.Item>
                    )}
                    {isAuthor && (
                      <>
                        <ContextMenu.Item
                          onSelect={() => {
                            setEditingId(msg.id);
                            setEditingText(msg.content);
                          }}
                          className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none hover:bg-[#16161C]"
                        >
                          <Pencil className="w-3.5 h-3.5 text-[#A1A1AA]" strokeWidth={1.5} />
                          <span>Editar Mensagem</span>
                        </ContextMenu.Item>
                        <ContextMenu.Separator className="h-[1px] bg-white/[0.07] my-1" />
                        <ContextMenu.Item
                          onSelect={() => setDeleteTarget(msg)}
                          className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none text-[#F87171] hover:bg-[#1E1E26]"
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

      {/* Barra Flutuante de Envio DM */}
      <form onSubmit={handleSend} className="relative px-3 sm:px-5 pb-3 pt-2 space-y-2">
        {replyingToDm && (
          <div className="px-4 py-2 rounded-2xl bg-[#101014] hairline-box flex items-center justify-between gap-2 text-xs animate-cyber-slide">
            <div className="flex items-center gap-2 min-w-0">
              <Reply className="w-3.5 h-3.5 text-[#EF4444] shrink-0" strokeWidth={1.5} />
              <span className="text-[#A1A1AA]">Respondendo a</span>
              <span className="font-semibold text-[#FAFAFA] truncate">
                {replyingToDm.author?.display_name ?? "amigo"}
              </span>
              <span className="text-[#71717A] truncate">
                — {replyingToDm.content.slice(0, 65)}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setReplyingToDm(null)}
              className="p-1 rounded-full hover:bg-[#16161C] text-[#A1A1AA] hover:text-[#FAFAFA]"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.5} />
            </button>
          </div>
        )}

        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2 animate-cyber-slide">
            {files.map((file, i) => (
              <span
                key={`${file.name}-${i}`}
                className="px-2.5 py-1 rounded-full bg-[#101014] hairline-box text-xs text-[#FAFAFA] flex items-center gap-1.5"
              >
                <Paperclip className="w-3 h-3 text-[#EF4444]" strokeWidth={1.5} />
                <span className="max-w-[160px] truncate">{file.name}</span>
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
            ))}
          </div>
        )}

        {dmError && (
          <div className="px-3 text-xs text-[#F87171] font-mono">{dmError}</div>
        )}

        <div className="flex items-center gap-1.5 sm:gap-2 pl-2 sm:pl-3.5 pr-1.5 sm:pr-2 py-1 rounded-full bg-[#101014] hairline-box focus-within:border-[#B91C1C]/70 shadow-lg transition-colors">
          <label
            className="min-w-[40px] min-h-[40px] rounded-full hover:bg-[#16161C] text-[#A1A1AA] hover:text-[#FAFAFA] cursor-pointer shrink-0 flex items-center justify-center"
            title="Anexar fotos, vídeos curtos ou arquivos (máx 25MB)"
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
                if (selected.length > 0) setFiles((prev) => [...prev, ...selected]);
                e.target.value = "";
              }}
            />
          </label>

          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={handlePaste}
            placeholder={`Mensagem privada para @${peerUsername}...`}
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

      {/* Lightbox de Imagem */}
      <Modal
        open={Boolean(expandedImage)}
        onOpenChange={(open) => !open && setExpandedImage(null)}
        overlayZIndexClass="z-[85]"
        contentClassName="w-[94vw] max-w-4xl max-h-[90dvh] rounded-2xl scoped-glass p-3 sm:p-4 shadow-2xl flex flex-col gap-3"
      >
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2 min-w-0">
            <ImageIcon className="w-4 h-4 text-[#EF4444] shrink-0" strokeWidth={1.5} />
            <Dialog.Title className="text-xs font-semibold text-[#FAFAFA] truncate">
              {expandedImage?.name ?? "Imagem"}
            </Dialog.Title>
          </div>
          <div className="flex items-center gap-1.5">
            {expandedImage?.url && /^https?:\/\//i.test(expandedImage.url) && (
              <a
                href={expandedImage.url}
                target="_blank"
                rel="noopener noreferrer"
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

      {/* Confirmação de Exclusão */}
      <Modal
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        overlayZIndexClass="z-[75]"
        contentClassName="w-[90vw] max-w-sm rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl space-y-4"
      >
        <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]">
          Excluir mensagem direta?
        </Dialog.Title>
        <Dialog.Description className="text-xs text-[#A1A1AA]">
          Esta ação removerá a mensagem permanentemente da conversa.
        </Dialog.Description>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setDeleteTarget(null)}
            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#16161C] hairline-box text-xs text-[#A1A1AA]"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!deleteTarget) return;
              await deleteDmMessage(deleteTarget.id);
              setDeleteTarget(null);
            }}
            className="min-h-[40px] px-4 py-2 rounded-xl btn-non-destructive-active text-xs font-medium"
          >
            Excluir
          </button>
        </div>
      </Modal>

      {/* Cartão de Perfil do Amigo */}
      <Modal
        open={Boolean(inspectedCard)}
        onOpenChange={(open) => !open && setInspectedCard(null)}
        overlayZIndexClass="z-[80]"
        contentClassName="w-[min(22rem,92vw)] rounded-xl overflow-hidden shadow-2xl"
      >
        <Dialog.Title className="sr-only">
          Cartão de Perfil de {inspectedCard?.displayName ?? "Amigo"}
        </Dialog.Title>
        {inspectedCard && <ProfileCardPreview data={inspectedCard} />}
      </Modal>
    </main>
  );
}
