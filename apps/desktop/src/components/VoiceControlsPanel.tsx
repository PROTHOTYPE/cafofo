import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as Slider from "@radix-ui/react-slider";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  useAuthStore,
  useFriendsStore,
  useMusicStore,
  usePresenceStore,
  useServerStore,
  useVoiceStore,
  type PeerState,
  type ServerMemberWithProfile,
  type ServerRoleRow,
} from "@cafofo/core-logic";
import {
  AudioLines,
  Check,
  Cpu,
  Disc3,
  HeadphoneOff,
  Headphones,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  MonitorOff,
  MonitorUp,
  PanelLeft,
  PanelTopClose,
  PanelTopOpen,
  PhoneOff,
  Radio,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import {
  canBrowserScreenShare,
  listBrowserAudioInputs,
  retryBrowserMicPublish,
  unlockBrowserAudioPlayback,
  useBrowserRemoteMedia,
} from "../lib/livekitBrowser";
import {
  playVoiceJoinSound,
  useSystemSoundVolume,
} from "../lib/soundEffects";
import {
  getAudioStatus,
  isTauriRuntime,
  listAudioInputDevices,
  listCaptureWindows,
  type AudioDeviceInfo,
  type AudioStatus,
  type WindowInfo,
} from "../lib/tauri";
import { useTextScramble } from "../lib/useTextScramble";
import { Modal } from "./Modal";
import { MusicBotPanel } from "./MusicBotPanel";
import { StreamStageCard } from "./StreamStageCard";

const PTT_PRESETS: Array<{
  label: string;
  shortLabel: string;
  vk: number | null;
}> = [
  { label: "Detecção de Voz (Sem PTT)", shortLabel: "VAD AUTO", vk: null },
  { label: "Mouse Lateral 4 (XBUTTON1)", shortLabel: "MOUSE 4", vk: 0x05 },
  { label: "Mouse Lateral 5 (XBUTTON2)", shortLabel: "MOUSE 5", vk: 0x06 },
  { label: "Tecla V", shortLabel: "KEY V", vk: 0x56 },
  { label: "Left Alt", shortLabel: "L-ALT", vk: 0xa4 },
  { label: "Left Ctrl", shortLabel: "L-CTRL", vk: 0xa2 },
];

const EQ_MULTIPLIERS = [0.45, 0.75, 1.0, 0.65, 0.9, 0.55, 0.95, 0.7, 0.5, 0.8];

const EMPTY_MEMBERS: ServerMemberWithProfile[] = [];
const EMPTY_ROLES: ServerRoleRow[] = [];

export interface VoiceControlsPanelProps {
  chatCollapsed?: boolean;
  onToggleChatCollapsed?: () => void;
  totalUnreadCount?: number;
  onlineCount?: number;
  onOpenLeftDrawer?: () => void;
  onOpenRightDrawer?: () => void;
}

export function VoiceControlsPanel({
  chatCollapsed = false,
  onToggleChatCollapsed,
  totalUnreadCount = 0,
  onlineCount = 0,
  onOpenLeftDrawer,
  onOpenRightDrawer,
}: VoiceControlsPanelProps = {}) {
  const selfUserId = useAuthStore((s) => s.user?.id);
  const selfProfile = useAuthStore((s) => s.profile);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const servers = useServerStore((s) => s.servers);
  const serverMembers = useServerStore((s) =>
    activeServerId
      ? (s.membersByServer[activeServerId] ?? EMPTY_MEMBERS)
      : EMPTY_MEMBERS,
  );
  const serverRoles = useServerStore((s) =>
    activeServerId
      ? (s.rolesByServer[activeServerId] ?? EMPTY_ROLES)
      : EMPTY_ROLES,
  );
  const activeServer = useMemo(
    () => servers.find((s) => s.id === activeServerId) ?? null,
    [servers, activeServerId],
  );
  const memberByUserId = useMemo(
    () => new Map(serverMembers.map((m) => [m.user_id, m])),
    [serverMembers],
  );
  const rolesById = useMemo(
    () => new Map(serverRoles.map((r) => [r.id, r])),
    [serverRoles],
  );

  const connectionStatus = useVoiceStore((s) => s.connectionStatus);
  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId);
  const activeVoiceChannelName = useVoiceStore((s) => s.activeVoiceChannelName);
  const peers = useVoiceStore((s) => s.peers);
  const muted = useVoiceStore((s) => s.muted);
  const deafened = useVoiceStore((s) => s.deafened);
  const speaking = useVoiceStore((s) => s.speaking);
  const rnnoiseEnabled = useVoiceStore((s) => s.rnnoiseEnabled);
  const onlineByServer = usePresenceStore((s) => s.onlineByServer);
  const friendsProfileCache = useFriendsStore((s) => s.profileCache);
  const musicCurrent = useMusicStore((s) => s.current);
  const musicIsPlaying = useMusicStore((s) => s.isPlaying);
  const pttKey = useVoiceStore((s) => s.pttKey);
  const selectedMicDeviceId = useVoiceStore((s) => s.selectedMicDeviceId);
  const sharingWindow = useVoiceStore((s) => s.sharingWindow);
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const screenVolumes = useVoiceStore((s) => s.screenVolumes);
  const error = useVoiceStore((s) => s.error);

  const leaveVoiceChannel = useVoiceStore((s) => s.leaveVoiceChannel);
  const toggleMute = useVoiceStore((s) => s.toggleMute);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const toggleRnnoise = useVoiceStore((s) => s.toggleRnnoise);
  const setSelectedMicDeviceId = useVoiceStore((s) => s.setSelectedMicDeviceId);
  const setPushToTalkKey = useVoiceStore((s) => s.setPushToTalkKey);
  const startWindowShare = useVoiceStore((s) => s.startWindowShare);
  const stopWindowShare = useVoiceStore((s) => s.stopWindowShare);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);
  const setScreenVolume = useVoiceStore((s) => s.setScreenVolume);

  const browserMedia = useBrowserRemoteMedia();
  const isTauri = isTauriRuntime();
  const browserScreenShareSupported = canBrowserScreenShare();
  const [systemSoundVolume, setSystemSoundVolume] = useSystemSoundVolume();

  const [devices, setDevices] = useState<AudioDeviceInfo[]>([]);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsPopoverOpen, setSettingsPopoverOpen] = useState(false);
  const [shareAudio, setShareAudio] = useState(true);
  const [targetFps, setTargetFps] = useState<30 | 60>(60);
  const [audioStatus, setAudioStatus] = useState<AudioStatus | null>(null);
  const [pinnedUserId, setPinnedUserId] = useState<string | null>(null);
  const [stageExpanded, setStageExpanded] = useState(true);
  const [layoutResetNotice, setLayoutResetNotice] = useState(false);

  const handleResetLayout = () => {
    if (typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    setPinnedUserId(null);
    setStageExpanded(true);
    setPickerOpen(false);
    setSettingsPopoverOpen(false);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("cafofo:reset-layout"));
    }
    setLayoutResetNotice(true);
    setTimeout(() => setLayoutResetNotice(false), 2400);
  };

  useEffect(() => {
    const refreshDevices = () => {
      if (isTauri) {
        void listAudioInputDevices().then(setDevices).catch(() => {});
        return;
      }
      void listBrowserAudioInputs()
        .then((list) =>
          setDevices(
            list.map((d, idx) => ({
              id: d.id,
              name: d.name,
              direction: "Input",
              is_default: idx === 0,
              sample_rate: 48000,
              channels: 1,
            })),
          ),
        )
        .catch(() => {});
    };

    refreshDevices();
    if (!isTauri && typeof navigator !== "undefined" && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener?.("devicechange", refreshDevices);
      return () => {
        navigator.mediaDevices.removeEventListener?.(
          "devicechange",
          refreshDevices,
        );
      };
    }
  }, [isTauri, browserMedia.connected, settingsPopoverOpen]);

  useEffect(() => {
    if (!isTauri || !activeVoiceChannelName) {
      setAudioStatus(null);
      return;
    }
    const timer = setInterval(() => {
      void getAudioStatus()
        .then((status) => {
          setAudioStatus(status);
          const isTalking =
            !status.muted &&
            !status.deafened &&
            (status.vad_probability > 0.45 || status.rms_level > 0.025);
          useVoiceStore.getState().setLocalSpeaking(isTalking);
        })
        .catch(() => {});
    }, 180);
    return () => {
      clearInterval(timer);
      useVoiceStore.getState().setLocalSpeaking(false);
    };
  }, [isTauri, activeVoiceChannelName]);

  const openWindowPicker = async () => {
    if (isTauri) {
      const list = await listCaptureWindows();
      setWindows(list);
      setPickerOpen(true);
      return;
    }
    if (browserScreenShareSupported) {
      try {
        await startWindowShare({
          hwnd: Date.now(),
          pid: 0,
          title: "Transmissão Web",
          targetFps: 60,
          shareAudio: true,
        });
      } catch {
        // Usuário cancelou ou bloqueou a seleção de tela no navegador
      }
    }
  };

  const peerList = useMemo(() => {
    const byId = new Map<string, PeerState>();
    for (const p of Object.values(peers)) {
      byId.set(p.user_id, p);
    }

    // Always guarantee local user is present while connected to a voice channel
    if (activeVoiceChannelId && selfUserId && !byId.has(selfUserId)) {
      byId.set(selfUserId, {
        user_id: selfUserId,
        display_name:
          selfProfile?.display_name || selfProfile?.username || "Você",
        muted,
        deafened,
        speaking,
        noise_suppression: rnnoiseEnabled,
        reconnecting: false,
        game_presence: null,
        screen_sharing: sharingWindow
          ? {
              room_id: activeVoiceChannelId,
              user_id: selfUserId,
              stream_id: `win-${sharingWindow.hwnd}`,
              source_title: sharingWindow.title,
              width: 1920,
              height: 1080,
              fps: 60,
              has_audio: true,
            }
          : null,
      });
    }

    // Ground truth from LiveKit: NEVER drop a remote peer whose voice or video is actively connected
    if (activeVoiceChannelId) {
      const serverOnline = activeServerId
        ? (onlineByServer[activeServerId] ?? {})
        : {};
      const liveKitIds = new Set<string>([
        ...browserMedia.remoteParticipantIds,
        ...Object.keys(browserMedia.remoteVideoByUser),
      ]);
      for (const uid of liveKitIds) {
        if (!uid || uid === selfUserId || byId.has(uid)) continue;
        const member = memberByUserId.get(uid);
        const cachedProf = friendsProfileCache[uid];
        const presVoice = serverOnline[uid]?.voice_state;
        const displayName =
          member?.nickname ||
          member?.profile?.display_name ||
          member?.profile?.username ||
          cachedProf?.display_name ||
          cachedProf?.username ||
          presVoice?.display_name ||
          uid.slice(0, 8);
        const hasVideo = Boolean(browserMedia.remoteVideoByUser[uid]);
        byId.set(uid, {
          user_id: uid,
          display_name: displayName,
          muted: Boolean(presVoice?.muted),
          deafened: Boolean(presVoice?.deafened),
          speaking: Boolean(presVoice?.speaking),
          noise_suppression: true,
          reconnecting: false,
          game_presence: serverOnline[uid]?.game_presence ?? null,
          screen_sharing:
            hasVideo || presVoice?.is_streaming
              ? {
                  room_id: activeVoiceChannelId,
                  user_id: uid,
                  stream_id: `livekit-${uid}`,
                  source_title: "Transmissão ao vivo",
                  width: 1920,
                  height: 1080,
                  fps: 60,
                  has_audio: true,
                }
              : null,
        });
      }
    }

    const list = Array.from(byId.values());
    const isPeerStreaming = (uid: string, hasShare: boolean) =>
      Boolean(
        hasShare ||
          (uid === selfUserId
            ? browserMedia.localScreenVideoTrack
            : browserMedia.remoteVideoByUser[uid]),
      );
    return list.sort((a, b) => {
      if (a.user_id === pinnedUserId) return -1;
      if (b.user_id === pinnedUserId) return 1;
      const aStreaming = isPeerStreaming(a.user_id, Boolean(a.screen_sharing));
      const bStreaming = isPeerStreaming(b.user_id, Boolean(b.screen_sharing));
      if (aStreaming && !bStreaming) return -1;
      if (!aStreaming && bStreaming) return 1;
      return a.display_name.localeCompare(b.display_name);
    });
  }, [
    peers,
    activeVoiceChannelId,
    activeServerId,
    onlineByServer,
    friendsProfileCache,
    memberByUserId,
    selfUserId,
    selfProfile?.display_name,
    selfProfile?.username,
    muted,
    deafened,
    speaking,
    rnnoiseEnabled,
    sharingWindow,
    pinnedUserId,
    browserMedia.remoteParticipantIds,
    browserMedia.remoteVideoByUser,
    browserMedia.localScreenVideoTrack,
  ]);

  const activeStreamCount = useMemo(
    () =>
      peerList.filter((p) =>
        Boolean(
          p.screen_sharing ||
            (p.user_id === selfUserId
              ? browserMedia.localScreenVideoTrack
              : browserMedia.remoteVideoByUser[p.user_id]),
        ),
      ).length,
    [
      peerList,
      selfUserId,
      browserMedia.remoteVideoByUser,
      browserMedia.localScreenVideoTrack,
    ],
  );

  const scrambledChannelStatus = useTextScramble(
    activeVoiceChannelName
      ? activeStreamCount > 0
        ? `${activeVoiceChannelName} • ${activeStreamCount} STREAM`
        : activeVoiceChannelName
      : "STANDBY",
    Boolean(activeVoiceChannelName),
    480,
  );

  const rmsBase = muted
    ? 0.05
    : audioStatus
      ? Math.min(
          1,
          Math.max(
            0.08,
            audioStatus.rms_level * 3.2 + audioStatus.vad_probability * 0.35,
          ),
        )
      : !isTauri && activeVoiceChannelName
        ? Math.min(1, Math.max(0.1, browserMedia.rmsLevel * 3.2))
        : activeVoiceChannelName
          ? 0.22
          : 0.06;

  const activePttPreset =
    PTT_PRESETS.find((p) => p.vk === pttKey) ?? PTT_PRESETS[0];

  const showVoiceStage = Boolean(
    activeVoiceChannelName &&
      peerList.length > 0 &&
      (stageExpanded || chatCollapsed),
  );

  return (
    <Tooltip.Provider delayDuration={180}>
      <section
        className={`relative bg-[#101014] hairline-t select-none pb-[env(safe-area-inset-bottom)] flex flex-col ${
          chatCollapsed ? "flex-1 min-h-0" : "shrink-0"
        }`}
      >
        {/* Toast Flutuante de Confirmação de Reset de Layout */}
        {layoutResetNotice && (
          <div className="px-3 py-1.5 bg-[#09090B] hairline-b flex items-center justify-center gap-2 text-[11px] font-mono text-emerald-400 animate-cyber-slide shrink-0">
            <Check className="w-3.5 h-3.5 text-emerald-400" strokeWidth={1.75} />
            <span>Layout e janelas reencaixados no grid principal</span>
          </div>
        )}

        {/* Palco Expandido quando Chat está Recolhido e sem Call Ativa */}
        {chatCollapsed && !showVoiceStage && (
          <div className="flex-1 min-h-0 flex flex-col bg-[#16161C] hairline-b animate-cyber-slide">
            <header className="h-14 px-3 sm:px-5 crimson-header-glow crimson-header-animated-border hairline-b flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                {onOpenLeftDrawer && (
                  <button
                    type="button"
                    onClick={onOpenLeftDrawer}
                    className="md:hidden min-h-[38px] min-w-[38px] rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center justify-center shrink-0"
                    aria-label="Abrir servidores e canais"
                  >
                    <PanelLeft className="w-4 h-4" strokeWidth={1.5} />
                  </button>
                )}
                <Radio className="w-4 h-4 text-[#EF4444] shrink-0" strokeWidth={1.5} />
                <span className="text-sm font-semibold text-[#FAFAFA] truncate">
                  Palco de Voz & Transmissões
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {onToggleChatCollapsed && (
                  <button
                    type="button"
                    onClick={onToggleChatCollapsed}
                    className="relative min-h-[36px] px-3 py-1.5 rounded-lg btn-crimson-vivid text-xs font-medium text-[#FAFAFA] flex items-center gap-1.5"
                  >
                    <MessageSquare className="w-3.5 h-3.5" strokeWidth={1.5} />
                    <span>Abrir Chat</span>
                    {totalUnreadCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full bg-[#09090B]/85 border border-white/25 font-mono text-[10px] leading-none text-[#FAFAFA]">
                        {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
                      </span>
                    )}
                  </button>
                )}
                {onOpenRightDrawer && (
                  <button
                    type="button"
                    onClick={onOpenRightDrawer}
                    className="md:hidden min-h-[38px] px-2.5 rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center gap-1.5 font-mono text-[11px]"
                    aria-label="Abrir lista de membros"
                  >
                    <Users className="w-4 h-4 text-[#A1A1AA]" strokeWidth={1.5} />
                    <span>{onlineCount}</span>
                  </button>
                )}
              </div>
            </header>

            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-[#101014] hairline-box flex items-center justify-center">
                <Radio className="w-5 h-5 text-[#EF4444]" strokeWidth={1.5} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-[#FAFAFA]">
                  Chat recolhido — Palco pronto para foco total
                </p>
                <p className="text-xs text-[#71717A] max-w-sm">
                  Entre em uma sala de voz na barra lateral para ver transmissões em tela ampla ou reabra o chat quando quiser.
                </p>
              </div>
              {onToggleChatCollapsed && (
                <button
                  type="button"
                  onClick={onToggleChatCollapsed}
                  className="min-h-[38px] px-4 py-2 rounded-xl bg-[#101014] hover:bg-[#1E1E26] hairline-box text-xs text-[#FAFAFA] flex items-center gap-2 transition-colors"
                >
                  <PanelTopOpen className="w-3.5 h-3.5 text-[#EF4444]" strokeWidth={1.5} />
                  <span>Mostrar Chat de Texto</span>
                  {totalUnreadCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-[#B91C1C] font-mono text-[10px] leading-none text-[#FAFAFA]">
                      {totalUnreadCount}
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Palco de Voz & Grade de Transmissões Simultâneas (Embutido no Grid Principal) */}
        {showVoiceStage && (
          <div
            className={`relative w-full p-2.5 sm:p-3 bg-[#16161C] hairline-b flex flex-col gap-2.5 overflow-y-auto animate-cyber-slide ${
              chatCollapsed ? "flex-1 min-h-0" : "max-h-[42dvh]"
            }`}
          >
            <div className="flex items-center justify-between text-xs gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                {chatCollapsed && onOpenLeftDrawer && (
                  <button
                    type="button"
                    onClick={onOpenLeftDrawer}
                    className="md:hidden min-h-[36px] min-w-[36px] rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center justify-center shrink-0"
                    aria-label="Abrir servidores e canais"
                  >
                    <PanelLeft className="w-4 h-4" strokeWidth={1.5} />
                  </button>
                )}
                <Radio
                  className="w-3.5 h-3.5 text-[#EF4444] shrink-0 animate-pulse"
                  strokeWidth={1.5}
                />
                <span className="font-semibold tracking-tight text-[#FAFAFA] truncate">
                  Palco de Voz & Transmissões
                </span>
                <span className="font-mono text-[11px] text-[#A1A1AA] shrink-0">
                  ({peerList.length})
                </span>
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                {!isTauri && browserMedia.audioPlaybackBlocked && (
                  <button
                    type="button"
                    onClick={() => void unlockBrowserAudioPlayback()}
                    className="min-h-[36px] px-2.5 py-1 rounded-lg btn-crimson-vivid text-[11px] font-medium text-[#FAFAFA]"
                  >
                    Ativar Áudio
                  </button>
                )}
                {onToggleChatCollapsed && (
                  <button
                    type="button"
                    onClick={onToggleChatCollapsed}
                    className={`min-h-[36px] px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1.5 transition-colors ${
                      chatCollapsed
                        ? "btn-crimson-vivid font-medium text-[#FAFAFA]"
                        : "bg-[#101014] hover:bg-[#1E1E26] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
                    }`}
                    title={
                      chatCollapsed
                        ? "Mostrar chat de texto"
                        : "Recolher chat e expandir palco"
                    }
                  >
                    {chatCollapsed ? (
                      <>
                        <MessageSquare className="w-3.5 h-3.5" strokeWidth={1.5} />
                        <span>Abrir Chat</span>
                        {totalUnreadCount > 0 && (
                          <span className="px-1.5 py-0.5 rounded-full bg-[#09090B]/85 border border-white/25 font-mono text-[10px] leading-none text-[#FAFAFA]">
                            {totalUnreadCount > 99 ? "99+" : totalUnreadCount}
                          </span>
                        )}
                      </>
                    ) : (
                      <>
                        <PanelTopClose
                          className="w-3.5 h-3.5 text-[#EF4444]"
                          strokeWidth={1.5}
                        />
                        <span className="hidden lg:inline">Expandir Palco</span>
                      </>
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleResetLayout}
                  className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#101014] hover:bg-[#1E1E26] hairline-box text-[11px] text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1 transition-colors"
                  title="Resetar Layout / Encaixar Janelas"
                >
                  <RotateCcw className="w-3 h-3 text-[#EF4444]" strokeWidth={1.5} />
                  <span className="hidden xl:inline">Encaixar Janelas</span>
                </button>
                {!chatCollapsed && (
                  <button
                    type="button"
                    onClick={() => setStageExpanded(false)}
                    className="min-h-[36px] px-2.5 py-1 rounded-lg bg-[#101014] hover:bg-[#1E1E26] hairline-box text-[11px] text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1 transition-colors"
                  >
                    <Minimize2 className="w-3 h-3" strokeWidth={1.5} />
                    <span className="hidden sm:inline">Recolher</span>
                  </button>
                )}
                {chatCollapsed && onOpenRightDrawer && (
                  <button
                    type="button"
                    onClick={onOpenRightDrawer}
                    className="md:hidden min-h-[36px] px-2 rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center gap-1 font-mono text-[11px]"
                    aria-label="Abrir lista de membros"
                  >
                    <Users className="w-3.5 h-3.5 text-[#A1A1AA]" strokeWidth={1.5} />
                    <span>{onlineCount}</span>
                  </button>
                )}
              </div>
            </div>

            {(() => {
              const pinnedPeer = pinnedUserId
                ? (peerList.find((p) => p.user_id === pinnedUserId) ?? null)
                : null;
              const unpinnedPeers = pinnedPeer
                ? peerList.filter((p) => p.user_id !== pinnedPeer.user_id)
                : peerList;

              const renderPeerCard = (peer: PeerState, isPinned: boolean) => {
                const vol = userVolumes[peer.user_id] ?? 100;
                const streamVol = peer.screen_sharing
                  ? (screenVolumes[peer.screen_sharing.stream_id] ?? 100)
                  : 100;
                const isSelfPeer = peer.user_id === selfUserId;
                const remoteVideoTrack = isSelfPeer
                  ? browserMedia.localScreenVideoTrack
                  : (browserMedia.remoteVideoByUser[peer.user_id] ?? null);
                const member = memberByUserId.get(peer.user_id);
                const peerProfile =
                  member?.profile ??
                  friendsProfileCache[peer.user_id] ??
                  (isSelfPeer ? selfProfile : null);
                const assignedRole =
                  member?.custom_role ??
                  (member?.role_id
                    ? (rolesById.get(member.role_id) ?? null)
                    : null);
                const roleBadge = assignedRole
                  ? {
                      label: assignedRole.name,
                      color: assignedRole.color || "#B91C1C",
                    }
                  : activeServer?.owner_id === peer.user_id ||
                      member?.role === "owner"
                    ? { label: "DONO", color: "#EF4444" }
                    : member?.role === "admin"
                      ? { label: "ADMIN", color: "#EF4444" }
                      : null;

                return (
                  <StreamStageCard
                    key={peer.user_id}
                    peer={peer}
                    profile={peerProfile}
                    roleBadge={roleBadge}
                    isSelf={isSelfPeer}
                    isPinned={isPinned}
                    theaterMode={chatCollapsed}
                    userVolume={vol}
                    streamVolume={streamVol}
                    remoteVideoTrack={remoteVideoTrack}
                    onTogglePin={() =>
                      setPinnedUserId(isPinned ? null : peer.user_id)
                    }
                    onUserVolumeChange={(val) => setUserVolume(peer.user_id, val)}
                    onStreamVolumeChange={(val) => {
                      if (peer.screen_sharing) {
                        setScreenVolume(peer.screen_sharing.stream_id, val);
                      }
                    }}
                  />
                );
              };

              if (pinnedPeer) {
                return (
                  <div className="flex flex-col gap-3 w-full">
                    {/* Card Fixado em 16:9 dedicado — nunca sobreposto pelos demais */}
                    <div
                      className="w-full aspect-video mx-auto shrink-0"
                      style={{
                        maxWidth: chatCollapsed
                          ? "min(100%, calc(60dvh * 16 / 9))"
                          : "min(100%, calc(29dvh * 16 / 9))",
                      }}
                    >
                      {renderPeerCard(pinnedPeer, true)}
                    </div>

                    {/* Demais participantes abaixo em grade 16:9 limpa */}
                    {unpinnedPeers.length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5 w-full shrink-0 items-start">
                        {unpinnedPeers.map((peer) => renderPeerCard(peer, false))}
                      </div>
                    )}
                  </div>
                );
              }

              const unpinnedGridClass = chatCollapsed
                ? peerList.length === 1
                  ? "grid-cols-1 max-w-4xl mx-auto"
                  : peerList.length === 2
                    ? "grid-cols-1 md:grid-cols-2 max-w-6xl mx-auto"
                    : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"
                : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3";

              return (
                <div
                  className={`relative w-full grid gap-3 items-start content-start ${unpinnedGridClass}`}
                >
                  {peerList.map((peer) => renderPeerCard(peer, false))}
                </div>
              );
            })()}
          </div>
        )}

        {/* Barra Inferior Compacta de Controle de Voz & Equalizador Vertical */}
        <div className="px-2.5 sm:px-3.5 py-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 min-w-0">
          {/* Esquerda: Status + Equalizador em Barras Verticais + Telemetria Desktop */}
          <div className="flex items-center gap-2 xl:gap-3 min-w-[140px] flex-1 overflow-hidden">
            {/* Medidor de Áudio em Barras Verticais Animadas */}
            <div
              className="h-9 sm:h-8 px-1.5 sm:px-2.5 rounded-lg bg-[#09090B] hairline-box flex items-end gap-[2px] sm:gap-[3px] py-1.5 shrink-0"
              title="Medidor de voz em tempo real"
            >
              {EQ_MULTIPLIERS.map((mult, idx) => {
                const barHeight = Math.max(
                  16,
                  Math.min(100, Math.round(rmsBase * mult * 100)),
                );
                const isHot = !muted && barHeight > 45;
                return (
                  <span
                    key={idx}
                    className={`w-[2.5px] sm:w-[3px] rounded-full transition-all duration-150 ${
                      idx >= 6 ? "hidden sm:block" : ""
                    }`}
                    style={{
                      height: `${barHeight}%`,
                      backgroundColor: muted
                        ? "#52525B"
                        : isHot
                          ? "#B91C1C"
                          : "rgba(255, 255, 255, 0.28)",
                    }}
                  />
                );
              })}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    connectionStatus === "connected"
                      ? "bg-emerald-400 animate-radar-pulse"
                      : connectionStatus === "connecting" ||
                          connectionStatus === "reconnecting"
                        ? "bg-amber-400 animate-pulse"
                        : "bg-[#71717A]"
                  }`}
                />
                <span className="text-xs font-semibold text-[#FAFAFA] truncate">
                  {scrambledChannelStatus}
                </span>
                {activeVoiceChannelName &&
                  !stageExpanded &&
                  peerList.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setStageExpanded(true)}
                      className="min-h-[32px] px-2 py-0.5 rounded bg-[#16161C] hairline-box text-[10px] text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1 shrink-0"
                    >
                      <Maximize2 className="w-2.5 h-2.5" strokeWidth={1.5} />
                      <span className="hidden sm:inline">
                        Palco ({peerList.length})
                      </span>
                    </button>
                  )}
              </div>

              {/* Telemetria em JetBrains Mono */}
              <div className="hidden xl:flex items-center gap-1.5 font-mono text-[10px] text-[#71717A] mt-0.5 whitespace-nowrap overflow-hidden">
                <span className="truncate">
                  {isTauri
                    ? "48kHz OPUS"
                    : browserMedia.webRnnoiseActive
                      ? "RNNOISE WASM"
                      : rnnoiseEnabled
                        ? "WEBRTC NS"
                        : "48kHz RAW"}
                </span>
                <span className="shrink-0">•</span>
                <span className="shrink-0">64kbps</span>
                {audioStatus && (
                  <>
                    <span className="shrink-0">•</span>
                    <span className="text-[#A1A1AA] shrink-0">
                      VAD {(audioStatus.vad_probability * 100).toFixed(0)}%
                    </span>
                    {audioStatus.loopback_mode && (
                      <>
                        <span className="hidden 2xl:inline shrink-0">•</span>
                        <span className="hidden 2xl:inline text-[#EF4444] truncate">
                          {audioStatus.loopback_mode === "ProcessTreeIsolated"
                            ? "WASAPI ISOLADO"
                            : "LOOPBACK SISTEMA"}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Direita: Controles Adaptativos (ícones em telas 13"-16", labels completos em 24"+) */}
          <div className="flex flex-wrap items-center justify-end gap-1 xl:gap-1.5 shrink-0 max-w-full">
            {!isTauri && browserMedia.audioPlaybackBlocked && (
              <button
                type="button"
                onClick={() => void unlockBrowserAudioPlayback()}
                className="min-h-[38px] px-2.5 rounded-lg btn-crimson-vivid text-[#FAFAFA] text-[11px] font-medium shrink-0"
              >
                Ouvir
              </button>
            )}

            {/* Popover Rápido do Bot de Música (acessível também em Calls 1:1 e Mobile) */}
            {activeVoiceChannelName && (
              <Popover.Root>
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className={`min-h-[38px] min-w-[38px] px-2 xl:px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
                      musicCurrent
                        ? "bg-[#16161C] text-[#FAFAFA] border border-[#B91C1C]/60"
                        : "bg-[#09090B] hover:bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
                    }`}
                    title={
                      musicCurrent
                        ? `Tocando: ${musicCurrent.title}`
                        : "Abrir Bot de Música da Call"
                    }
                    aria-label="Bot de Música"
                  >
                    <Disc3
                      className={`w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0 ${
                        musicCurrent ? "text-[#EF4444]" : ""
                      } ${musicCurrent && musicIsPlaying ? "animate-spin" : ""}`}
                      style={{ animationDuration: "3.5s" }}
                      strokeWidth={1.6}
                    />
                    <span className="hidden 2xl:inline font-mono text-[11px] max-w-[88px] truncate">
                      {musicCurrent ? musicCurrent.title : "Música"}
                    </span>
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    side="top"
                    align="end"
                    sideOffset={8}
                    collisionPadding={16}
                    avoidCollisions
                    className="w-[min(21rem,calc(100vw-24px))] max-h-[75dvh] overflow-y-auto rounded-2xl scoped-glass shadow-2xl z-[80] animate-popover-in overflow-hidden"
                  >
                    <MusicBotPanel />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            )}

            {/* Toggle Supressor de Ruídos (RNNoise nativo no Tauri / RNNoise WASM no Navegador) */}
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <button
                  type="button"
                  onClick={() => void toggleRnnoise()}
                  className={`min-h-[38px] min-w-[38px] px-2 xl:px-2.5 py-1.5 rounded-lg text-xs font-medium hidden sm:flex items-center justify-center gap-1.5 transition-colors ${
                    rnnoiseEnabled
                      ? "bg-[#16161C] text-[#FAFAFA] border border-[#B91C1C]/60"
                      : "bg-[#09090B] text-[#71717A] hairline-box hover:text-[#A1A1AA]"
                  }`}
                >
                  <AudioLines
                    className={`w-3.5 h-3.5 shrink-0 ${
                      rnnoiseEnabled ? "text-[#EF4444]" : "text-[#71717A]"
                    }`}
                    strokeWidth={1.5}
                  />
                  <span className="hidden 2xl:inline font-mono text-[11px]">
                    Supressor {rnnoiseEnabled ? "ON" : "OFF"}
                  </span>
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  sideOffset={6}
                  className="px-2.5 py-1.5 rounded-lg bg-[#09090B] hairline-box text-[11px] text-[#FAFAFA] shadow-xl z-50 animate-popover-in"
                >
                  {isTauri
                    ? "Supressão neural de ruído em Rust (nnnoiseless)"
                    : "Supressão neural de ruído no navegador (RNNoise WASM + WebRTC)"}
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>

            {/* Popover de Dispositivo de Microfone, PTT & Reset de Layout */}
            <Popover.Root
              open={settingsPopoverOpen}
              onOpenChange={setSettingsPopoverOpen}
            >
              <Popover.Trigger asChild>
                <button
                  type="button"
                  className="min-h-[38px] min-w-[38px] px-2 xl:px-2.5 py-1.5 rounded-lg bg-[#09090B] hover:bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center justify-center gap-1.5 transition-colors"
                  title={`Configurações de áudio (${activePttPreset.shortLabel})`}
                  aria-label="Configurações de áudio e vídeo"
                >
                  <Settings2
                    className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0"
                    strokeWidth={1.5}
                  />
                  <span className="hidden 2xl:inline font-mono text-[11px]">
                    {activePttPreset.shortLabel}
                  </span>
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="top"
                  align="end"
                  sideOffset={8}
                  collisionPadding={16}
                  avoidCollisions
                  className="w-[min(19rem,calc(100vw-24px))] max-h-[calc(100dvh-28px)] overflow-y-auto rounded-xl scoped-glass p-3.5 shadow-2xl space-y-3 z-[80] text-xs text-[#FAFAFA] animate-popover-in"
                >
                  <div className="space-y-1.5">
                    <label className="block text-[11px] font-mono uppercase tracking-wider text-[#A1A1AA]">
                      Dispositivo de Entrada
                    </label>
                    <select
                      value={selectedMicDeviceId ?? ""}
                      onChange={(e) => {
                        const nextId = e.target.value || null;
                        const matched = nextId
                          ? devices.find((d) => d.id === nextId)
                          : undefined;
                        void setSelectedMicDeviceId(
                          nextId,
                          matched?.name ?? null,
                        );
                      }}
                      className="w-full min-h-[40px] px-2.5 py-2 rounded-lg bg-[#09090B] hairline-box text-xs text-[#FAFAFA] focus:outline-none focus:border-[#B91C1C]"
                    >
                      <option value="">Microfone Padrão do Sistema</option>
                      {devices.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({d.sample_rate}Hz)
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Supressor de Ruídos (Acessível também no Mobile) */}
                  <div className="pt-2 hairline-t">
                    <button
                      type="button"
                      onClick={() => void toggleRnnoise()}
                      className={`w-full min-h-[38px] px-3 py-2 rounded-xl flex items-center justify-between gap-2 text-xs transition-colors ${
                        rnnoiseEnabled
                          ? "bg-[#16161C] border border-[#B91C1C]/60 text-[#FAFAFA]"
                          : "bg-[#09090B] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <AudioLines
                          className={`w-3.5 h-3.5 ${
                            rnnoiseEnabled ? "text-[#EF4444]" : "text-[#71717A]"
                          }`}
                          strokeWidth={1.5}
                        />
                        <span>Supressor de Ruídos (RNNoise)</span>
                      </span>
                      <span
                        className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                          rnnoiseEnabled
                            ? "bg-[#7F1D1D]/60 text-[#FAFAFA]"
                            : "bg-[#16161C] text-[#71717A]"
                        }`}
                      >
                        {rnnoiseEnabled ? "ATIVO" : "OFF"}
                      </span>
                    </button>
                  </div>

                  {/* Controle de Volume de Áudio de Sistema (Join / Leave / Mute) */}
                  <div className="space-y-1.5 pt-2 hairline-t">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-mono uppercase tracking-wider text-[#A1A1AA]">
                        Efeitos de Sistema
                      </span>
                      <button
                        type="button"
                        onClick={() => playVoiceJoinSound()}
                        className="font-mono text-[#EF4444] hover:underline"
                        title="Testar bipe de radar"
                      >
                        {systemSoundVolume}% • TESTAR
                      </button>
                    </div>
                    <Slider.Root
                      className="relative flex items-center select-none touch-none w-full h-4"
                      value={[systemSoundVolume]}
                      min={0}
                      max={100}
                      step={5}
                      onValueChange={(vals) =>
                        setSystemSoundVolume(vals[0] ?? 75)
                      }
                    >
                      <Slider.Track className="bg-[#09090B] relative grow rounded-full h-1.5 hairline-box">
                        <Slider.Range className="absolute bg-[#B91C1C] rounded-full h-full" />
                      </Slider.Track>
                      <Slider.Thumb
                        className="block w-3.5 h-3.5 bg-[#FAFAFA] border border-[#B91C1C] rounded-full focus:outline-none"
                        aria-label="Volume de efeitos do sistema"
                      />
                    </Slider.Root>
                  </div>

                  {isTauri && (
                    <div className="space-y-1.5 pt-2 hairline-t">
                      <label className="block text-[11px] font-mono uppercase tracking-wider text-[#A1A1AA]">
                        Modo de Acionamento (Push-to-Talk)
                      </label>
                      <div className="space-y-1">
                        {PTT_PRESETS.map((p) => {
                          const active = p.vk === pttKey;
                          return (
                            <button
                              key={p.label}
                              type="button"
                              onClick={() => void setPushToTalkKey(p.vk)}
                              className={`w-full min-h-[36px] px-2.5 py-1.5 rounded-lg text-left flex items-center justify-between transition-colors ${
                                active
                                  ? "bg-[#16161C] text-[#FAFAFA] border border-[#B91C1C]/50"
                                  : "hover:bg-[#16161C]/60 text-[#A1A1AA]"
                              }`}
                            >
                              <span>{p.label}</span>
                              {active && (
                                <Check
                                  className="w-3.5 h-3.5 text-[#EF4444]"
                                  strokeWidth={1.75}
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Botão Rápido: Resetar Layout / Encaixar Janelas */}
                  <div className="pt-2 hairline-t">
                    <button
                      type="button"
                      onClick={handleResetLayout}
                      className="w-full min-h-[38px] px-3 py-2 rounded-xl bg-[#16161C] hover:bg-[#1E1E26] border border-[#B91C1C]/45 text-xs font-medium text-[#FAFAFA] flex items-center justify-center gap-2 transition-all hover:shadow-[0_0_16px_rgba(185,28,28,0.28)]"
                    >
                      <RotateCcw
                        className="w-3.5 h-3.5 text-[#EF4444]"
                        strokeWidth={1.75}
                      />
                      <span>Resetar Layout / Encaixar Janelas</span>
                    </button>
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {/* Botão Mute — Regra Não-Destrutiva (#1E1E26 + #F87171) */}
            <button
              type="button"
              onClick={() => void toggleMute()}
              className={`min-h-[38px] min-w-[38px] px-2 xl:px-3 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
                muted
                  ? "btn-non-destructive-active"
                  : "bg-[#16161C] hover:bg-[#1E1E26] text-[#FAFAFA] hairline-box"
              }`}
              title={muted ? "Desmutar microfone" : "Mutar microfone"}
              aria-label={muted ? "Desmutar microfone" : "Mutar microfone"}
            >
              {muted ? (
                <MicOff
                  className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[#F87171] shrink-0"
                  strokeWidth={1.5}
                />
              ) : (
                <Mic className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0" strokeWidth={1.5} />
              )}
              <span className="hidden xl:inline">{muted ? "Mutado" : "Mutar"}</span>
            </button>

            {/* Botão Ensurdecer — Regra Não-Destrutiva (#1E1E26 + #F87171) */}
            <button
              type="button"
              onClick={() => void toggleDeafen()}
              className={`min-h-[38px] min-w-[38px] px-2 xl:px-3 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
                deafened
                  ? "btn-non-destructive-active"
                  : "bg-[#16161C] hover:bg-[#1E1E26] text-[#FAFAFA] hairline-box"
              }`}
              title={deafened ? "Reativar áudio" : "Ensurdecer"}
              aria-label={deafened ? "Reativar áudio" : "Ensurdecer"}
            >
              {deafened ? (
                <HeadphoneOff
                  className="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[#F87171] shrink-0"
                  strokeWidth={1.5}
                />
              ) : (
                <Headphones
                  className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0"
                  strokeWidth={1.5}
                />
              )}
              <span className="hidden xl:inline">{deafened ? "Surdo" : "Áudio"}</span>
            </button>

            {/* Ações exclusivas quando conectado em canal de voz */}
            {activeVoiceChannelName && (
              <>
                {(isTauri || browserScreenShareSupported) &&
                  (sharingWindow ? (
                    <button
                      type="button"
                      onClick={() => void stopWindowShare()}
                      className="btn-non-destructive-active min-h-[38px] min-w-[38px] px-2 xl:px-3 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5"
                      title={`Parar transmissão (${sharingWindow.title})`}
                      aria-label="Parar transmissão"
                    >
                      <MonitorOff
                        className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0"
                        strokeWidth={1.5}
                      />
                      <span className="hidden xl:inline max-w-[110px] truncate">
                        Parar ({sharingWindow.title})
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void openWindowPicker()}
                      className="min-h-[38px] min-w-[38px] px-2 xl:px-3 py-1.5 rounded-lg btn-crimson-vivid text-[#FAFAFA] text-xs font-medium flex items-center justify-center gap-1.5"
                      title="Compartilhar Tela"
                      aria-label="Compartilhar Tela"
                    >
                      <MonitorUp
                        className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0"
                        strokeWidth={1.5}
                      />
                      <span className="hidden xl:inline">Compartilhar</span>
                    </button>
                  ))}

                {/* Botão Desconectar — Regra Não-Destrutiva (#1E1E26 + #F87171) */}
                <button
                  type="button"
                  onClick={() => void leaveVoiceChannel()}
                  className="btn-non-destructive-active min-h-[38px] min-w-[38px] px-2 xl:px-3 py-1.5 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 hover:opacity-90 transition-opacity"
                  title="Desconectar da sala de voz"
                  aria-label="Desconectar da sala de voz"
                >
                  <PhoneOff
                    className="w-4 h-4 sm:w-3.5 sm:h-3.5 shrink-0"
                    strokeWidth={1.5}
                  />
                  <span className="hidden xl:inline">Desconectar</span>
                </button>
              </>
            )}
          </div>
        </div>

        {(error ||
          (!isTauri && browserMedia.micNotice) ||
          (activeVoiceChannelName &&
            !isTauri &&
            !browserScreenShareSupported)) && (
          <div className="px-3 sm:px-4 pb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono shrink-0">
            {(error || (!isTauri && browserMedia.micNotice)) && (
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[#F87171] truncate">
                  {error ?? browserMedia.micNotice}
                </span>
                {!isTauri && browserMedia.micNotice && activeVoiceChannelName && (
                  <button
                    type="button"
                    onClick={() => void retryBrowserMicPublish()}
                    className="px-2 py-0.5 rounded bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[10px] text-[#FAFAFA] flex items-center gap-1 shrink-0 transition-colors"
                  >
                    <RefreshCw className="w-2.5 h-2.5 text-[#EF4444]" strokeWidth={1.75} />
                    <span>Tentar novamente</span>
                  </button>
                )}
              </div>
            )}
            {activeVoiceChannelName &&
              !isTauri &&
              !browserScreenShareSupported && (
                <span className="text-[#71717A] ml-auto">
                  Compartilhar tela: disponível via HTTPS ou App Nativo
                </span>
              )}
          </div>
        )}

        {/* Modal Centralizado de Seleção de Janela / Tela (WGC + Áudio Isolado WASAPI) */}
        <Modal
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          overlayZIndexClass="z-[75]"
          contentClassName="w-[92vw] max-w-2xl rounded-2xl bg-[#101014] hairline-box shadow-2xl overflow-hidden flex flex-col max-h-[82dvh]"
        >
          {/* Header com Brilho Radial Carmesim */}
          <div className="px-6 py-4 crimson-header-glow crimson-header-animated-border hairline-b flex items-center justify-between shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-[#16161C] border border-[#B91C1C]/50 flex items-center justify-center">
                <MonitorUp
                  className="w-4 h-4 text-[#EF4444]"
                  strokeWidth={1.5}
                />
              </div>
              <div>
                <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]">
                  Transmitir Aplicação ou Jogo
                </Dialog.Title>
                <Dialog.Description className="text-xs text-[#A1A1AA]">
                  Captura nativa Windows Graphics Capture com isolamento de áudio por PID
                </Dialog.Description>
              </div>
            </div>

            <Dialog.Close asChild>
              <button
                type="button"
                className="p-1.5 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
              >
                <X className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>

          {/* Barra de Configuração de Captura */}
          <div className="px-6 py-3 bg-[#09090B] hairline-b flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={shareAudio}
                onChange={(e) => setShareAudio(e.target.checked)}
                className="accent-[#B91C1C] w-4 h-4 rounded"
              />
              <span className="font-medium text-[#FAFAFA]">
                Capturar áudio isolado do processo
              </span>
              {shareAudio && (
                <span className="px-2 py-0.5 rounded-full bg-[#7F1D1D] border border-[#EF4444] font-mono text-[10px] text-[#FAFAFA] flex items-center gap-1">
                  <Sparkles className="w-2.5 h-2.5" strokeWidth={1.75} />
                  WASAPI ISOLADO ATIVO
                </span>
              )}
            </label>

            <div className="flex items-center gap-1.5 font-mono text-[11px]">
              <span className="text-[#A1A1AA]">TAXA:</span>
              {([30, 60] as const).map((fps) => (
                <button
                  key={fps}
                  type="button"
                  onClick={() => setTargetFps(fps)}
                  className={`px-2 py-1 rounded-md transition-colors ${
                    targetFps === fps
                      ? "bg-[#B91C1C] text-[#FAFAFA]"
                      : "bg-[#16161C] text-[#A1A1AA] hairline-box"
                  }`}
                >
                  {fps} FPS
                </button>
              ))}
            </div>
          </div>

          {/* Grade de Janelas Enumeradas com Miniaturas, Ícones e PID */}
          <div className="p-6 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-3">
            {windows.length === 0 && (
              <div className="col-span-full py-12 text-center space-y-2">
                <Cpu
                  className="w-8 h-8 text-[#71717A] mx-auto"
                  strokeWidth={1.5}
                />
                <p className="text-xs text-[#A1A1AA]">
                  Nenhuma janela gráfica enumerada neste momento.
                </p>
                <p className="text-[11px] font-mono text-[#71717A]">
                  Execute dentro do runtime Tauri Desktop para listar janelas WGC.
                </p>
              </div>
            )}

            {windows.map((w) => (
              <button
                key={w.hwnd}
                type="button"
                onClick={async () => {
                  await startWindowShare({
                    hwnd: w.hwnd,
                    pid: w.pid,
                    title: w.title,
                    targetFps,
                    shareAudio,
                  });
                  setPickerOpen(false);
                }}
                className="group text-left rounded-xl bg-[#16161C] hover:bg-[#1E1E26] hairline-box hover:border-[#B91C1C] transition-all overflow-hidden flex flex-col"
              >
                <div className="h-24 w-full bg-[#09090B] architectural-grid-overlay relative flex items-center justify-center hairline-b">
                  {w.icon_png_base64 ? (
                    <img
                      src={`data:image/png;base64,${w.icon_png_base64}`}
                      alt=""
                      className="w-10 h-10 object-contain drop-shadow-lg group-hover:scale-110 transition-transform"
                    />
                  ) : (
                    <MonitorUp
                      className="w-8 h-8 text-[#71717A] group-hover:text-[#EF4444] transition-colors"
                      strokeWidth={1.5}
                    />
                  )}

                  <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-[#101014] hairline-box font-mono text-[10px] text-[#A1A1AA]">
                    PID {w.pid}
                  </span>

                  {shareAudio && (
                    <span className="absolute bottom-2 left-2 px-2 py-0.5 rounded-full bg-[#7F1D1D]/90 border border-[#EF4444]/70 font-mono text-[9px] text-[#FAFAFA]">
                      ÁUDIO ISOLADO
                    </span>
                  )}
                </div>

                <div className="p-3 flex items-center gap-2.5">
                  {w.icon_png_base64 && (
                    <img
                      src={`data:image/png;base64,${w.icon_png_base64}`}
                      alt=""
                      className="w-4 h-4 shrink-0"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-[#FAFAFA] truncate">
                      {w.title}
                    </div>
                    <div className="text-[11px] font-mono text-[#71717A] truncate">
                      {w.process_name}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </Modal>
      </section>
    </Tooltip.Provider>
  );
}
