import { useEffect, useMemo, useState, type FormEvent } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Popover from "@radix-ui/react-popover";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import {
  useAuthStore,
  usePresenceStore,
  useServerStore,
  useVoiceStore,
  type ChannelRow,
  type MemberRealtimePresence,
  type PresenceStatus,
  type ServerMemberWithProfile,
  type ServerRoleRow,
} from "@cafofo/core-logic";
import {
  Check,
  Cpu,
  Gamepad2,
  HeadphoneOff,
  MicOff,
  MonitorUp,
  Plus,
  Tag,
  Trash2,
  Users,
  Volume2,
  X,
} from "lucide-react";
import {
  cacheGameIcon,
  ensureGameIconExtracted,
  extractExeFilename,
  loadSavedCustomGames,
  resolveGameIconUrl,
  saveCustomGamesToStorage,
  suggestFriendlyGameName,
  useGameIcons,
} from "../lib/gameIcons";
import {
  addCustomGame,
  extractExeIcon,
  isTauriRuntime,
  listCustomGames,
  removeCustomGame,
  syncCustomGames,
  type KnownGameEntry,
} from "../lib/tauri";
import {
  buildMemberCardData,
  formatMemberGameElapsed,
  MemberContextMenuContent,
  MemberInspectAndKickDialogs,
} from "./MemberContextMenu";
import {
  AvatarWithFrame,
  ProfileCardPreview,
  type ProfileCardData,
} from "./ProfileCardPreview";
import { MusicBotPanel } from "./MusicBotPanel";
import {
  ServerRolesManagerDialog,
  type ServerRolesManagerDialogProps,
} from "./ServerRolesManagerDialog";

export { ServerRolesManagerDialog, type ServerRolesManagerDialogProps };

const EMPTY_MEMBERS: ServerMemberWithProfile[] = [];
const EMPTY_CHANNELS: ChannelRow[] = [];
const EMPTY_ROLES: ServerRoleRow[] = [];
const EMPTY_ONLINE_MAP: Record<string, MemberRealtimePresence> = {};

interface MembersPresencePanelProps {
  isOpen?: boolean;
  onClose?: () => void;
}

interface MemberRoleBadgeInfo {
  label: string;
  color: string;
}

interface MemberGroupSection {
  id: string;
  title: string;
  color: string;
  members: Array<{
    member: ServerMemberWithProfile;
    badge: MemberRoleBadgeInfo;
  }>;
}

