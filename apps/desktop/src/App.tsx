import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  getDefaultSignalingUrl,
  onIncomingChatNotification,
  onIncomingDmNotification,
  onIncomingFriendRequest,
  useAuthStore,
  useChatStore,
  useFriendsStore,
  usePresenceStore,
  useServerStore,
  useVoiceStore,
  type ChannelRow,
  type ChannelType,
  type MemberRealtimePresence,
  type PresenceStatus,
  type ServerMemberWithProfile,
  type ServerRow,
} from "@cafofo/core-logic";
import {
  AudioWaveform,
  Check,
  Copy,
  EyeOff,
  Hash,
  HeadphoneOff,
  ImagePlus,
  KeyRound,
  LogOut,
  MessageSquare,
  MicOff,
  MonitorUp,
  PanelLeft,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Settings,
  Tag,
  Trash2,
  UserPlus,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { AuthScreen } from "./components/AuthScreen";
import { ChatPanel } from "./components/ChatPanel";
import { DirectChatPanel } from "./components/DirectChatPanel";
import { FriendsHubPanel } from "./components/FriendsHubPanel";
import { ImageCropperModal } from "./components/ImageCropperModal";
import { IncomingCallOverlay } from "./components/IncomingCallOverlay";
import { MusicAudioEngine } from "./components/MusicAudioEngine";
import {
  buildMemberCardData,
  MemberContextMenuContent,
  MemberInspectAndKickDialogs,
} from "./components/MemberContextMenu";
import {
  MembersPresencePanel,
  ServerRolesManagerDialog,
} from "./components/MembersPresencePanel";
import { Modal } from "./components/Modal";
import {
  AvatarWithFrame,
  type ProfileCardData,
} from "./components/ProfileCardPreview";
import { ProfileEditorModal } from "./components/ProfileEditorModal";
import { UpdateBanner } from "./components/UpdateBanner";
import { VoiceControlsPanel } from "./components/VoiceControlsPanel";
import { WindowTitlebar } from "./components/WindowTitlebar";
import { copyPlainText } from "./lib/clipboard";
import {
  ensureGameIconExtracted,
  loadSavedCustomGames,
  resolveGameIconUrl,
  saveCustomGamesToStorage,
  useGameIcons,
} from "./lib/gameIcons";
import { useBrowserRemoteMedia } from "./lib/livekitBrowser";
import {
  createVoiceSoundCallbacks,
  playChatMessageSound,
  playFriendRequestSound,
} from "./lib/soundEffects";
import {
  createTauriVoiceTransport,
  getActiveGameSession,
  isTauriRuntime,
  listenGamePresenceChanged,
  setGameCatalog,
  syncCustomGames,
} from "./lib/tauri";
import { preloadWebRnnoise } from "./lib/webRnnoiseProcessor";
import { useAppUpdater } from "./lib/updater";

const EMPTY_CHANNELS: ChannelRow[] = [];
const EMPTY_MEMBERS: ServerMemberWithProfile[] = [];
const EMPTY_ONLINE_MAP: Record<string, MemberRealtimePresence> = {};

export function App() {
  const updater = useAppUpdater();
  const initialized = useAuthStore((s) => s.initialized);
  const user = useAuthStore((s) => s.user);
  const profile = useAuthStore((s) => s.profile);
  const authError = useAuthStore((s) => s.error);
  const initializeAuth = useAuthStore((s) => s.initialize);
  const signOut = useAuthStore((s) => s.signOut);
  const updateAuthStatus = useAuthStore((s) => s.updateStatus);

  const servers = useServerStore((s) => s.servers);
  const serversLoading = useServerStore((s) => s.loading);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const channelsByServer = useServerStore((s) => s.channelsByServer);
  const channels = useServerStore((s) =>
    activeServerId
      ? (s.channelsByServer[activeServerId] ?? EMPTY_CHANNELS)
      : EMPTY_CHANNELS,
  );
  const membersByServer = useServerStore((s) => s.membersByServer);
  const members = useServerStore((s) =>
    activeServerId
      ? (s.membersByServer[activeServerId] ?? EMPTY_MEMBERS)
      : EMPTY_MEMBERS,
  );
  const activeChannelId = useServerStore((s) => s.activeChannelId);
  const loadServers = useServerStore((s) => s.loadServers);
  const createServer = useServerStore((s) => s.createServer);
  const joinByInviteCode = useServerStore((s) => s.joinByInviteCode);
  const regenerateInviteCode = useServerStore((s) => s.regenerateInviteCode);
  const updateServerIcon = useServerStore((s) => s.updateServerIcon);
  const selectServer = useServerStore((s) => s.selectServer);
  const createChannel = useServerStore((s) => s.createChannel);
  const renameChannel = useServerStore((s) => s.renameChannel);
  const deleteChannel = useServerStore((s) => s.deleteChannel);
  const leaveServer = useServerStore((s) => s.leaveServer);
  const deleteServer = useServerStore((s) => s.deleteServer);
  const selectChannel = useServerStore((s) => s.selectChannel);
  const resetServers = useServerStore((s) => s.reset);

  const onlineMap = usePresenceStore((s) =>
    activeServerId
      ? (s.onlineByServer[activeServerId] ?? EMPTY_ONLINE_MAP)
      : EMPTY_ONLINE_MAP,
  );
  const localPresenceStatus = usePresenceStore((s) => s.localStatus);
  const bindServerPresence = usePresenceStore((s) => s.bindServerPresence);
  const unbindServerPresence = usePresenceStore((s) => s.unbindServerPresence);
  const notifyPresenceLeaving = usePresenceStore((s) => s.notifyLeaving);
  const setLocalPresenceStatus = usePresenceStore((s) => s.setLocalStatus);
  const loadGameCatalog = usePresenceStore((s) => s.loadGameCatalog);
  const setLocalGamePresence = usePresenceStore((s) => s.setLocalGamePresence);

  const configureVoice = useVoiceStore((s) => s.configure);
  const joinVoiceChannel = useVoiceStore((s) => s.joinVoiceChannel);
  const leaveVoiceChannel = useVoiceStore((s) => s.leaveVoiceChannel);
  const movePeerToRoom = useVoiceStore((s) => s.movePeerToRoom);
  const syncGamePresence = useVoiceStore((s) => s.syncGamePresence);
  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId);
  const voicePeers = useVoiceStore((s) => s.peers);
  const voiceMuted = useVoiceStore((s) => s.muted);
  const voiceDeafened = useVoiceStore((s) => s.deafened);
  const voiceSpeaking = useVoiceStore((s) => s.speaking);
  const sharingWindow = useVoiceStore((s) => s.sharingWindow);
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);
  const unreadByChannel = useChatStore((s) => s.unreadByChannel);
  const watchServerTextChannels = useChatStore(
    (s) => s.watchServerTextChannels,
  );
  const unsubscribeAllChats = useChatStore((s) => s.unsubscribeAll);
  const friendships = useFriendsStore((s) => s.friendships);
  const dmChannels = useFriendsStore((s) => s.dmChannels);
  const activeDmChannelId = useFriendsStore((s) => s.activeDmChannelId);
  const unreadByDm = useFriendsStore((s) => s.unreadByDm);
  const friendPresenceByUser = useFriendsStore((s) => s.friendPresenceByUser);
  const bindSocialRealtime = useFriendsStore((s) => s.bindSocialRealtime);
  const selectDmChannel = useFriendsStore((s) => s.selectDmChannel);
  const resetFriends = useFriendsStore((s) => s.reset);
  const gameCatalog = usePresenceStore((s) => s.gameCatalog);
  const gameByUser = usePresenceStore((s) => s.gameByUser);
  const gameIcons = useGameIcons();
  const { remoteVideoByUser } = useBrowserRemoteMedia();

  const [inspectedVoiceCard, setInspectedVoiceCard] = useState<{
    userId: string;
    data: ProfileCardData;
  } | null>(null);
  const [kickVoiceCandidate, setKickVoiceCandidate] =
    useState<ServerMemberWithProfile | null>(null);

  const [profileOpen, setProfileOpen] = useState(false);
  const [createServerOpen, setCreateServerOpen] = useState(false);
  const [joinInviteOpen, setJoinInviteOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [rolesManagerServerId, setRolesManagerServerId] = useState<string | null>(
    null,
  );
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"server" | "home">("server");
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [serverIconCropTarget, setServerIconCropTarget] = useState<{
    serverId: string;
    serverName: string;
    file: File;
  } | null>(null);
  const [chatToast, setChatToast] = useState<{
    id: string;
    kind: "channel" | "dm" | "friend_request";
    channelId?: string;
    dmChannelId?: string;
    channelName: string;
    authorName: string;
    authorAvatarUrl: string | null;
    authorAccentColor: string;
    snippet: string;
  } | null>(null);
  const serverIconInputRef = useRef<HTMLInputElement | null>(null);
  const pendingServerIconMetaRef = useRef<{
    serverId: string;
    serverName: string;
  } | null>(null);
  const chatCollapsedRef = useRef(false);
  const chatToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    chatCollapsedRef.current = chatCollapsed;
  }, [chatCollapsed]);

  const [renamingChannel, setRenamingChannel] = useState<ChannelRow | null>(
    null,
  );
  const [renameChannelInput, setRenameChannelInput] = useState("");
  const [deletingChannel, setDeletingChannel] = useState<ChannelRow | null>(
    null,
  );
  const [serverConfirmAction, setServerConfirmAction] = useState<{
    type: "leave" | "delete";
    server: ServerRow;
  } | null>(null);

  const [draggingVoiceUser, setDraggingVoiceUser] = useState<{
    userId: string;
    sourceChannelId: string;
  } | null>(null);
  const [dragOverChannelId, setDragOverChannelId] = useState<string | null>(
    null,
  );

  const [newServerName, setNewServerName] = useState("");
  const [inviteInput, setInviteInput] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelType, setNewChannelType] = useState<ChannelType>("text");
  const [socialError, setSocialError] = useState<string | null>(null);
  const [copiedInvite, setCopiedInvite] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) {
      preloadWebRnnoise();
    }
    configureVoice({
      signalingUrl: getDefaultSignalingUrl(import.meta.env.VITE_SIGNALING_URL),
      transport: createTauriVoiceTransport(),
      soundCallbacks: createVoiceSoundCallbacks(),
    });
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void initializeAuth().then((unsub) => {
      if (disposed) {
        unsub();
      } else {
        cleanup = unsub;
      }
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [configureVoice, initializeAuth]);

  const userId = user?.id ?? null;
  const textChannelKey = channels
    .filter((c) => c.type === "text")
    .map((c) => c.id)
    .join(",");

  useEffect(() => {
    if (!userId || !activeServerId) {
      watchServerTextChannels(null, []);
      return;
    }
    const ids = textChannelKey ? textChannelKey.split(",") : [];
    watchServerTextChannels(activeServerId, ids);
  }, [activeServerId, textChannelKey, userId, watchServerTextChannels]);

  useEffect(() => {
    if (!userId || !activeServerId) return;
    void bindServerPresence(activeServerId, userId);
  }, [activeServerId, bindServerPresence, userId]);

  useEffect(() => {
    if (!userId) return;
    const handleTabClosing = () => {
      notifyPresenceLeaving();
    };
    window.addEventListener("pagehide", handleTabClosing);
    window.addEventListener("beforeunload", handleTabClosing);
    return () => {
      window.removeEventListener("pagehide", handleTabClosing);
      window.removeEventListener("beforeunload", handleTabClosing);
    };
  }, [notifyPresenceLeaving, userId]);

  useEffect(() => {
    if (!userId) return;
    void loadServers().catch((err) => setSocialError(String(err)));

    const applySession = (
      session: Awaited<ReturnType<typeof getActiveGameSession>>,
    ) => {
      if (!session) return;
      const presence = {
        user_id: userId,
        game_id: session.game_id,
        game_name: session.game_name,
        process_name: session.process_name,
        started_at_ms: session.started_at_ms,
      };
      void setLocalGamePresence(presence, userId);
      syncGamePresence(presence);
      void ensureGameIconExtracted({
        gameId: session.game_id,
        processName: session.process_name,
      });
    };

    if (isTauriRuntime()) {
      const savedCustom = loadSavedCustomGames();
      const customSync =
        savedCustom.length > 0 ? syncCustomGames(savedCustom) : Promise.resolve([]);
      void customSync
        .then((merged) => {
          if (merged.length > 0) saveCustomGamesToStorage(merged);
        })
        .catch(() => {});
    }

    void loadGameCatalog()
      .then(async (catalog) => {
        if (!isTauriRuntime()) return;
        await setGameCatalog(
          catalog.map((g) => ({
            game_id: g.id,
            name: g.name,
            executables: g.executables,
            is_custom: false,
          })),
        );
        const initialSession = await getActiveGameSession().catch(() => null);
        applySession(initialSession);
      })
      .catch(async () => {
        if (!isTauriRuntime()) return;
        const initialSession = await getActiveGameSession().catch(() => null);
        applySession(initialSession);
      });
  }, [userId, loadServers, loadGameCatalog, setLocalGamePresence, syncGamePresence]);

  useEffect(() => {
    if (!userId || !isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenGamePresenceChanged((presence) => {
      const hasGame = Boolean(presence.game_id || presence.game_name);
      const normalized = hasGame ? { ...presence, user_id: userId } : null;
      void setLocalGamePresence(normalized, userId);
      syncGamePresence(normalized);
      if (normalized) {
        void ensureGameIconExtracted({
          gameId: normalized.game_id,
          processName: normalized.process_name,
        });
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [userId, setLocalGamePresence, syncGamePresence]);

  useEffect(() => {
    if (!userId) return;
    void bindSocialRealtime(userId).catch(() => {});
  }, [bindSocialRealtime, userId]);

  useEffect(() => {
    const handleOpenDmEvent = (e: Event) => {
      const dmId = (e as CustomEvent<{ dmChannelId?: string }>).detail
        ?.dmChannelId;
      if (!dmId) return;
      selectDmChannel(dmId);
      setViewMode("home");
      setChatCollapsed(false);
      setLeftDrawerOpen(false);
    };
    window.addEventListener("cafofo:open-dm", handleOpenDmEvent);
    return () => {
      window.removeEventListener("cafofo:open-dm", handleOpenDmEvent);
    };
  }, [selectDmChannel]);

  useEffect(() => {
    if (!userId) return;
    const unsubscribeChat = onIncomingChatNotification((event) => {
      const currentStatus = usePresenceStore.getState().localStatus;
      const isDeafened = useVoiceStore.getState().deafened;
      if (currentStatus === "dnd" || isDeafened) return;

      playChatMessageSound();

      const shouldShowPopup =
        !event.isActiveChannel ||
        chatCollapsedRef.current ||
        !event.isAtBottom;

      if (!shouldShowPopup) return;

      const allChannelsByServer = useServerStore.getState().channelsByServer;
      let channelName = "chat";
      for (const chList of Object.values(allChannelsByServer)) {
        const matched = chList.find((c) => c.id === event.channelId);
        if (matched) {
          channelName = matched.name;
          break;
        }
      }

      const authorName =
        event.message.author?.display_name ??
        event.message.author?.username ??
        event.message.author_id.slice(0, 8);
      const rawSnippet = event.message.content.trim();
      const snippet = rawSnippet
        ? rawSnippet.length > 90
          ? `${rawSnippet.slice(0, 87)}...`
          : rawSnippet
        : event.message.parsed_attachments.length > 0
          ? "Enviou um anexo"
          : "Nova mensagem";

      setChatToast({
        id: event.message.id,
        kind: "channel",
        channelId: event.channelId,
        channelName,
        authorName,
        authorAvatarUrl: event.message.author?.avatar_url ?? null,
        authorAccentColor: event.message.author?.card_accent_color ?? "#EF4444",
        snippet,
      });

      if (chatToastTimerRef.current) {
        clearTimeout(chatToastTimerRef.current);
      }
      chatToastTimerRef.current = setTimeout(() => {
        setChatToast((curr) => (curr?.id === event.message.id ? null : curr));
      }, 4500);
    });

    const unsubscribeDm = onIncomingDmNotification((event) => {
      const currentStatus = usePresenceStore.getState().localStatus;
      const isDeafened = useVoiceStore.getState().deafened;
      if (currentStatus === "dnd" || isDeafened) return;

      playChatMessageSound();

      if (event.isActiveDm && event.isAtBottom && !chatCollapsedRef.current) {
        return;
      }

      const authorName =
        event.message.author?.display_name ??
        event.message.author?.username ??
        event.message.author_id.slice(0, 8);
      const rawSnippet = event.message.content.trim();
      const snippet = rawSnippet
        ? rawSnippet.length > 90
          ? `${rawSnippet.slice(0, 87)}...`
          : rawSnippet
        : event.message.parsed_attachments.length > 0
          ? "Enviou um anexo"
          : "Nova mensagem privada";

      setChatToast({
        id: event.message.id,
        kind: "dm",
        dmChannelId: event.dmChannelId,
        channelName: "DM",
        authorName,
        authorAvatarUrl: event.message.author?.avatar_url ?? null,
        authorAccentColor: event.message.author?.card_accent_color ?? "#EF4444",
        snippet,
      });

      if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
      chatToastTimerRef.current = setTimeout(() => {
        setChatToast((curr) => (curr?.id === event.message.id ? null : curr));
      }, 4500);
    });

    const unsubscribeFriendReq = onIncomingFriendRequest((friendship) => {
      const currentStatus = usePresenceStore.getState().localStatus;
      const isDeafened = useVoiceStore.getState().deafened;
      if (currentStatus === "dnd" || isDeafened) return;

      playFriendRequestSound();
      const authorName =
        friendship.otherUser?.display_name ??
        friendship.otherUser?.username ??
        "Novo amigo";

      setChatToast({
        id: `fr-${friendship.id}`,
        kind: "friend_request",
        channelName: "AMIZADE",
        authorName,
        authorAvatarUrl: friendship.otherUser?.avatar_url ?? null,
        authorAccentColor:
          friendship.otherUser?.card_accent_color ?? "#10B981",
        snippet: "Enviou um pedido de amizade para você!",
      });

      if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
      chatToastTimerRef.current = setTimeout(() => {
        setChatToast((curr) =>
          curr?.id === `fr-${friendship.id}` ? null : curr,
        );
      }, 5000);
    });

    return () => {
      unsubscribeChat();
      unsubscribeDm();
      unsubscribeFriendReq();
      if (chatToastTimerRef.current) {
        clearTimeout(chatToastTimerRef.current);
      }
    };
  }, [userId]);

  const pendingFriendRequestsCount = friendships.filter(
    (f) => f.status === "pending" && f.direction === "incoming",
  ).length;

  const totalDmUnreadCount = Object.entries(unreadByDm).reduce(
    (sum, [dmId, count]) => {
      if (viewMode === "home" && !chatCollapsed && dmId === activeDmChannelId) {
        return sum;
      }
      return sum + (count ?? 0);
    },
    0,
  );

  const totalHomeBadgeCount = pendingFriendRequestsCount + totalDmUnreadCount;

  const totalServerUnreadCount = Object.entries(unreadByChannel).reduce(
    (sum, [chId, info]) => {
      if (viewMode === "server" && !chatCollapsed && chId === activeChannelId) {
        return sum;
      }
      return sum + (info?.count ?? 0);
    },
    0,
  );

  const totalUnreadCount = totalServerUnreadCount + totalHomeBadgeCount;

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title =
      totalUnreadCount > 0 ? `(${totalUnreadCount}) Cafofo` : "Cafofo";
  }, [totalUnreadCount]);

  // Pausa animações CSS e repaints quando a janela está minimizada/na bandeja
  useEffect(() => {
    if (typeof document === "undefined") return;
    const syncVisibility = () => {
      document.documentElement.classList.toggle(
        "cafofo-window-hidden",
        document.hidden,
      );
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      document.documentElement.classList.remove("cafofo-window-hidden");
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const setUnfocused = () =>
      document.documentElement.classList.add("cafofo-window-unfocused");
    const setFocused = () => {
      if (!document.hidden) {
        document.documentElement.classList.remove("cafofo-window-unfocused");
      }
    };
    const onVisibility = () => {
      if (document.hidden) setUnfocused();
      else setFocused();
    };
    window.addEventListener("blur", setUnfocused);
    window.addEventListener("focus", setFocused);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", setUnfocused);
      window.removeEventListener("focus", setFocused);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    const handleResetLayout = () => {
      setLeftDrawerOpen(false);
      setRightDrawerOpen(false);
      setChatCollapsed(false);
      setProfileOpen(false);
      setCreateServerOpen(false);
      setJoinInviteOpen(false);
      setCreateChannelOpen(false);
      setRolesManagerServerId(null);
      setRenamingChannel(null);
      setDeletingChannel(null);
      setServerConfirmAction(null);
      setInspectedVoiceCard(null);
      setKickVoiceCandidate(null);
      setDraggingVoiceUser(null);
      setDragOverChannelId(null);
    };
    window.addEventListener("cafofo:reset-layout", handleResetLayout);
    return () => {
      window.removeEventListener("cafofo:reset-layout", handleResetLayout);
    };
  }, []);

  if (!initialized) {
    return (
      <div className="h-[100dvh] w-full overflow-x-hidden flex flex-col bg-[#09090B] text-[#FAFAFA] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] select-none animate-cafofo-boot">
        <WindowTitlebar />
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <img
            src="/logo-full.png"
            alt="Cafofo"
            className="w-28 h-28 rounded-3xl object-cover shadow-crimson-glow border border-[#EF4444]/35 animate-radar-pulse-crimson"
          />
          <span className="text-xs font-mono tracking-wider text-[#A1A1AA]">
            INICIALIZANDO CAFOFO...
          </span>
        </div>
      </div>
    );
  }

  if (authError && !user) {
    return (
      <div className="h-[100dvh] w-full overflow-x-hidden flex flex-col bg-[#09090B] text-[#FAFAFA] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        <WindowTitlebar />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-lg w-full rounded-2xl bg-[#101014] hairline-box p-6 space-y-3 text-xs">
            <h1 className="text-sm font-semibold text-[#F87171]">
              Configuração Supabase Pendente
            </h1>
            <p className="text-[#A1A1AA] font-mono">{authError}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-[100dvh] w-full flex flex-col bg-[#09090B] overflow-hidden">
        <WindowTitlebar />
        <div className="flex-1 min-h-0 overflow-y-auto">
          <AuthScreen />
        </div>
        <UpdateBanner updater={updater} />
      </div>
    );
  }

  const activeServer = servers.find((s) => s.id === activeServerId) ?? null;
  const textChannels = channels.filter((c) => c.type === "text");
  const voiceChannels = channels.filter((c) => c.type === "voice");
  const activeChannel =
    channels.find((c) => c.id === activeChannelId) ?? textChannels[0] ?? null;

  const currentMembership = members.find((m) => m.user_id === user.id);
  const isOwner =
    activeServer?.owner_id === user.id || currentMembership?.role === "owner";
  const isOwnerOrAdmin = isOwner || currentMembership?.role === "admin";

  const handleRenameChannel = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeServer || !renamingChannel) return;
    setSocialError(null);
    try {
      await renameChannel({
        serverId: activeServer.id,
        channelId: renamingChannel.id,
        name: renameChannelInput,
      });
      setRenamingChannel(null);
      setRenameChannelInput("");
    } catch (err) {
      setSocialError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmDeleteChannel = async () => {
    if (!activeServer || !deletingChannel) return;
    setSocialError(null);
    try {
      if (deletingChannel.id === activeVoiceChannelId) {
        await leaveVoiceChannel();
      }
      await deleteChannel({
        serverId: activeServer.id,
        channelId: deletingChannel.id,
      });
      setDeletingChannel(null);
    } catch (err) {
      setSocialError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmServerAction = async () => {
    if (!serverConfirmAction) return;
    setSocialError(null);
    const { type, server } = serverConfirmAction;
    try {
      const serverChannelIds = (channelsByServer[server.id] ?? EMPTY_CHANNELS).map(
        (c) => c.id,
      );
      if (
        activeVoiceChannelId &&
        serverChannelIds.includes(activeVoiceChannelId)
      ) {
        await leaveVoiceChannel();
      }
      if (type === "delete") {
        await deleteServer(server.id);
      } else {
        await leaveServer(server.id);
      }
      setServerConfirmAction(null);
    } catch (err) {
      setSocialError(err instanceof Error ? err.message : String(err));
    }
  };

  const getVoiceChannelParticipants = (channelId: string) => {
    type VoiceParticipantItem = {
      userId: string;
      displayName: string;
      initials: string;
      avatarUrl: string | null;
      avatarFrame: "none" | "crimson-pulse" | "cyber-cut" | "double-neon";
      accentColor: string;
      muted: boolean;
      deafened: boolean;
      speaking: boolean;
      isStreaming: boolean;
    };

    const byUser = new Map<string, VoiceParticipantItem>();

    const buildItem = (
      uid: string,
      opts: {
        fallbackName?: string;
        muted: boolean;
        deafened: boolean;
        speaking: boolean;
        isStreaming: boolean;
      },
    ): VoiceParticipantItem => {
      const member = members.find((m) => m.user_id === uid);
      const prof = member?.profile ?? (uid === user.id ? profile : null);
      const displayName =
        member?.nickname ||
        prof?.display_name ||
        prof?.username ||
        opts.fallbackName ||
        (uid === user.id ? user.email : null) ||
        "Membro";
      return {
        userId: uid,
        displayName,
        initials: displayName.slice(0, 2).toUpperCase(),
        avatarUrl: prof?.avatar_url ?? null,
        avatarFrame: prof?.avatar_frame ?? "none",
        accentColor: prof?.card_accent_color ?? "#B91C1C",
        muted: opts.muted,
        deafened: opts.deafened,
        speaking: opts.speaking,
        isStreaming: opts.isStreaming,
      };
    };

    for (const presence of Object.values(onlineMap)) {
      if (presence.user_id === user.id && channelId !== activeVoiceChannelId) {
        continue;
      }
      if (presence.voice_state?.channel_id === channelId) {
        byUser.set(
          presence.user_id,
          buildItem(presence.user_id, {
            fallbackName: presence.voice_state.display_name,
            muted: presence.voice_state.muted,
            deafened: presence.voice_state.deafened,
            speaking: presence.voice_state.speaking,
            isStreaming: presence.voice_state.is_streaming,
          }),
        );
      }
    }

    if (channelId === activeVoiceChannelId) {
      byUser.set(
        user.id,
        buildItem(user.id, {
          fallbackName: profile?.display_name ?? profile?.username ?? "Você",
          muted: voiceMuted,
          deafened: voiceDeafened,
          speaking: voiceSpeaking,
          isStreaming: Boolean(sharingWindow),
        }),
      );

      for (const peer of Object.values(voicePeers)) {
        if (peer.user_id === user.id) continue;
        const presenceChannel =
          onlineMap[peer.user_id]?.voice_state?.channel_id ?? null;
        if (presenceChannel && presenceChannel !== channelId) {
          continue;
        }
        const presenceVoice = onlineMap[peer.user_id]?.voice_state;
        byUser.set(
          peer.user_id,
          buildItem(peer.user_id, {
            fallbackName: peer.display_name,
            muted: peer.muted || Boolean(presenceVoice?.muted),
            deafened: peer.deafened || Boolean(presenceVoice?.deafened),
            speaking: peer.speaking || Boolean(presenceVoice?.speaking),
            isStreaming: Boolean(
              peer.screen_sharing ||
                presenceVoice?.is_streaming ||
                remoteVideoByUser[peer.user_id],
            ),
          }),
        );
      }
    }

    return Array.from(byUser.values()).sort((a, b) => {
      if (a.userId === user.id) return -1;
      if (b.userId === user.id) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  };

  const handleVoiceChannelDrop = (
    e: DragEvent<HTMLDivElement>,
    targetChannel: ChannelRow,
  ) => {
    e.preventDefault();
    setDragOverChannelId(null);

    let payload = draggingVoiceUser;
    if (!payload) {
      try {
        const raw = e.dataTransfer.getData("text/plain");
        if (raw) {
          payload = JSON.parse(raw) as {
            userId: string;
            sourceChannelId: string;
          };
        }
      } catch {
        payload = null;
      }
    }
    setDraggingVoiceUser(null);

    if (!payload || !activeServer || payload.sourceChannelId === targetChannel.id) {
      return;
    }

    if (payload.userId === user.id) {
      void joinVoiceChannel({
        channelId: targetChannel.id,
        channelName: targetChannel.name,
      });
    } else if (isOwnerOrAdmin) {
      movePeerToRoom({
        serverId: activeServer.id,
        sourceRoomId: payload.sourceChannelId,
        targetRoomId: targetChannel.id,
        targetUserId: payload.userId,
      });
    }
  };

  const handleCreateServer = async (e: FormEvent) => {
    e.preventDefault();
    setSocialError(null);
    try {
      await createServer({ name: newServerName });
      setNewServerName("");
      setCreateServerOpen(false);
    } catch (err) {
      setSocialError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleJoinInvite = async (e: FormEvent) => {
    e.preventDefault();
    setSocialError(null);
    try {
      await joinByInviteCode(inviteInput);
      setInviteInput("");
      setJoinInviteOpen(false);
    } catch (err) {
      setSocialError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateChannel = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeServer) return;
    setSocialError(null);
    try {
      await createChannel({
        serverId: activeServer.id,
        name: newChannelName,
        type: newChannelType,
      });
      setNewChannelName("");
      setCreateChannelOpen(false);
    } catch (err) {
      setSocialError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyInvite = async () => {
    if (!activeServer?.invite_code) return;
    const cleanCode = activeServer.invite_code.trim().replace(/^#+/, "");
    await copyPlainText(cleanCode);
    setCopiedInvite(true);
    setTimeout(() => setCopiedInvite(false), 1800);
  };

  const triggerServerIconUpload = (srv: ServerRow) => {
    pendingServerIconMetaRef.current = {
      serverId: srv.id,
      serverName: srv.name,
    };
    serverIconInputRef.current?.click();
  };

  const onlineCount = Object.values(onlineMap).filter(
    (entry) => entry.status !== "offline",
  ).length;

  const handleSelectPresenceStatus = (nextStatus: PresenceStatus) => {
    void setLocalPresenceStatus(nextStatus, user.id);
    void updateAuthStatus(nextStatus);
  };

  const selfStatusDotClass =
    localPresenceStatus === "online"
      ? "bg-emerald-400"
      : localPresenceStatus === "idle"
        ? "bg-amber-400"
        : localPresenceStatus === "dnd"
          ? "bg-[#EF4444]"
          : "bg-[#52525B]";

  const selfStatusLabel =
    localPresenceStatus === "online"
      ? "Online"
      : localPresenceStatus === "idle"
        ? "Ausente"
        : localPresenceStatus === "dnd"
          ? "Não Perturbe"
          : "Invisível";

  const handleSignOut = async () => {
    await leaveVoiceChannel();
    await unbindServerPresence();
    await unsubscribeAllChats();
    await resetFriends();
    await resetServers();
    await signOut();
  };

  const userInitials = (
    profile?.display_name ||
    profile?.username ||
    user.email ||
    "CF"
  )
    .slice(0, 2)
    .toUpperCase();

  return (
    <Tooltip.Provider delayDuration={150}>
      <div className="h-[100dvh] w-full max-w-full overflow-x-hidden overflow-y-hidden flex flex-col bg-[#09090B] text-[#FAFAFA] pt-[env(safe-area-inset-top)] animate-cafofo-boot">
        <WindowTitlebar inVoiceCall={Boolean(activeVoiceChannelId)} />
        {/* Layout principal */}
        <div className="flex-1 flex min-h-0 relative">
          {/* Backdrop Mobile para Gavetas Deslizantes */}
          {(leftDrawerOpen || rightDrawerOpen) && (
            <div
              className="fixed inset-0 bg-black/75 z-40 md:hidden"
              onClick={() => {
                setLeftDrawerOpen(false);
                setRightDrawerOpen(false);
              }}
              aria-hidden="true"
            />
          )}

          {/* Gaveta Esquerda (< 768px) / Colunas 1+2 Fixas (Desktop >= 768px): Rail de Servidores + Canais */}
          <div
            className={`fixed inset-y-0 left-0 z-50 flex max-w-[calc(100vw-24px)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] transition-transform duration-200 md:static md:inset-auto md:z-auto md:pt-0 md:pb-0 md:translate-x-0 ${
              leftDrawerOpen
                ? "translate-x-0"
                : "-translate-x-full pointer-events-none md:pointer-events-auto"
            }`}
          >
            {/* Coluna 1: Rail Compacto de Servidores (#09090B) */}
            <nav
              aria-label="Servidores"
              className="w-[60px] xl:w-[68px] bg-[#09090B] hairline-r py-3 flex flex-col items-center justify-between select-none shrink-0"
            >
              <div className="w-full flex flex-col items-center gap-2.5 overflow-y-auto px-2">
                {/* Botão Home / Amigos & Mensagens Diretas */}
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setViewMode("home");
                        setChatCollapsed(false);
                      }}
                      className="relative group w-full min-h-[44px] flex items-center justify-center mb-1"
                      aria-label="Amigos e Mensagens Diretas"
                    >
                      <span
                        className={`absolute left-0 w-1 rounded-r-full bg-[#B91C1C] transition-all ${
                          viewMode === "home"
                            ? "h-6 opacity-100"
                            : "h-2 opacity-0 group-hover:opacity-60"
                        }`}
                      />
                      <div
                        className={`relative w-11 h-11 rounded-2xl flex items-center justify-center overflow-hidden transition-all ${
                          viewMode === "home"
                            ? "ring-2 ring-[#EF4444] shadow-crimson-glow"
                            : "hairline-box opacity-90 hover:opacity-100"
                        }`}
                      >
                        <img
                          src="/logo-icon.png"
                          alt="Cafofo"
                          className="w-full h-full object-cover"
                        />
                        {totalHomeBadgeCount > 0 && (
                          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-[#EF4444] border-2 border-[#09090B] font-mono text-[9px] font-bold text-white flex items-center justify-center leading-none">
                            {totalHomeBadgeCount > 99 ? "99+" : totalHomeBadgeCount}
                          </span>
                        )}
                      </div>
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      side="right"
                      sideOffset={10}
                      className="px-2.5 py-1.5 rounded-lg bg-[#101014] hairline-box text-xs font-medium text-[#FAFAFA] shadow-xl z-50"
                    >
                      Amigos & Mensagens Diretas
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>

                <div className="w-7 h-[1px] bg-white/[0.07]" />

                {/* Lista de servidores */}
                {servers.map((srv) => {
                  const isActive =
                    viewMode === "server" && srv.id === activeServerId;
                  const monogram = srv.name.slice(0, 2).toUpperCase();
                  const srvMembers = membersByServer[srv.id] ?? EMPTY_MEMBERS;
                  const srvMembership = srvMembers.find(
                    (m) => m.user_id === user.id,
                  );
                  const srvIsOwner =
                    srv.owner_id === user.id || srvMembership?.role === "owner";
                  const srvIsAdmin =
                    srvIsOwner || srvMembership?.role === "admin";

                  return (
                    <ContextMenu.Root key={srv.id}>
                      <Tooltip.Root>
                        <ContextMenu.Trigger asChild>
                          <Tooltip.Trigger asChild>
                            <button
                              type="button"
                              onClick={() => {
                                setViewMode("server");
                                selectDmChannel(null);
                                void selectServer(srv.id);
                              }}
                              className="relative group w-full min-h-[44px] flex items-center justify-center"
                            >
                              {/* Pílula Lateral Carmesim (#B91C1C) */}
                              <span
                                className={`absolute left-0 w-1 rounded-r-full bg-[#B91C1C] transition-all ${
                                  isActive
                                    ? "h-6 opacity-100"
                                    : "h-2 opacity-0 group-hover:opacity-60"
                                }`}
                              />

                              <div
                                className={`w-11 h-11 rounded-2xl flex items-center justify-center text-xs font-semibold transition-all overflow-hidden ${
                                  isActive
                                    ? "bg-[#B91C1C] text-[#FAFAFA] shadow-crimson-glow"
                                    : "bg-[#101014] hover:bg-[#16161C] text-[#A1A1AA] hover:text-[#FAFAFA] hairline-box"
                                }`}
                              >
                                {srv.icon_url ? (
                                  <img
                                    src={srv.icon_url}
                                    alt={srv.name}
                                    className="w-full h-full object-cover"
                                  />
                                ) : (
                                  monogram
                                )}
                              </div>
                            </button>
                          </Tooltip.Trigger>
                        </ContextMenu.Trigger>
                        <Tooltip.Portal>
                          <Tooltip.Content
                            side="right"
                            sideOffset={10}
                            className="px-2.5 py-1.5 rounded-lg bg-[#101014] hairline-box text-xs font-medium text-[#FAFAFA] shadow-xl z-50"
                          >
                            {srv.name}
                          </Tooltip.Content>
                        </Tooltip.Portal>
                      </Tooltip.Root>

                      <ContextMenu.Portal>
                        <ContextMenu.Content className="min-w-[210px] rounded-xl bg-[#101014] hairline-box p-1.5 shadow-2xl z-50 text-xs text-[#FAFAFA]">
                          <ContextMenu.Item
                            onSelect={() => {
                              const clean = srv.invite_code
                                .trim()
                                .replace(/^#+/, "");
                              void copyPlainText(clean);
                              setCopiedInvite(true);
                              setTimeout(() => setCopiedInvite(false), 1800);
                            }}
                            className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer hover:bg-[#16161C] focus:bg-[#16161C]"
                          >
                            <Copy
                              className="w-3.5 h-3.5 text-[#A1A1AA]"
                              strokeWidth={1.5}
                            />
                            <span>Copiar Código de Convite</span>
                          </ContextMenu.Item>

                          {srvIsAdmin && (
                            <>
                              <ContextMenu.Item
                                onSelect={() => triggerServerIconUpload(srv)}
                                className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer hover:bg-[#16161C] focus:bg-[#16161C]"
                              >
                                <ImagePlus
                                  className="w-3.5 h-3.5 text-[#EF4444]"
                                  strokeWidth={1.5}
                                />
                                <span>Alterar Ícone do Servidor</span>
                              </ContextMenu.Item>

                              <ContextMenu.Item
                                onSelect={() => {
                                  void selectServer(srv.id);
                                  setRolesManagerServerId(srv.id);
                                }}
                                className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer hover:bg-[#16161C] focus:bg-[#16161C]"
                              >
                                <Tag
                                  className="w-3.5 h-3.5 text-[#EF4444]"
                                  strokeWidth={1.5}
                                />
                                <span>Gerenciar Cargos & Tags</span>
                              </ContextMenu.Item>

                              <ContextMenu.Item
                                onSelect={() => {
                                  void regenerateInviteCode(srv.id).catch((err) =>
                                    setSocialError(
                                      err instanceof Error
                                        ? err.message
                                        : String(err),
                                    ),
                                  );
                                }}
                                className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer hover:bg-[#16161C] focus:bg-[#16161C]"
                              >
                                <RefreshCw
                                  className="w-3.5 h-3.5 text-[#A1A1AA]"
                                  strokeWidth={1.5}
                                />
                                <span>Gerar Novo Convite</span>
                              </ContextMenu.Item>
                            </>
                          )}

                          <ContextMenu.Separator className="my-1 h-[1px] bg-white/[0.07]" />

                          {srvIsOwner ? (
                            <ContextMenu.Item
                              onSelect={() => {
                                setSocialError(null);
                                setServerConfirmAction({
                                  type: "delete",
                                  server: srv,
                                });
                              }}
                              className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer text-[#F87171] hover:bg-[#7F1D1D]/30 focus:bg-[#7F1D1D]/30"
                            >
                              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                              <span>Excluir Servidor</span>
                            </ContextMenu.Item>
                          ) : (
                            <ContextMenu.Item
                              onSelect={() => {
                                setSocialError(null);
                                setServerConfirmAction({
                                  type: "leave",
                                  server: srv,
                                });
                              }}
                              className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer text-[#F87171] hover:bg-[#7F1D1D]/30 focus:bg-[#7F1D1D]/30"
                            >
                              <LogOut className="w-3.5 h-3.5" strokeWidth={1.5} />
                              <span>Sair do Servidor</span>
                            </ContextMenu.Item>
                          )}
                        </ContextMenu.Content>
                      </ContextMenu.Portal>
                    </ContextMenu.Root>
                  );
                })}
              </div>

              {/* Ações de Servidor (Criar / Entrar por Convite) */}
              <div className="flex flex-col items-center gap-2 pt-2">
                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setSocialError(null);
                        setCreateServerOpen(true);
                      }}
                      className="w-10 h-10 rounded-xl bg-[#101014] hover:bg-[#B91C1C] text-[#A1A1AA] hover:text-[#FAFAFA] hairline-box flex items-center justify-center transition-colors"
                      aria-label="Criar Novo Servidor"
                    >
                      <Plus className="w-4 h-4" strokeWidth={1.5} />
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      side="right"
                      sideOffset={10}
                      className="px-2.5 py-1.5 rounded-lg bg-[#101014] hairline-box text-xs text-[#FAFAFA] shadow-xl z-50"
                    >
                      Criar Novo Servidor
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>

                <Tooltip.Root>
                  <Tooltip.Trigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setSocialError(null);
                        setJoinInviteOpen(true);
                      }}
                      className="w-10 h-10 rounded-xl bg-[#101014] hover:bg-[#16161C] text-[#A1A1AA] hover:text-[#FAFAFA] hairline-box flex items-center justify-center transition-colors"
                      aria-label="Entrar com Código de Convite"
                    >
                      <KeyRound className="w-4 h-4" strokeWidth={1.5} />
                    </button>
                  </Tooltip.Trigger>
                  <Tooltip.Portal>
                    <Tooltip.Content
                      side="right"
                      sideOffset={10}
                      className="px-2.5 py-1.5 rounded-lg bg-[#101014] hairline-box text-xs text-[#FAFAFA] shadow-xl z-50"
                    >
                      Entrar com Código de Convite
                    </Tooltip.Content>
                  </Tooltip.Portal>
                </Tooltip.Root>
              </div>
            </nav>

            {/* Coluna 2: Sidebar de Canais ou Mensagens Diretas + Rodapé de Perfil (#101014) */}
            <aside className="w-[216px] xl:w-60 bg-[#101014] hairline-r flex flex-col justify-between text-xs select-none shrink-0">
              {viewMode === "home" ? (
                <>
                  {/* Header Home / Mensagens Diretas */}
                  <div className="h-14 px-3.5 crimson-header-glow crimson-header-animated-border hairline-b flex items-center justify-between gap-2 shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <Users className="w-4 h-4 text-[#EF4444] shrink-0" strokeWidth={1.75} />
                      <h1 className="text-sm font-semibold text-[#FAFAFA] truncate">
                        Social & DMs
                      </h1>
                    </div>
                    <button
                      type="button"
                      onClick={() => setLeftDrawerOpen(false)}
                      className="md:hidden min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center justify-center"
                      aria-label="Fechar barra lateral"
                    >
                      <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-3 space-y-4">
                    {/* Botão Principal: Amigos */}
                    <button
                      type="button"
                      onClick={() => {
                        selectDmChannel(null);
                        setChatCollapsed(false);
                        setLeftDrawerOpen(false);
                      }}
                      className={`relative w-full min-h-[42px] px-3 py-2 rounded-xl flex items-center justify-between gap-2 transition-colors ${
                        activeDmChannelId === null
                          ? "bg-[#16161C] text-[#FAFAFA] font-semibold border border-[#B91C1C]/50"
                          : "text-[#A1A1AA] hover:bg-[#16161C]/70 hover:text-[#FAFAFA]"
                      }`}
                    >
                      <span className="flex items-center gap-2.5">
                        <Users
                          className={`w-4 h-4 ${
                            activeDmChannelId === null
                              ? "text-[#EF4444]"
                              : "text-[#71717A]"
                          }`}
                          strokeWidth={1.75}
                        />
                        <span>Amigos</span>
                      </span>
                      {pendingFriendRequestsCount > 0 && (
                        <span className="px-1.5 py-0.5 rounded-full bg-[#B91C1C] font-mono text-[10px] leading-none font-semibold text-white">
                          {pendingFriendRequestsCount}
                        </span>
                      )}
                    </button>

                    {/* Lista de Mensagens Diretas */}
                    <div className="space-y-1">
                      <div className="px-2 flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-[#71717A]">
                        <span>Mensagens Diretas</span>
                        <span>{dmChannels.length}</span>
                      </div>

                      {dmChannels.length === 0 ? (
                        <p className="px-2 py-4 text-[11px] text-[#71717A] leading-relaxed">
                          Nenhuma conversa privada ainda. Adicione amigos ou clique em um amigo para conversar.
                        </p>
                      ) : (
                        dmChannels.map((dm) => {
                          const isActive =
                            dm.id === activeDmChannelId && !chatCollapsed;
                          const unread = unreadByDm[dm.id] ?? 0;
                          const peerName =
                            dm.otherUser?.display_name ||
                            dm.otherUser?.username ||
                            dm.otherUserId.slice(0, 8);
                          const pres =
                            friendPresenceByUser[dm.otherUserId]?.status ??
                            onlineMap[dm.otherUserId]?.status ??
                            "offline";
                          const dotCls =
                            pres === "online"
                              ? "bg-emerald-400"
                              : pres === "idle"
                                ? "bg-amber-400"
                                : pres === "dnd"
                                  ? "bg-[#EF4444]"
                                  : "bg-[#52525B]";

                          return (
                            <button
                              key={dm.id}
                              type="button"
                              onClick={() => {
                                selectDmChannel(dm.id);
                                setChatCollapsed(false);
                                setLeftDrawerOpen(false);
                              }}
                              className={`relative w-full min-h-[44px] px-2.5 py-1.5 rounded-xl flex items-center gap-2.5 text-left transition-colors ${
                                isActive
                                  ? "bg-[#16161C] text-[#FAFAFA] font-medium"
                                  : unread > 0
                                    ? "text-[#FAFAFA] font-medium hover:bg-[#16161C]/60"
                                    : "text-[#A1A1AA] hover:bg-[#16161C]/60 hover:text-[#FAFAFA]"
                              }`}
                            >
                              {isActive && (
                                <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-[#B91C1C]" />
                              )}
                              <div className="relative shrink-0">
                                <AvatarWithFrame
                                  avatarUrl={dm.otherUser?.avatar_url}
                                  initials={peerName.slice(0, 2).toUpperCase()}
                                  frame={dm.otherUser?.avatar_frame ?? "none"}
                                  accentColor={
                                    dm.otherUser?.card_accent_color ?? "#B91C1C"
                                  }
                                  sizePx={30}
                                />
                                <span
                                  className={`w-2.5 h-2.5 rounded-full absolute -bottom-0.5 -right-0.5 border-2 border-[#101014] ${dotCls}`}
                                />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="text-xs truncate">{peerName}</div>
                                {dm.lastMessagePreview && (
                                  <div className="text-[10px] text-[#71717A] truncate">
                                    {dm.lastMessagePreview}
                                  </div>
                                )}
                              </div>
                              {!isActive && unread > 0 && (
                                <span className="px-1.5 py-0.5 min-w-[18px] text-center rounded-full bg-[#B91C1C] border border-[#EF4444]/60 font-mono text-[10px] leading-none font-semibold text-white shrink-0">
                                  {unread > 99 ? "99+" : unread}
                                </span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                </>
              ) : activeServer ? (
                <>
                  {/* Header do Servidor com Brilho Radial Carmesim + Borda Animada */}
                  <div className="h-14 px-3 sm:px-3.5 crimson-header-glow crimson-header-animated-border hairline-b flex items-center justify-between gap-2 shrink-0">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <button
                        type="button"
                        disabled={!isOwnerOrAdmin}
                        onClick={() => {
                          if (isOwnerOrAdmin) {
                            triggerServerIconUpload(activeServer);
                          }
                        }}
                        className={`group/srvicon relative w-8 h-8 rounded-xl bg-[#16161C] hairline-box flex items-center justify-center text-[11px] font-semibold text-[#FAFAFA] overflow-hidden shrink-0 ${
                          isOwnerOrAdmin
                            ? "cursor-pointer hover:border-[#EF4444]/60"
                            : "cursor-default"
                        }`}
                        title={
                          isOwnerOrAdmin
                            ? "Clique para alterar o ícone do servidor"
                            : activeServer.name
                        }
                      >
                        {activeServer.icon_url ? (
                          <img
                            src={activeServer.icon_url}
                            alt={activeServer.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          activeServer.name.slice(0, 2).toUpperCase()
                        )}
                        {isOwnerOrAdmin && (
                          <span className="absolute inset-0 bg-black/65 opacity-0 group-hover/srvicon:opacity-100 transition-opacity flex items-center justify-center">
                            <ImagePlus
                              className="w-3.5 h-3.5 text-[#FAFAFA]"
                              strokeWidth={1.75}
                            />
                          </span>
                        )}
                      </button>

                      <div className="min-w-0">
                        <h1 className="text-sm font-semibold text-[#FAFAFA] truncate">
                          {activeServer.name}
                        </h1>
                        <button
                          type="button"
                          onClick={() => void handleCopyInvite()}
                          className="mt-0.5 flex items-center gap-1 font-mono text-[10px] text-[#A1A1AA] hover:text-[#FAFAFA] transition-colors"
                          title="Copiar código de convite (sem #)"
                        >
                          <span>{activeServer.invite_code}</span>
                          {copiedInvite ? (
                            <Check
                              className="w-3 h-3 text-emerald-400"
                              strokeWidth={1.75}
                            />
                          ) : (
                            <Copy className="w-2.5 h-2.5" strokeWidth={1.5} />
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {isOwnerOrAdmin && (
                        <button
                          type="button"
                          onClick={() => setRolesManagerServerId(activeServer.id)}
                          className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center justify-center"
                          title="Configurações de Cargos e Tags do Servidor"
                          aria-label="Gerenciar Cargos e Tags"
                        >
                          <Tag className="w-3.5 h-3.5 text-[#EF4444]" strokeWidth={1.5} />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setSocialError(null);
                          setCreateChannelOpen(true);
                        }}
                        className="min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center justify-center"
                        title="Novo Canal"
                      >
                        <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setLeftDrawerOpen(false)}
                        className="md:hidden min-h-[36px] min-w-[36px] p-1.5 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center justify-center"
                        aria-label="Fechar barra lateral"
                      >
                        <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </button>
                    </div>
                  </div>

                  {/* Canais de texto e voz */}
                  <div className="flex-1 overflow-y-auto p-3 space-y-5">
                    {/* Seção Texto */}
                    <div className="space-y-1">
                      <div className="px-2 flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-[#71717A]">
                        <span>Canais de Texto</span>
                        <span>{textChannels.length}</span>
                      </div>

                      {textChannels.map((ch) => {
                        const isActive = ch.id === activeChannel?.id && !chatCollapsed;
                        const isLastTextChannel = textChannels.length <= 1;
                        const unreadCount = unreadByChannel[ch.id]?.count ?? 0;
                        const hasUnread = !isActive && unreadCount > 0;

                        return (
                          <ContextMenu.Root key={ch.id}>
                            <ContextMenu.Trigger asChild>
                              <button
                                type="button"
                                onClick={() => {
                                  selectChannel(ch.id);
                                  setChatCollapsed(false);
                                  setLeftDrawerOpen(false);
                                }}
                                className={`relative w-full min-h-[40px] text-left px-2.5 py-1.5 rounded-lg flex items-center gap-2 transition-colors ${
                                  isActive
                                    ? "bg-[#16161C] text-[#FAFAFA] font-medium"
                                    : hasUnread
                                      ? "text-[#FAFAFA] font-medium hover:bg-[#16161C]/60"
                                      : "text-[#A1A1AA] hover:bg-[#16161C]/60 hover:text-[#FAFAFA]"
                                }`}
                              >
                                {isActive && (
                                  <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-[#B91C1C]" />
                                )}
                                <Hash
                                  className={`w-3.5 h-3.5 shrink-0 ${
                                    isActive || hasUnread
                                      ? "text-[#EF4444]"
                                      : "text-[#71717A]"
                                  }`}
                                  strokeWidth={1.5}
                                />
                                <span className="truncate flex-1">{ch.name}</span>
                                {hasUnread && (
                                  <span
                                    className="px-1.5 py-0.5 min-w-[18px] text-center rounded-full bg-[#B91C1C] border border-[#EF4444]/60 shadow-[0_0_10px_rgba(185,28,28,0.8)] font-mono text-[10px] leading-none font-semibold text-[#FAFAFA] shrink-0"
                                    title={`${unreadCount} ${unreadCount === 1 ? "nova mensagem" : "novas mensagens"}`}
                                  >
                                    {unreadCount > 99 ? "99+" : unreadCount}
                                  </span>
                                )}
                              </button>
                            </ContextMenu.Trigger>

                            <ContextMenu.Portal>
                              <ContextMenu.Content className="min-w-[196px] rounded-xl bg-[#101014] hairline-box p-1.5 shadow-2xl z-50 text-xs text-[#FAFAFA]">
                                {isOwnerOrAdmin && (
                                  <ContextMenu.Item
                                    onSelect={() => {
                                      setSocialError(null);
                                      setRenamingChannel(ch);
                                      setRenameChannelInput(ch.name);
                                    }}
                                    className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer hover:bg-[#16161C] focus:bg-[#16161C]"
                                  >
                                    <Pencil
                                      className="w-3.5 h-3.5 text-[#A1A1AA]"
                                      strokeWidth={1.5}
                                    />
                                    <span>Renomear Canal</span>
                                  </ContextMenu.Item>
                                )}

                                <ContextMenu.Item
                                  onSelect={() => void copyPlainText(ch.id)}
                                  className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer hover:bg-[#16161C] focus:bg-[#16161C]"
                                >
                                  <Copy
                                    className="w-3.5 h-3.5 text-[#A1A1AA]"
                                    strokeWidth={1.5}
                                  />
                                  <span>Copiar ID do Canal</span>
                                </ContextMenu.Item>

                                {isOwnerOrAdmin && (
                                  <>
                                    <ContextMenu.Separator className="my-1 h-[1px] bg-white/[0.07]" />
                                    <ContextMenu.Item
                                      disabled={isLastTextChannel}
                                      onSelect={() => {
                                        if (isLastTextChannel) return;
                                        setSocialError(null);
                                        setDeletingChannel(ch);
                                      }}
                                      className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg outline-none ${
                                        isLastTextChannel
                                          ? "text-[#52525B] cursor-not-allowed"
                                          : "text-[#F87171] cursor-pointer hover:bg-[#7F1D1D]/30 focus:bg-[#7F1D1D]/30"
                                      }`}
                                    >
                                      <span className="flex items-center gap-2">
                                        <Trash2
                                          className="w-3.5 h-3.5"
                                          strokeWidth={1.5}
                                        />
                                        <span>Excluir Canal</span>
                                      </span>
                                      {isLastTextChannel && (
                                        <span className="font-mono text-[9px] text-[#52525B]">
                                          ÚLTIMO
                                        </span>
                                      )}
                                    </ContextMenu.Item>
                                  </>
                                )}
                              </ContextMenu.Content>
                            </ContextMenu.Portal>
                          </ContextMenu.Root>
                        );
                      })}
                    </div>

                    {/* Seção Voz + Participantes + Drag & Drop */}
                    <div className="space-y-1">
                      <div className="px-2 flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-[#71717A]">
                        <span>Salas de Voz</span>
                        <span>{voiceChannels.length}</span>
                      </div>

                      {voiceChannels.map((ch) => {
                        const isConnected = ch.id === activeVoiceChannelId;
                        const participants = getVoiceChannelParticipants(ch.id);
                        const isDropHighlighted =
                          dragOverChannelId === ch.id &&
                          draggingVoiceUser?.sourceChannelId !== ch.id;

                        return (
                          <div
                            key={ch.id}
                            onDragOver={(e) => {
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                              if (dragOverChannelId !== ch.id) {
                                setDragOverChannelId(ch.id);
                              }
                            }}
                            onDragLeave={() => {
                              if (dragOverChannelId === ch.id) {
                                setDragOverChannelId(null);
                              }
                            }}
                            onDrop={(e) => handleVoiceChannelDrop(e, ch)}
                            className={`rounded-xl transition-all ${
                              isDropHighlighted
                                ? "ring-1 ring-[#EF4444] bg-[#B91C1C]/15 p-0.5"
                                : ""
                            }`}
                          >
                            <ContextMenu.Root>
                              <ContextMenu.Trigger asChild>
                                <button
                                  type="button"
                                  onClick={() => {
                                    void joinVoiceChannel({
                                      channelId: ch.id,
                                      channelName: ch.name,
                                    });
                                    setLeftDrawerOpen(false);
                                  }}
                                  className={`relative w-full min-h-[40px] text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 transition-colors ${
                                    isConnected
                                      ? "animated-gradient-border bg-[#16161C] text-[#FAFAFA] font-medium"
                                      : "text-[#A1A1AA] hover:bg-[#16161C]/60 hover:text-[#FAFAFA]"
                                  }`}
                                >
                                  {isConnected && (
                                    <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-[#B91C1C]" />
                                  )}
                                  <div className="flex items-center gap-2 min-w-0">
                                    <Volume2
                                      className={`w-3.5 h-3.5 shrink-0 ${
                                        isConnected
                                          ? "text-[#EF4444]"
                                          : "text-[#71717A]"
                                      }`}
                                      strokeWidth={1.5}
                                    />
                                    <span className="truncate">{ch.name}</span>
                                  </div>
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    {participants.some((p) => p.isStreaming) && (
                                      <span
                                        className="px-1.5 py-0.5 rounded bg-[#7F1D1D]/85 border border-[#EF4444]/80 font-mono text-[8px] leading-none text-[#FAFAFA] flex items-center gap-1"
                                        title="Transmissão de tela ativa nesta sala"
                                      >
                                        <MonitorUp
                                          className="w-2.5 h-2.5"
                                          strokeWidth={1.75}
                                        />
                                        LIVE
                                      </span>
                                    )}
                                    {isConnected && (
                                      <span className="px-1.5 py-0.5 rounded bg-[#7F1D1D] border border-[#EF4444] font-mono text-[9px] text-[#FAFAFA] flex items-center gap-1">
                                        <Radio
                                          className="w-2.5 h-2.5"
                                          strokeWidth={1.5}
                                        />
                                        ON
                                      </span>
                                    )}
                                  </div>
                                </button>
                              </ContextMenu.Trigger>

                              <ContextMenu.Portal>
                                <ContextMenu.Content className="min-w-[196px] rounded-xl bg-[#101014] hairline-box p-1.5 shadow-2xl z-50 text-xs text-[#FAFAFA]">
                                  {isOwnerOrAdmin && (
                                    <ContextMenu.Item
                                      onSelect={() => {
                                        setSocialError(null);
                                        setRenamingChannel(ch);
                                        setRenameChannelInput(ch.name);
                                      }}
                                      className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer hover:bg-[#16161C] focus:bg-[#16161C]"
                                    >
                                      <Pencil
                                        className="w-3.5 h-3.5 text-[#A1A1AA]"
                                        strokeWidth={1.5}
                                      />
                                      <span>Renomear Canal</span>
                                    </ContextMenu.Item>
                                  )}

                                  <ContextMenu.Item
                                    onSelect={() => void copyPlainText(ch.id)}
                                    className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer hover:bg-[#16161C] focus:bg-[#16161C]"
                                  >
                                    <Copy
                                      className="w-3.5 h-3.5 text-[#A1A1AA]"
                                      strokeWidth={1.5}
                                    />
                                    <span>Copiar ID do Canal</span>
                                  </ContextMenu.Item>

                                  {isOwnerOrAdmin && (
                                    <>
                                      <ContextMenu.Separator className="my-1 h-[1px] bg-white/[0.07]" />
                                      <ContextMenu.Item
                                        onSelect={() => {
                                          setSocialError(null);
                                          setDeletingChannel(ch);
                                        }}
                                        className="flex items-center gap-2 px-2.5 py-2 rounded-lg outline-none cursor-pointer text-[#F87171] hover:bg-[#7F1D1D]/30 focus:bg-[#7F1D1D]/30"
                                      >
                                        <Trash2
                                          className="w-3.5 h-3.5"
                                          strokeWidth={1.5}
                                        />
                                        <span>Excluir Canal</span>
                                      </ContextMenu.Item>
                                    </>
                                  )}
                                </ContextMenu.Content>
                              </ContextMenu.Portal>
                            </ContextMenu.Root>

                            {participants.length > 0 && (
                              <div className="mt-1 ml-3 pl-2.5 border-l border-white/[0.07] space-y-1">
                                {participants.map((p) => {
                                  const isParticipantSelf = p.userId === user.id;
                                  const canDrag =
                                    isParticipantSelf || isOwnerOrAdmin;
                                  const participantMember =
                                    members.find((m) => m.user_id === p.userId) ??
                                    null;
                                  const realtime = onlineMap[p.userId];
                                  const realtimeStatus: PresenceStatus = isParticipantSelf
                                    ? localPresenceStatus
                                    : (realtime?.status ?? "offline");
                                  const activeGame =
                                    realtime?.game_presence ??
                                    gameByUser[p.userId] ??
                                    null;
                                  const participantGameIconUrl = activeGame
                                    ? resolveGameIconUrl({
                                        icons: gameIcons,
                                        gameId: activeGame.game_id,
                                        processName: activeGame.process_name,
                                        gameCatalog,
                                      })
                                    : null;
                                  const participantCardData = buildMemberCardData({
                                    userId: p.userId,
                                    displayName: p.displayName,
                                    profile:
                                      participantMember?.profile ??
                                      (isParticipantSelf ? profile : null),
                                    role:
                                      participantMember?.role ??
                                      (isParticipantSelf &&
                                      activeServer?.owner_id === user.id
                                        ? "owner"
                                        : null),
                                    status: realtimeStatus,
                                    activeGame,
                                    gameIconUrl: participantGameIconUrl,
                                  });

                                  return (
                                    <ContextMenu.Root key={p.userId}>
                                      <ContextMenu.Trigger asChild>
                                        <div
                                          draggable={canDrag}
                                          onDragStart={(e) => {
                                            if (!canDrag) return;
                                            e.dataTransfer.effectAllowed =
                                              "move";
                                            const dragPayload = {
                                              userId: p.userId,
                                              sourceChannelId: ch.id,
                                            };
                                            e.dataTransfer.setData(
                                              "text/plain",
                                              JSON.stringify(dragPayload),
                                            );
                                            setDraggingVoiceUser(dragPayload);
                                          }}
                                          onDragEnd={() => {
                                            setDraggingVoiceUser(null);
                                            setDragOverChannelId(null);
                                          }}
                                          className={`flex items-center justify-between gap-2 px-2 py-1 rounded-lg transition-colors ${
                                            canDrag
                                              ? "cursor-grab active:cursor-grabbing hover:bg-[#16161C]"
                                              : "hover:bg-[#16161C]/60"
                                          }`}
                                          title={
                                            canDrag
                                              ? "Arraste para mover ou clique com o botão direito"
                                              : p.displayName
                                          }
                                        >
                                          <div className="flex items-center gap-2 min-w-0">
                                            <div
                                              className={`shrink-0 rounded-lg transition-all ${
                                                p.isStreaming || p.speaking
                                                  ? "animate-radar-pulse-crimson"
                                                  : ""
                                              }`}
                                            >
                                              <AvatarWithFrame
                                                avatarUrl={p.avatarUrl}
                                                initials={p.initials}
                                                frame={p.avatarFrame}
                                                accentColor={p.accentColor}
                                                sizePx={22}
                                              />
                                            </div>
                                            <span
                                              className={`text-[11px] truncate ${
                                                p.speaking
                                                  ? "text-emerald-300 font-medium"
                                                  : "text-[#D4D4D8]"
                                              }`}
                                            >
                                              {p.displayName}
                                            </span>
                                          </div>

                                          <div className="flex items-center gap-1 shrink-0">
                                            {p.muted && (
                                              <MicOff
                                                className="w-3 h-3 text-[#F87171]"
                                                strokeWidth={1.75}
                                              />
                                            )}
                                            {p.deafened && (
                                              <HeadphoneOff
                                                className="w-3 h-3 text-[#F87171]"
                                                strokeWidth={1.75}
                                              />
                                            )}
                                            {p.isStreaming && (
                                              <span className="px-1 py-0.5 rounded bg-[#7F1D1D] border border-[#EF4444] font-mono text-[8px] leading-none text-[#FAFAFA]">
                                                AO VIVO
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      </ContextMenu.Trigger>

                                      <MemberContextMenuContent
                                        isSelf={isParticipantSelf}
                                        member={participantMember}
                                        userVolume={userVolumes[p.userId] ?? 100}
                                        onUserVolumeChange={(nextVol) =>
                                          setUserVolume(p.userId, nextVol)
                                        }
                                        activeServerId={activeServerId}
                                        isOwnerOrAdmin={isOwnerOrAdmin}
                                        memberVoiceChannelId={ch.id}
                                        voiceChannels={voiceChannels}
                                        onMoveToVoiceChannel={(vc) => {
                                          if (!activeServerId) return;
                                          if (isParticipantSelf) {
                                            void joinVoiceChannel({
                                              channelId: vc.id,
                                              channelName: vc.name,
                                            });
                                            setLeftDrawerOpen(false);
                                          } else {
                                            movePeerToRoom({
                                              serverId: activeServerId,
                                              sourceRoomId: ch.id,
                                              targetRoomId: vc.id,
                                              targetUserId: p.userId,
                                            });
                                          }
                                        }}
                                        onInspectProfile={() =>
                                          setInspectedVoiceCard({
                                            userId: p.userId,
                                            data: participantCardData,
                                          })
                                        }
                                        onRequestKick={(candidate) =>
                                          setKickVoiceCandidate(candidate)
                                        }
                                      />
                                    </ContextMenu.Root>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex-1 p-5 flex flex-col items-center justify-center text-center space-y-3">
                  <div className="w-10 h-10 rounded-2xl bg-[#16161C] hairline-box flex items-center justify-center">
                    <UserPlus
                      className="w-4 h-4 text-[#EF4444]"
                      strokeWidth={1.5}
                    />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-[#FAFAFA]">
                      Sem servidor ativo
                    </p>
                    <p className="text-[11px] text-[#71717A]">
                      Use um código de convite ou crie um novo Cafofo.
                    </p>
                  </div>
                </div>
              )}

              {/* Pod Inferior do Usuário com Seletor de Status (Online / Ausente / Não Perturbe / Invisível) */}
              <div className="p-3 bg-[#09090B] hairline-t flex items-center justify-between gap-2">
                <Popover.Root>
                  <Popover.Trigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-2.5 min-w-0 flex-1 min-h-[40px] p-1.5 rounded-xl hover:bg-[#16161C] transition-colors text-left"
                      title={`Status: ${selfStatusLabel} — clique para alterar`}
                    >
                      <div className="relative shrink-0">
                        <div
                          className="w-8 h-8 rounded-xl bg-[#16161C] hairline-box flex items-center justify-center text-xs font-semibold overflow-hidden"
                          style={{
                            borderColor: profile?.card_accent_color ?? undefined,
                          }}
                        >
                          {profile?.avatar_url ? (
                            <img
                              src={profile.avatar_url}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <span
                              style={{
                                color: profile?.card_accent_color ?? "#FAFAFA",
                              }}
                            >
                              {userInitials}
                            </span>
                          )}
                        </div>
                        <span
                          className={`w-2.5 h-2.5 rounded-full absolute -bottom-0.5 -right-0.5 border-2 border-[#09090B] ${selfStatusDotClass}`}
                        />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-[#FAFAFA] truncate">
                          {profile?.display_name ?? user.email}
                        </div>
                        <div className="font-mono text-[10px] text-[#71717A] truncate flex items-center gap-1">
                          {localPresenceStatus === "offline" && (
                            <EyeOff className="w-2.5 h-2.5 text-[#A1A1AA] shrink-0" strokeWidth={1.75} />
                          )}
                          <span className="truncate">{selfStatusLabel}</span>
                        </div>
                      </div>
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content
                      side="top"
                      align="start"
                      sideOffset={8}
                      collisionPadding={16}
                      className="w-60 rounded-xl scoped-glass p-2 shadow-2xl z-[80] text-xs text-[#FAFAFA] space-y-1 animate-popover-in"
                    >
                      <div className="px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-[#A1A1AA]">
                        Visibilidade & Status
                      </div>
                      {(
                        [
                          {
                            id: "online" as const,
                            label: "Online",
                            desc: "Visível para todos os membros",
                            dotClass: "bg-emerald-400",
                          },
                          {
                            id: "idle" as const,
                            label: "Ausente",
                            desc: "Indica que você está afastado",
                            dotClass: "bg-amber-400",
                          },
                          {
                            id: "dnd" as const,
                            label: "Não Perturbe",
                            desc: "Sinaliza que você está ocupado",
                            dotClass: "bg-[#EF4444]",
                          },
                          {
                            id: "offline" as const,
                            label: "Invisível (Offline)",
                            desc: "Aparece offline, mas continua vendo todos",
                            dotClass: "bg-[#52525B]",
                          },
                        ] as const
                      ).map((opt) => {
                        const selected = localPresenceStatus === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => handleSelectPresenceStatus(opt.id)}
                            className={`w-full px-2.5 py-2 rounded-lg text-left flex items-start gap-2.5 transition-colors ${
                              selected
                                ? "bg-[#16161C] border border-[#B91C1C]/60"
                                : "hover:bg-[#16161C]/70"
                            }`}
                          >
                            <span
                              className={`w-2.5 h-2.5 rounded-full mt-1 shrink-0 ${opt.dotClass}`}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-[#FAFAFA] flex items-center justify-between gap-1">
                                <span>{opt.label}</span>
                                {selected && (
                                  <Check
                                    className="w-3.5 h-3.5 text-[#EF4444] shrink-0"
                                    strokeWidth={1.75}
                                  />
                                )}
                              </div>
                              <p className="text-[10px] text-[#71717A] leading-snug">
                                {opt.desc}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                      <div className="pt-1 mt-1 hairline-t">
                        <button
                          type="button"
                          onClick={() => setProfileOpen(true)}
                          className="w-full px-2.5 py-1.5 rounded-lg text-left text-[11px] text-[#A1A1AA] hover:text-[#FAFAFA] hover:bg-[#16161C] flex items-center gap-2 transition-colors"
                        >
                          <Settings className="w-3.5 h-3.5" strokeWidth={1.5} />
                          <span>Editar Perfil & Aparência</span>
                        </button>
                      </div>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => setProfileOpen(true)}
                    className="min-h-[40px] min-w-[40px] p-2 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center justify-center transition-colors"
                    title="Personalizar Perfil & Conta"
                    aria-label="Personalizar Perfil e Conta"
                  >
                    <Settings className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            </aside>
          </div>

          {/* Palco Central: Home (Amigos/DMs), Boas-Vindas ou Servidor (Chat + Membros) */}
          {viewMode === "home" ? (
            <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#16161C] relative">
              {!chatCollapsed &&
                (() => {
                  const activeDm = activeDmChannelId
                    ? (dmChannels.find((c) => c.id === activeDmChannelId) ?? null)
                    : null;
                  return activeDm ? (
                    <DirectChatPanel
                      dmChannel={activeDm}
                      onOpenLeftDrawer={() => setLeftDrawerOpen(true)}
                      onCollapseChat={() => setChatCollapsed(true)}
                    />
                  ) : (
                    <FriendsHubPanel
                      onOpenDmChannel={(dmId) => {
                        selectDmChannel(dmId);
                        setChatCollapsed(false);
                      }}
                      onOpenLeftDrawer={() => setLeftDrawerOpen(true)}
                    />
                  );
                })()}

              <VoiceControlsPanel
                chatCollapsed={chatCollapsed}
                onToggleChatCollapsed={() => setChatCollapsed((v) => !v)}
                totalUnreadCount={totalUnreadCount}
                onlineCount={onlineCount}
                onOpenLeftDrawer={() => setLeftDrawerOpen(true)}
              />
            </div>
          ) : servers.length === 0 ? (
            <main className="flex-1 flex flex-col min-w-0 bg-[#16161C]">
              {/* Topbar Mobile na tela de Boas-Vindas */}
              <header className="h-14 px-3 crimson-header-glow hairline-b flex items-center justify-between gap-2 shrink-0 md:hidden">
                <button
                  type="button"
                  onClick={() => setLeftDrawerOpen(true)}
                  className="min-h-[40px] min-w-[40px] rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center justify-center"
                  aria-label="Abrir perfil e ações"
                >
                  <PanelLeft className="w-4 h-4" strokeWidth={1.5} />
                </button>
                <span className="text-xs font-semibold tracking-tight text-[#FAFAFA]">
                  Cafofo
                </span>
                <button
                  type="button"
                  onClick={() => setProfileOpen(true)}
                  className="min-h-[40px] min-w-[40px] rounded-lg bg-[#101014] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center justify-center"
                  aria-label="Editar perfil"
                >
                  <Settings className="w-4 h-4" strokeWidth={1.5} />
                </button>
              </header>

              <div className="flex-1 flex items-center justify-center p-4 sm:p-8 overflow-y-auto">
                {serversLoading ? (
                  <div className="flex flex-col items-center gap-3 text-xs font-mono text-[#A1A1AA]">
                    <div className="w-10 h-10 rounded-xl bg-[#B91C1C] flex items-center justify-center shadow-crimson-glow animate-pulse">
                      <AudioWaveform className="w-5 h-5 text-white" strokeWidth={1.75} />
                    </div>
                    <span>SINCRONIZANDO SEUS CAFOFOS...</span>
                  </div>
                ) : (
                  <div className="max-w-xl w-full rounded-2xl bg-[#101014] hairline-box crimson-header-glow p-6 sm:p-8 shadow-2xl space-y-6">
                    <div className="space-y-2 text-center">
                      <div className="w-12 h-12 rounded-2xl bg-[#16161C] border border-[#B91C1C]/60 shadow-crimson-glow flex items-center justify-center mx-auto">
                        <AudioWaveform
                          className="w-6 h-6 text-[#EF4444]"
                          strokeWidth={1.75}
                        />
                      </div>
                      <h2 className="text-lg sm:text-xl font-semibold tracking-tight text-[#FAFAFA]">
                        Bem-vindo ao Cafofo, {profile?.display_name ?? "explorador"}
                      </h2>
                      <p className="text-xs text-[#A1A1AA] leading-relaxed max-w-md mx-auto">
                        Você ainda não entrou em nenhum servidor. Use um código de convite enviado pelo seu grupo ou crie um novo Cafofo para começar.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setSocialError(null);
                          setJoinInviteOpen(true);
                        }}
                        className="min-h-[64px] p-4 rounded-xl bg-[#B91C1C] hover:bg-[#991B1B] shadow-crimson-glow text-left flex items-center gap-3 transition-colors"
                      >
                        <div className="w-10 h-10 rounded-xl bg-black/25 flex items-center justify-center shrink-0">
                          <KeyRound className="w-5 h-5 text-white" strokeWidth={1.75} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-white">
                            Entrar com Código de Convite
                          </div>
                          <div className="text-[11px] text-white/80">
                            Entre direto no servidor do amigo
                          </div>
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setSocialError(null);
                          setCreateServerOpen(true);
                        }}
                        className="min-h-[64px] p-4 rounded-xl bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-left flex items-center gap-3 transition-colors"
                      >
                        <div className="w-10 h-10 rounded-xl bg-[#101014] hairline-box flex items-center justify-center shrink-0">
                          <Plus className="w-5 h-5 text-[#EF4444]" strokeWidth={1.75} />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-[#FAFAFA]">
                            Criar Novo Cafofo
                          </div>
                          <div className="text-[11px] text-[#A1A1AA]">
                            Inicie seu próprio QG do zero
                          </div>
                        </div>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <VoiceControlsPanel />
            </main>
          ) : (
            <>
              {/* Coluna 3: Palco Central (Chat Recolhível + Palco de Voz/Streams Expansível) */}
              <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#16161C] relative">
                {!chatCollapsed && (
                  <ChatPanel
                    channel={activeChannel}
                    activeServerName={activeServer?.name ?? null}
                    onlineCount={onlineCount}
                    canModerateMessages={isOwnerOrAdmin}
                    onOpenLeftDrawer={() => setLeftDrawerOpen(true)}
                    onOpenRightDrawer={() => setRightDrawerOpen(true)}
                    onCollapseChat={() => setChatCollapsed(true)}
                  />
                )}

                <VoiceControlsPanel
                  chatCollapsed={chatCollapsed}
                  onToggleChatCollapsed={() => setChatCollapsed((v) => !v)}
                  totalUnreadCount={totalUnreadCount}
                  onlineCount={onlineCount}
                  onOpenLeftDrawer={() => setLeftDrawerOpen(true)}
                  onOpenRightDrawer={() => setRightDrawerOpen(true)}
                />
              </div>

              {/* Coluna 4 / Gaveta Direita Mobile: Membros & Presença de Jogos (#101014) */}
              <MembersPresencePanel
                isOpen={rightDrawerOpen}
                onClose={() => setRightDrawerOpen(false)}
              />
            </>
          )}
        </div>

        {/* Engine Global de Áudio Sincronizado do Bot de Música */}
        <MusicAudioEngine />

        {/* Overlay Global de Chamada 1:1 Recebida / Chamando */}
        <IncomingCallOverlay
          onAcceptedDm={(dmId) => {
            setViewMode("home");
            selectDmChannel(dmId);
            setChatCollapsed(false);
          }}
        />

        {/* Popup Flutuante de Notificação de Nova Mensagem / DM / Pedido de Amizade */}
        {chatToast && (
          <div className="fixed top-4 right-4 z-[68] max-w-[330px] w-[calc(100vw-32px)] animate-cyber-slide pointer-events-auto">
            <div className="scoped-glass rounded-2xl p-3 border border-[#B91C1C]/50 shadow-[0_12px_36px_rgba(0,0,0,0.65)] flex items-start gap-2.5">
              <button
                type="button"
                onClick={() => {
                  if (chatToast.kind === "dm" && chatToast.dmChannelId) {
                    setViewMode("home");
                    selectDmChannel(chatToast.dmChannelId);
                  } else if (chatToast.kind === "friend_request") {
                    setViewMode("home");
                    selectDmChannel(null);
                  } else if (chatToast.channelId) {
                    setViewMode("server");
                    selectChannel(chatToast.channelId);
                  }
                  setChatCollapsed(false);
                  setChatToast(null);
                }}
                className="flex items-start gap-2.5 min-w-0 flex-1 text-left group cursor-pointer"
              >
                <div
                  className="w-9 h-9 rounded-xl bg-[#16161C] border border-white/15 flex items-center justify-center text-[11px] font-bold overflow-hidden shrink-0"
                  style={{ color: chatToast.authorAccentColor }}
                >
                  {chatToast.authorAvatarUrl ? (
                    <img
                      src={chatToast.authorAvatarUrl}
                      alt={chatToast.authorName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    chatToast.authorName.slice(0, 2).toUpperCase()
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-semibold text-[#FAFAFA] group-hover:text-[#EF4444] transition-colors truncate">
                      {chatToast.authorName}
                    </span>
                    <span className="px-1.5 py-0.5 rounded bg-[#7F1D1D]/55 border border-[#EF4444]/40 font-mono text-[9px] text-[#FAFAFA] flex items-center gap-1 shrink-0">
                      <MessageSquare className="w-2.5 h-2.5" strokeWidth={1.75} />
                      {chatToast.kind === "channel"
                        ? `#${chatToast.channelName}`
                        : chatToast.channelName}
                    </span>
                  </div>
                  <p className="text-xs text-[#D4D4D8] line-clamp-2 leading-snug break-words">
                    {chatToast.snippet}
                  </p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setChatToast(null)}
                className="p-1 rounded-lg hover:bg-white/[0.08] text-[#A1A1AA] hover:text-[#FAFAFA] shrink-0"
                aria-label="Fechar notificação"
              >
                <X className="w-3.5 h-3.5" strokeWidth={1.5} />
              </button>
            </div>
          </div>
        )}

        {/* Input oculto para upload de Ícone do Servidor (encaminha para o editor de recorte 1:1) */}
        <input
          ref={serverIconInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            const meta = pendingServerIconMetaRef.current;
            e.target.value = "";
            if (file && meta) {
              setServerIconCropTarget({
                serverId: meta.serverId,
                serverName: meta.serverName,
                file,
              });
            }
          }}
        />

        <ImageCropperModal
          file={serverIconCropTarget?.file ?? null}
          title={
            serverIconCropTarget
              ? `Ícone de ${serverIconCropTarget.serverName}`
              : "Ícone do Servidor"
          }
          subtitle="Enquadre a imagem 1:1 exibida na barra de servidores"
          shape="rounded"
          onCancel={() => setServerIconCropTarget(null)}
          onConfirm={async (croppedFile) => {
            if (!serverIconCropTarget) return;
            setSocialError(null);
            await updateServerIcon(serverIconCropTarget.serverId, croppedFile);
            setServerIconCropTarget(null);
          }}
        />

        {/* Modal de Personalização de Perfil 50/50 (+ Encerrar Sessão com Confirmação) */}
        {profileOpen && (
          <ProfileEditorModal
            onClose={() => setProfileOpen(false)}
            onSignOut={handleSignOut}
            updater={updater}
          />
        )}

        {/* Modal Centralizado: Criar Servidor */}
        <Modal
          open={createServerOpen}
          onOpenChange={setCreateServerOpen}
          contentClassName="w-[90vw] max-w-md rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl space-y-4"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]">
              Criar Novo Servidor
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="p-1 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
              >
                <X className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>
          <form onSubmit={handleCreateServer} className="space-y-3">
            <input
              type="text"
              required
              placeholder="Nome do servidor (ex: QG da Madrugada)"
              value={newServerName}
              onChange={(e) => setNewServerName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-[#09090B] hairline-box text-sm text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
            />
            {socialError && (
              <p className="text-xs text-[#F87171]">{socialError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="submit"
                className="px-4 py-2 rounded-xl btn-crimson-vivid text-xs font-medium text-[#FAFAFA]"
              >
                Criar Servidor
              </button>
            </div>
          </form>
        </Modal>

        {/* Modal Centralizado: Entrar por Convite */}
        <Modal
          open={joinInviteOpen}
          onOpenChange={setJoinInviteOpen}
          contentClassName="w-[90vw] max-w-md rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl space-y-4"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]">
              Entrar por Código de Convite
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="p-1 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
              >
                <X className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>
          <form onSubmit={handleJoinInvite} className="space-y-3">
            <input
              type="text"
              required
              placeholder="Código de convite..."
              value={inviteInput}
              onChange={(e) => setInviteInput(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-[#09090B] hairline-box font-mono text-sm text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
            />
            {socialError && (
              <p className="text-xs text-[#F87171]">{socialError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="submit"
                className="px-4 py-2 rounded-xl btn-crimson-vivid text-xs font-medium text-[#FAFAFA]"
              >
                Entrar no Servidor
              </button>
            </div>
          </form>
        </Modal>

        {/* Modal Centralizado: Criar Canal */}
        <Modal
          open={createChannelOpen}
          onOpenChange={setCreateChannelOpen}
          contentClassName="w-[90vw] max-w-md rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl space-y-4"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]">
              Novo Canal em {activeServer?.name}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="p-1 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
              >
                <X className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>
          <form onSubmit={handleCreateChannel} className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              {(
                [
                  ["text", "Canal de Texto", Hash],
                  ["voice", "Sala de Voz", Volume2],
                ] as const
              ).map(([typeVal, label, Icon]) => (
                <button
                  key={typeVal}
                  type="button"
                  onClick={() => setNewChannelType(typeVal)}
                  className={`p-2.5 rounded-xl flex items-center gap-2 transition-colors ${
                    newChannelType === typeVal
                      ? "bg-[#16161C] text-[#FAFAFA] border border-[#B91C1C]"
                      : "bg-[#09090B] text-[#A1A1AA] hairline-box"
                  }`}
                >
                  <Icon className="w-4 h-4 text-[#EF4444]" strokeWidth={1.5} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
            <input
              type="text"
              required
              placeholder="nome-do-canal"
              value={newChannelName}
              onChange={(e) => setNewChannelName(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-[#09090B] hairline-box text-sm text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
            />
            {socialError && (
              <p className="text-xs text-[#F87171]">{socialError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="submit"
                className="px-4 py-2 rounded-xl btn-crimson-vivid text-xs font-medium text-[#FAFAFA]"
              >
                Criar Canal
              </button>
            </div>
          </form>
        </Modal>

        {/* Modal Centralizado: Renomear Canal */}
        <Modal
          open={Boolean(renamingChannel)}
          onOpenChange={(open) => {
            if (!open) setRenamingChannel(null);
          }}
          contentClassName="w-[90vw] max-w-md rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl space-y-4"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]">
              Renomear Canal
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="p-1 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
              >
                <X className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>
          <form onSubmit={handleRenameChannel} className="space-y-3">
            <input
              type="text"
              required
              value={renameChannelInput}
              onChange={(e) => setRenameChannelInput(e.target.value)}
              className="w-full px-3 py-2.5 rounded-xl bg-[#09090B] hairline-box text-sm text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
            />
            {socialError && (
              <p className="text-xs text-[#F87171]">{socialError}</p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenamingChannel(null)}
                className="px-4 py-2 rounded-xl bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA]"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl btn-crimson-vivid text-xs font-medium text-[#FAFAFA]"
              >
                Salvar Nome
              </button>
            </div>
          </form>
        </Modal>

        {/* Modal Centralizado: Confirmar Exclusão de Canal */}
        <Modal
          open={Boolean(deletingChannel)}
          onOpenChange={(open) => {
            if (!open) setDeletingChannel(null);
          }}
          contentClassName="w-[90vw] max-w-md rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl space-y-4"
        >
          <div className="space-y-1.5">
            <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]">
              Excluir canal #{deletingChannel?.name}?
            </Dialog.Title>
            <p className="text-xs text-[#A1A1AA] leading-relaxed">
              Todas as mensagens e o histórico desse canal serão removidos permanentemente.
            </p>
          </div>
          {socialError && (
            <p className="text-xs text-[#F87171]">{socialError}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeletingChannel(null)}
              className="px-4 py-2 rounded-xl bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA]"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmDeleteChannel()}
              className="px-4 py-2 rounded-xl btn-crimson-vivid text-xs font-medium text-[#FAFAFA]"
            >
              Excluir Canal
            </button>
          </div>
        </Modal>

        {/* Modal Centralizado: Confirmar Saída / Exclusão de Servidor */}
        <Modal
          open={Boolean(serverConfirmAction)}
          onOpenChange={(open) => {
            if (!open) setServerConfirmAction(null);
          }}
          contentClassName="w-[90vw] max-w-md rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl space-y-4"
        >
          <div className="space-y-1.5">
            <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]">
              {serverConfirmAction?.type === "delete"
                ? `Excluir "${serverConfirmAction.server.name}"?`
                : `Sair de "${serverConfirmAction?.server.name}"?`}
            </Dialog.Title>
            <p className="text-xs text-[#A1A1AA] leading-relaxed">
              {serverConfirmAction?.type === "delete"
                ? "Esta ação remove o servidor, todos os canais e todo o histórico de mensagens para todos os membros."
                : "Você precisará de um novo código de convite para entrar neste servidor novamente."}
            </p>
          </div>
          {socialError && (
            <p className="text-xs text-[#F87171]">{socialError}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setServerConfirmAction(null)}
              className="px-4 py-2 rounded-xl bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA]"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmServerAction()}
              className="px-4 py-2 rounded-xl btn-crimson-vivid text-xs font-medium text-[#FAFAFA]"
            >
              {serverConfirmAction?.type === "delete"
                ? "Excluir Servidor"
                : "Sair do Servidor"}
            </button>
          </div>
        </Modal>

        <ServerRolesManagerDialog
          open={Boolean(rolesManagerServerId)}
          onOpenChange={(open) => {
            if (!open) setRolesManagerServerId(null);
          }}
          serverId={rolesManagerServerId}
          serverName={
            servers.find((s) => s.id === rolesManagerServerId)?.name ??
            activeServer?.name
          }
        />

        <MemberInspectAndKickDialogs
          activeServerId={activeServerId}
          selfUserId={user.id}
          userVolumes={userVolumes}
          setUserVolume={setUserVolume}
          inspectedCard={inspectedVoiceCard}
          onCloseInspect={() => setInspectedVoiceCard(null)}
          kickCandidate={kickVoiceCandidate}
          onCloseKick={() => setKickVoiceCandidate(null)}
        />

        <UpdateBanner updater={updater} />
      </div>
    </Tooltip.Provider>
  );
}