export function MembersPresencePanel({
  isOpen = false,
  onClose,
}: MembersPresencePanelProps) {
  const selfUserId = useAuthStore((s) => s.user?.id);
  const servers = useServerStore((s) => s.servers);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const members = useServerStore((s) =>
    activeServerId
      ? (s.membersByServer[activeServerId] ?? EMPTY_MEMBERS)
      : EMPTY_MEMBERS,
  );
  const serverRoles = useServerStore((s) =>
    activeServerId
      ? (s.rolesByServer[activeServerId] ?? EMPTY_ROLES)
      : EMPTY_ROLES,
  );
  const channels = useServerStore((s) =>
    activeServerId
      ? (s.channelsByServer[activeServerId] ?? EMPTY_CHANNELS)
      : EMPTY_CHANNELS,
  );
  const voiceChannels = channels.filter((c) => c.type === "voice");

  const onlineMap = usePresenceStore((s) =>
    activeServerId
      ? (s.onlineByServer[activeServerId] ?? EMPTY_ONLINE_MAP)
      : EMPTY_ONLINE_MAP,
  );
  const localStatus = usePresenceStore((s) => s.localStatus);
  const gameCatalog = usePresenceStore((s) => s.gameCatalog);
  const gameByUser = usePresenceStore((s) => s.gameByUser);
  const currentGame = usePresenceStore((s) => s.currentGame);
  const gameIcons = useGameIcons();

  const peers = useVoiceStore((s) => s.peers);
  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId);
  const voiceMuted = useVoiceStore((s) => s.muted);
  const voiceDeafened = useVoiceStore((s) => s.deafened);
  const voiceSpeaking = useVoiceStore((s) => s.speaking);
  const sharingWindow = useVoiceStore((s) => s.sharingWindow);
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);
  const joinVoiceChannel = useVoiceStore((s) => s.joinVoiceChannel);
  const movePeerToRoom = useVoiceStore((s) => s.movePeerToRoom);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [customGames, setCustomGames] = useState<KnownGameEntry[]>(() =>
    loadSavedCustomGames(),
  );
  const [customName, setCustomName] = useState("");
  const [customExe, setCustomExe] = useState("");
  const [customExePath, setCustomExePath] = useState<string | null>(null);
  const [customPreviewIcon, setCustomPreviewIcon] = useState<string | null>(
    null,
  );
  const [customError, setCustomError] = useState<string | null>(null);
  const [customToast, setCustomToast] = useState<string | null>(null);
  const [detectorOpen, setDetectorOpen] = useState(false);
  const [rolesModalOpen, setRolesModalOpen] = useState(false);

  const [inspectedCard, setInspectedCard] = useState<{
    userId: string;
    data: ProfileCardData;
  } | null>(null);
  const [kickCandidate, setKickCandidate] =
    useState<ServerMemberWithProfile | null>(null);

  const hasAnyActiveGame =
    Boolean(currentGame?.started_at_ms) ||
    Object.values(gameByUser).some((g) => Boolean(g?.started_at_ms)) ||
    Object.values(onlineMap).some((p) =>
      Boolean(p?.game_presence?.started_at_ms),
    );

  useEffect(() => {
    if (!hasAnyActiveGame) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [hasAnyActiveGame]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const localSaved = loadSavedCustomGames();
    const hydrate =
      localSaved.length > 0 ? syncCustomGames(localSaved) : listCustomGames();
    void hydrate
      .then((list) => {
        setCustomGames(list);
        saveCustomGamesToStorage(list);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || !currentGame?.process_name) return;
    void ensureGameIconExtracted({
      gameId: currentGame.game_id,
      processName: currentGame.process_name,
    });
  }, [currentGame?.game_id, currentGame?.process_name]);

  const showDetectorSuccessToast = (message: string) => {
    setCustomToast(message);
    setTimeout(() => {
      setCustomToast((curr) => (curr === message ? null : curr));
    }, 2800);
  };

  const handleBrowseExecutable = async () => {
    if (!isTauriRuntime()) return;
    setCustomError(null);
    try {
      const selected = await openNativeDialog({
        multiple: false,
        filters: [{ name: "Executáveis Windows", extensions: ["exe"] }],
      });
      if (!selected || Array.isArray(selected)) return;

      const exeFilename = extractExeFilename(selected);
      const suggested = suggestFriendlyGameName(exeFilename);
      setCustomExePath(selected);
      setCustomExe(exeFilename);
      if (suggested) {
        setCustomName(suggested);
      }

      const iconUrl = await extractExeIcon(selected).catch(() => null);
      setCustomPreviewIcon(iconUrl);
      if (iconUrl) {
        cacheGameIcon({ exeName: exeFilename, iconDataUrl: iconUrl });
      }
      showDetectorSuccessToast("Executável vinculado com sucesso");
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddCustomGame = async (e: FormEvent) => {
    e.preventDefault();
    if (!isTauriRuntime() || !customName.trim() || !customExe.trim()) return;
    setCustomError(null);
    try {
      const targetExe = extractExeFilename(customExe.trim());
      const next = await addCustomGame({
        name: customName.trim(),
        executable: targetExe,
      });
      setCustomGames(next);
      saveCustomGamesToStorage(next);

      const savedEntry = next.find((g) =>
        g.executables.some(
          (exe) => exe.toLowerCase() === targetExe.toLowerCase(),
        ),
      );
      if (customPreviewIcon) {
        cacheGameIcon({
          gameId: savedEntry?.game_id ?? null,
          exeName: targetExe,
          iconDataUrl: customPreviewIcon,
        });
      } else if (customExePath) {
        await ensureGameIconExtracted({
          gameId: savedEntry?.game_id ?? null,
          processName: targetExe,
          exePath: customExePath,
        });
      }

      setCustomName("");
      setCustomExe("");
      setCustomExePath(null);
      setCustomPreviewIcon(null);
      showDetectorSuccessToast("Executável vinculado com sucesso");
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    }
  };

  const activeServer = servers.find((s) => s.id === activeServerId) ?? null;
  const selfMember = members.find((m) => m.user_id === selfUserId) ?? null;
  const isOwnerOrAdmin =
    activeServer?.owner_id === selfUserId ||
    selfMember?.role === "owner" ||
    selfMember?.role === "admin";

  const getRealtimeStatus = (m: ServerMemberWithProfile): PresenceStatus => {
    if (m.user_id === selfUserId) {
      return localStatus;
    }
    const realtime = onlineMap[m.user_id];
    if (realtime) {
      return realtime.status;
    }
    return "offline";
  };

  const getMemberVoiceChannelId = (userId: string): string | null => {
    if (userId === selfUserId) {
      return activeVoiceChannelId ?? null;
    }
    const presenceChannelId = onlineMap[userId]?.voice_state?.channel_id ?? null;
    if (presenceChannelId) {
      return presenceChannelId;
    }
    if (peers[userId] && activeVoiceChannelId) {
      return activeVoiceChannelId;
    }
    return null;
  };

  const isMemberMuted = (userId: string): boolean => {
    if (userId === selfUserId) {
      return Boolean(activeVoiceChannelId && voiceMuted);
    }
    if (peers[userId]) return Boolean(peers[userId].muted);
    return Boolean(onlineMap[userId]?.voice_state?.muted);
  };

  const isMemberDeafened = (userId: string): boolean => {
    if (userId === selfUserId) {
      return Boolean(activeVoiceChannelId && voiceDeafened);
    }
    if (peers[userId]) return Boolean(peers[userId].deafened);
    return Boolean(onlineMap[userId]?.voice_state?.deafened);
  };

  const isMemberSpeaking = (userId: string): boolean => {
    if (userId === selfUserId) {
      return Boolean(activeVoiceChannelId && voiceSpeaking);
    }
    if (peers[userId]?.speaking) return true;
    return Boolean(onlineMap[userId]?.voice_state?.speaking);
  };

  const isMemberStreaming = (userId: string): boolean => {
    if (userId === selfUserId) {
      return Boolean(activeVoiceChannelId && sharingWindow);
    }
    if (peers[userId]?.screen_sharing) return true;
    return Boolean(onlineMap[userId]?.voice_state?.is_streaming);
  };

  const onlineCount = members.filter(
    (m) => getRealtimeStatus(m) !== "offline",
  ).length;

  const groupedSections = useMemo<MemberGroupSection[]>(() => {
    const rolesById = new Map(serverRoles.map((r) => [r.id, r]));
    const customBuckets = new Map<
      string,
      Array<{ member: ServerMemberWithProfile; badge: MemberRoleBadgeInfo }>
    >();
    for (const r of serverRoles) {
      customBuckets.set(r.id, []);
    }

    const ownerAdminBucket: Array<{
      member: ServerMemberWithProfile;
      badge: MemberRoleBadgeInfo;
    }> = [];
    const regularMemberBucket: Array<{
      member: ServerMemberWithProfile;
      badge: MemberRoleBadgeInfo;
    }> = [];

    const sortEntries = (
      list: Array<{
        member: ServerMemberWithProfile;
        badge: MemberRoleBadgeInfo;
      }>,
    ) => {
      return [...list].sort((a, b) => {
        const aStatus =
          a.member.user_id === selfUserId
            ? localStatus
            : (onlineMap[a.member.user_id]?.status ?? "offline");
        const bStatus =
          b.member.user_id === selfUserId
            ? localStatus
            : (onlineMap[b.member.user_id]?.status ?? "offline");
        const aOnline = aStatus !== "offline";
        const bOnline = bStatus !== "offline";
        if (aOnline && !bOnline) return -1;
        if (!aOnline && bOnline) return 1;
        const aName =
          a.member.nickname ||
          a.member.profile?.display_name ||
          a.member.profile?.username ||
          a.member.user_id;
        const bName =
          b.member.nickname ||
          b.member.profile?.display_name ||
          b.member.profile?.username ||
          b.member.user_id;
        return aName.localeCompare(bName);
      });
    };

    for (const m of members) {
      const assignedRole =
        m.custom_role ??
        (m.role_id ? (rolesById.get(m.role_id) ?? null) : null);
      if (assignedRole && customBuckets.has(assignedRole.id)) {
        customBuckets.get(assignedRole.id)!.push({
          member: m,
          badge: {
            label: assignedRole.name,
            color: assignedRole.color || "#B91C1C",
          },
        });
        continue;
      }

      const isServerOwner =
        activeServer?.owner_id === m.user_id || m.role === "owner";
      if (isServerOwner) {
        const adminRole = serverRoles.find(
          (r) => r.name.toUpperCase() === "ADMIN",
        );
        if (adminRole && customBuckets.has(adminRole.id)) {
          customBuckets.get(adminRole.id)!.push({
            member: m,
            badge: { label: "DONO", color: "#EF4444" },
          });
        } else {
          ownerAdminBucket.push({
            member: m,
            badge: { label: "DONO", color: "#EF4444" },
          });
        }
        continue;
      }

      if (m.role === "admin") {
        const adminRole = serverRoles.find(
          (r) => r.name.toUpperCase() === "ADMIN",
        );
        if (adminRole && customBuckets.has(adminRole.id)) {
          customBuckets.get(adminRole.id)!.push({
            member: m,
            badge: { label: adminRole.name, color: adminRole.color },
          });
        } else {
          ownerAdminBucket.push({
            member: m,
            badge: { label: "ADMIN", color: "#EF4444" },
          });
        }
        continue;
      }

      const defaultMemberRole = serverRoles.find(
        (r) =>
          r.name.toUpperCase() === "MEMBRO" ||
          r.name.toUpperCase() === "MEMBROS",
      );
      if (defaultMemberRole && customBuckets.has(defaultMemberRole.id)) {
        customBuckets.get(defaultMemberRole.id)!.push({
          member: m,
          badge: {
            label: defaultMemberRole.name,
            color: defaultMemberRole.color,
          },
        });
      } else {
        regularMemberBucket.push({
          member: m,
          badge: { label: "MEMBRO", color: "#71717A" },
        });
      }
    }

    const sections: MemberGroupSection[] = [];

    if (ownerAdminBucket.length > 0) {
      sections.push({
        id: "sys-owner-admin",
        title: "COMANDO / ADMIN",
        color: "#EF4444",
        members: sortEntries(ownerAdminBucket),
      });
    }

    for (const r of serverRoles) {
      const bucket = customBuckets.get(r.id) ?? [];
      if (bucket.length > 0) {
        sections.push({
          id: r.id,
          title: r.name,
          color: r.color || "#B91C1C",
          members: sortEntries(bucket),
        });
      }
    }

    if (regularMemberBucket.length > 0) {
      sections.push({
        id: "sys-members",
        title: "MEMBROS",
        color: "#A1A1AA",
        members: sortEntries(regularMemberBucket),
      });
    }

    return sections;
  }, [
    members,
    serverRoles,
    onlineMap,
    localStatus,
    selfUserId,
    activeServer?.owner_id,
  ]);

  return (
    <aside
      className={`w-[288px] max-w-[85vw] md:w-[248px] xl:w-72 bg-[#101014] hairline-l flex flex-col justify-between text-xs select-none shrink-0 fixed inset-y-0 right-0 z-50 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] transition-transform duration-200 md:static md:inset-auto md:z-auto md:pt-0 md:pb-0 md:translate-x-0 ${
        isOpen
          ? "translate-x-0"
          : "translate-x-full pointer-events-none md:pointer-events-auto"
      }`}
    >
      {/* Cabeçalho da Lista de Membros */}
      <div className="h-14 px-3.5 hairline-b crimson-header-animated-border flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Users className="w-4 h-4 text-[#A1A1AA] shrink-0" strokeWidth={1.5} />
          <span className="font-semibold text-[#FAFAFA] truncate">Membros</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isOwnerOrAdmin && activeServerId && (
            <button
              type="button"
              onClick={() => setRolesModalOpen(true)}
              className="px-2 py-1 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[10px] font-mono text-[#FAFAFA] flex items-center gap-1 transition-colors"
              title="Gerenciar Cargos e Tags do Servidor"
            >
              <Tag className="w-3 h-3 text-[#EF4444]" strokeWidth={1.5} />
              <span>CARGOS</span>
            </button>
          )}
          <span className="px-2 py-0.5 rounded-full bg-[#16161C] hairline-box font-mono text-[10px] text-[#A1A1AA]">
            {onlineCount}/{members.length} ON
          </span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="md:hidden min-h-[36px] min-w-[36px] rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center justify-center"
              aria-label="Fechar membros"
            >
              <X className="w-4 h-4" strokeWidth={1.5} />
            </button>
          )}
        </div>
      </div>

      {/* Lista de Membros Agrupada por Seções de Cargos/Tags */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {members.length === 0 && (
          <p className="text-xs text-[#71717A] text-center py-8">
            Selecione um servidor para visualizar os membros.
          </p>
        )}

        {groupedSections.map((section) => (
          <div key={section.id} className="space-y-1.5 animate-cyber-slide">
            {/* Cabeçalho da Seção de Cargo em JetBrains Mono */}
            <div className="px-2 py-0.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider">
              <span
                className="flex items-center gap-1.5 font-semibold truncate"
                style={{ color: section.color }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: section.color }}
                />
                <span className="truncate">{section.title}</span>
              </span>
              <span className="text-[#71717A] shrink-0">
                {section.members.length}
              </span>
            </div>

            {section.members.map(({ member: m, badge }) => {
              const realtime = onlineMap[m.user_id];
              const status = getRealtimeStatus(m);
              const speaking = isMemberSpeaking(m.user_id);
              const streaming = isMemberStreaming(m.user_id);
              const memberMuted = isMemberMuted(m.user_id);
              const memberDeafened = isMemberDeafened(m.user_id);
              const activeGame =
                realtime?.game_presence ?? gameByUser[m.user_id] ?? null;
              const displayName =
                m.nickname ||
                m.profile?.display_name ||
                m.profile?.username ||
                m.user_id.slice(0, 8);
              const initials = displayName.slice(0, 2).toUpperCase();
              const accent =
                m.profile?.card_accent_color || badge.color || "#B91C1C";
              const vol = userVolumes[m.user_id] ?? 100;
              const isSelf = m.user_id === selfUserId;
              const elapsedStr = activeGame?.started_at_ms
                ? formatMemberGameElapsed(activeGame.started_at_ms, nowMs)
                : null;
              const memberVoiceChannelId = getMemberVoiceChannelId(m.user_id);
              const memberVoiceChannel = memberVoiceChannelId
                ? voiceChannels.find((vc) => vc.id === memberVoiceChannelId) ??
                  null
                : null;
              const statusDotClass =
                status === "online"
                  ? "bg-emerald-400"
                  : status === "idle"
                    ? "bg-amber-400"
                    : status === "dnd"
                      ? "bg-[#EF4444]"
                      : "bg-[#52525B]";
              const activeGameIconUrl = activeGame
                ? resolveGameIconUrl({
                    icons: gameIcons,
                    gameId: activeGame.game_id,
                    processName: activeGame.process_name,
                    gameCatalog,
                  })
                : null;

              const cardData = buildMemberCardData({
                userId: m.user_id,
                displayName,
                profile: m.profile,
                role: m.role,
                status,
                activeGame,
                elapsedStr,
                gameIconUrl: activeGameIconUrl,
              });

              return (
                <ContextMenu.Root key={m.user_id}>
                  <Popover.Root>
                    <ContextMenu.Trigger asChild>
                      <Popover.Trigger asChild>
                        <button
                          type="button"
                          className={`w-full min-h-[48px] text-left p-2 rounded-xl transition-all flex items-start gap-2.5 group ${
                            speaking || streaming
                              ? "animated-gradient-border bg-[#101014]"
                              : "bg-[#09090B]/45 hover:bg-[#16161C] hairline-box"
                          } ${
                            status === "offline" && !memberVoiceChannelId
                              ? "opacity-55 hover:opacity-95"
                              : ""
                          }`}
                          style={{
                            borderColor:
                              !speaking &&
                              !streaming &&
                              m.profile?.card_border_color
                                ? `${m.profile.card_border_color}44`
                                : undefined,
                          }}
                        >
                          {/* Avatar com Moldura + Pulso de Radar Carmesim quando falando/transmitindo */}
                          <div
                            className={`relative shrink-0 rounded-2xl ${
                              streaming || speaking
                                ? "animate-radar-pulse-crimson"
                                : ""
                            }`}
                          >
                            <AvatarWithFrame
                              avatarUrl={m.profile?.avatar_url}
                              initials={initials}
                              frame={m.profile?.avatar_frame ?? "none"}
                              bgColor="#101014"
                              accentColor={accent}
                              borderColor="rgba(255,255,255,0.12)"
                              sizePx={36}
                            />
                            <span
                              className={`w-2.5 h-2.5 rounded-full absolute -bottom-0.5 -right-0.5 border-2 border-[#101014] ${statusDotClass}`}
                              title={
                                status === "online"
                                  ? "Online"
                                  : status === "idle"
                                    ? "Ausente"
                                    : status === "dnd"
                                      ? "Não Perturbe"
                                      : "Offline"
                              }
                            />
                          </div>

                          {/* Dados do Membro + Pílula de Cargo Colada ao Nome */}
                          <div className="min-w-0 flex-1 space-y-0.5">
                            <div className="flex items-center justify-between gap-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span
                                  className="font-medium text-xs truncate"
                                  style={{
                                    color:
                                      m.profile?.card_text_color || "#FAFAFA",
                                  }}
                                >
                                  {displayName}
                                </span>
                                <span
                                  className="px-1.5 py-0.5 rounded-full font-mono text-[9px] font-semibold uppercase tracking-wide leading-none shrink-0"
                                  style={{
                                    backgroundColor: `${badge.color}22`,
                                    color: badge.color,
                                    border: `1px solid ${badge.color}55`,
                                  }}
                                >
                                  {badge.label}
                                </span>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                {memberVoiceChannelId && memberMuted && (
                                  <MicOff
                                    className="w-3 h-3 text-[#F87171]"
                                    strokeWidth={1.75}
                                  />
                                )}
                                {memberVoiceChannelId && memberDeafened && (
                                  <HeadphoneOff
                                    className="w-3 h-3 text-[#F87171]"
                                    strokeWidth={1.75}
                                  />
                                )}
                                {!isSelf && vol !== 100 && (
                                  <span className="font-mono text-[10px] text-[#EF4444] flex items-center gap-0.5">
                                    <Volume2
                                      className="w-2.5 h-2.5"
                                      strokeWidth={1.5}
                                    />
                                    {vol}%
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Indicador de Call Ativa & Transmissão de Tela (Visível para Todos) */}
                            {memberVoiceChannelId && (
                              <div className="flex items-center justify-between gap-1.5 text-[10px]">
                                <span
                                  className={`flex items-center gap-1 truncate ${
                                    speaking
                                      ? "text-emerald-300 font-medium"
                                      : "text-[#A1A1AA]"
                                  }`}
                                >
                                  <Volume2
                                    className="w-3 h-3 text-[#EF4444] shrink-0"
                                    strokeWidth={1.6}
                                  />
                                  <span className="truncate">
                                    {memberVoiceChannel?.name ?? "Em chamada"}
                                  </span>
                                </span>
                                {streaming && (
                                  <span className="px-1.5 py-0.5 rounded bg-[#7F1D1D] border border-[#EF4444] font-mono text-[8px] leading-none text-[#FAFAFA] flex items-center gap-1 shrink-0">
                                    <MonitorUp
                                      className="w-2.5 h-2.5"
                                      strokeWidth={1.75}
                                    />
                                    AO VIVO
                                  </span>
                                )}
                              </div>
                            )}

                            {(m.profile?.custom_status_emoji ||
                              m.profile?.custom_status_text) && (
                              <div className="text-[11px] text-[#A1A1AA] truncate">
                                {m.profile.custom_status_emoji}{" "}
                                {m.profile.custom_status_text}
                              </div>
                            )}

                            {/* Jogo Ativo com Ícone + Tempo de Sessão em JetBrains Mono (HH:MM:SS) */}
                            {activeGame?.game_name && (
                              <div className="pt-0.5 flex items-center justify-between gap-1.5 text-[11px]">
                                <span className="text-[#EF4444] flex items-center gap-1.5 truncate font-medium">
                                  {activeGameIconUrl ? (
                                    <img
                                      src={activeGameIconUrl}
                                      alt={activeGame.game_name}
                                      className="w-3.5 h-3.5 rounded-sm object-contain shrink-0"
                                    />
                                  ) : (
                                    <Gamepad2
                                      className="w-3.5 h-3.5 shrink-0"
                                      strokeWidth={1.5}
                                    />
                                  )}
                                  <span className="truncate">
                                    {activeGame.game_name}
                                  </span>
                                </span>
                                {elapsedStr && (
                                  <span className="font-mono text-[10px] text-[#A1A1AA] bg-[#09090B] px-1.5 py-0.5 rounded hairline-box shrink-0">
                                    {elapsedStr}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </button>
                      </Popover.Trigger>
                    </ContextMenu.Trigger>

                    {/* Popover de Perfil Expandido + Slider de Volume Individual */}
                    <Popover.Portal>
                      <Popover.Content
                        side="left"
                        align="start"
                        sideOffset={10}
                        collisionPadding={16}
                        avoidCollisions
                        className="w-[min(20rem,calc(100vw-24px))] max-h-[calc(100dvh-28px)] overflow-y-auto z-[70] focus:outline-none animate-popover-in"
                      >
                        <ProfileCardPreview
                          data={cardData}
                          userVolume={!isSelf ? vol : undefined}
                          onUserVolumeChange={
                            !isSelf
                              ? (nextVol) => setUserVolume(m.user_id, nextVol)
                              : undefined
                          }
                        />
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>

                  {/* Menu de Contexto (Botão Direito no Membro) */}
                  <MemberContextMenuContent
                    isSelf={isSelf}
                    member={m}
                    userVolume={vol}
                    onUserVolumeChange={(nextVol) =>
                      setUserVolume(m.user_id, nextVol)
                    }
                    activeServerId={activeServerId}
                    isOwnerOrAdmin={isOwnerOrAdmin}
                    memberVoiceChannelId={memberVoiceChannelId}
                    voiceChannels={voiceChannels}
                    onMoveToVoiceChannel={(vc) => {
                      if (!activeServerId || !memberVoiceChannelId) return;
                      if (isSelf) {
                        void joinVoiceChannel({
                          channelId: vc.id,
                          channelName: vc.name,
                        });
                      } else {
                        movePeerToRoom({
                          serverId: activeServerId,
                          sourceRoomId: memberVoiceChannelId,
                          targetRoomId: vc.id,
                          targetUserId: m.user_id,
                        });
                      }
                    }}
                    onInspectProfile={() =>
                      setInspectedCard({ userId: m.user_id, data: cardData })
                    }
                    onRequestKick={(candidate) => setKickCandidate(candidate)}
                  />
                </ContextMenu.Root>
              );
            })}
          </div>
        ))}
      </div>

      {/* Bot de Música Nativo na Call (YouTube + Fila) */}
      <MusicBotPanel />

      {/* Game Detector Discreto em Segundo Plano (expansível sob demanda) */}
      <div className="px-3 py-2 bg-[#09090B] hairline-t space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-[#71717A] min-w-0">
            <Cpu className="w-3 h-3 text-[#EF4444] shrink-0" strokeWidth={1.5} />
            {currentGame?.game_name ? (
              <span className="text-[#FAFAFA] truncate">
                {currentGame.game_name}{" "}
                <span className="text-[#EF4444]">
                  {formatMemberGameElapsed(currentGame.started_at_ms, nowMs)}
                </span>
              </span>
            ) : (
              <span className="truncate">Game Detector</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setDetectorOpen((v) => !v)}
            className="px-2 py-0.5 rounded bg-[#16161C] hairline-box text-[10px] text-[#A1A1AA] hover:text-[#FAFAFA] shrink-0"
          >
            {detectorOpen ? "Ocultar" : "Jogos"}
          </button>
        </div>

        {/* Toast Estilizado em Pílula Carmesim ("Executável vinculado com sucesso") */}
        {customToast && (
          <div className="px-3 py-1.5 rounded-full bg-[#7F1D1D]/90 border border-[#EF4444] font-mono text-[10px] text-[#FAFAFA] flex items-center justify-center gap-1.5 shadow-[0_0_20px_rgba(185,28,28,0.35)] animate-cyber-slide">
            <Check
              className="w-3 h-3 text-emerald-400 shrink-0"
              strokeWidth={1.75}
            />
            <span className="truncate">{customToast}</span>
          </div>
        )}

        {/* Gaveta Expansível para Adicionar Jogos Customizados */}
        {detectorOpen && (
          <div className="space-y-2 pt-1 animate-cyber-slide">
            <form onSubmit={handleAddCustomGame} className="space-y-1.5">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  placeholder="eldenring.exe"
                  value={customExe}
                  onChange={(e) => setCustomExe(e.target.value)}
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#101014] hairline-box text-xs font-mono text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
                />
                <button
                  type="button"
                  disabled={!isTauriRuntime()}
                  onClick={() => void handleBrowseExecutable()}
                  className="px-2.5 py-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box disabled:opacity-40 text-[#FAFAFA] flex items-center justify-center shrink-0 transition-all hover:border-[#B91C1C]"
                  title="Selecionar executável (.exe) via explorador nativo"
                  aria-label="Selecionar executável (.exe)"
                >
                  <Plus
                    className="w-3.5 h-3.5 text-[#EF4444]"
                    strokeWidth={1.75}
                  />
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                {customPreviewIcon && (
                  <img
                    src={customPreviewIcon}
                    alt=""
                    className="w-6 h-6 rounded bg-[#101014] hairline-box object-contain p-0.5 shrink-0"
                  />
                )}
                <input
                  type="text"
                  placeholder="Nome amigável (ex: Elden Ring)"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-[#101014] hairline-box text-xs text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
                />
                <button
                  type="submit"
                  disabled={
                    !isTauriRuntime() ||
                    !customName.trim() ||
                    !customExe.trim()
                  }
                  className="px-2.5 py-1.5 rounded-lg btn-crimson-vivid disabled:opacity-40 text-[11px] font-medium text-[#FAFAFA] shrink-0"
                >
                  Salvar
                </button>
              </div>
              {customError && (
                <p className="text-[10px] font-mono text-[#F87171]">
                  {customError}
                </p>
              )}
            </form>

            {customGames.length > 0 && (
              <ul className="space-y-1 max-h-28 overflow-y-auto">
                {customGames.map((g) => {
                  const itemIcon = resolveGameIconUrl({
                    icons: gameIcons,
                    gameId: g.game_id,
                    executables: g.executables,
                    gameCatalog,
                  });
                  return (
                    <li
                      key={g.game_id}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-[#101014] hairline-box"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {itemIcon ? (
                          <img
                            src={itemIcon}
                            alt=""
                            className="w-4 h-4 rounded-sm object-contain shrink-0"
                          />
                        ) : (
                          <Gamepad2
                            className="w-3.5 h-3.5 text-[#71717A] shrink-0"
                            strokeWidth={1.5}
                          />
                        )}
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium text-[#FAFAFA] truncate">
                            {g.name}
                          </div>
                          <div className="text-[10px] font-mono text-[#71717A] truncate">
                            {g.executables.join(", ")}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          const next = await removeCustomGame(g.game_id);
                          setCustomGames(next);
                          saveCustomGamesToStorage(next);
                        }}
                        className="p-1 rounded hover:bg-[#1E1E26] text-[#F87171] shrink-0"
                      >
                        <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Modal: Gerenciar Cargos & Tags do Servidor */}
      <ServerRolesManagerDialog
        open={rolesModalOpen}
        onOpenChange={setRolesModalOpen}
        serverId={activeServerId}
        serverName={activeServer?.name}
      />

      {/* Modal: Ver Cartão de Perfil pelo Menu de Contexto */}
      <MemberInspectAndKickDialogs
        activeServerId={activeServerId}
        selfUserId={selfUserId}
        userVolumes={userVolumes}
        setUserVolume={setUserVolume}
        inspectedCard={inspectedCard}
        onCloseInspect={() => setInspectedCard(null)}
        kickCandidate={kickCandidate}
        onCloseKick={() => setKickCandidate(null)}
      />
    </aside>
  );
}
