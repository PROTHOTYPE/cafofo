import { useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Dialog from "@radix-ui/react-dialog";
import * as Slider from "@radix-ui/react-slider";
import {
  useFriendsStore,
  useServerStore,
  type ChannelRow,
  type GamePresenceUpdate,
  type PresenceStatus,
  type ProfileRow,
  type ServerMemberWithProfile,
  type ServerRoleRow,
} from "@cafofo/core-logic";
import {
  ArrowRightLeft,
  Check,
  ChevronRight,
  MessageSquare,
  Shield,
  Tag,
  UserCheck,
  UserMinus,
  UserPlus,
  Volume2,
} from "lucide-react";
import { formatGameElapsedHMS } from "../lib/gameIcons";
import { Modal } from "./Modal";
import { ProfileCardPreview, type ProfileCardData } from "./ProfileCardPreview";

export function formatMemberGameElapsed(
  startedAtMs: number | null | undefined,
  nowMs: number,
): string {
  return formatGameElapsedHMS(startedAtMs, nowMs);
}

export function buildMemberCardData(params: {
  userId: string;
  displayName: string;
  profile: ProfileRow | null;
  role: string | null;
  status: PresenceStatus;
  activeGame?: GamePresenceUpdate | null;
  elapsedStr?: string | null;
  gameIconUrl?: string | null;
}): ProfileCardData {
  const {
    userId,
    displayName,
    profile,
    role,
    status,
    activeGame,
    elapsedStr,
    gameIconUrl,
  } = params;

  return {
    username: profile?.username || userId.slice(0, 8),
    displayName,
    bio: profile?.bio,
    avatarUrl: profile?.avatar_url,
    bannerUrl: profile?.banner_url,
    bannerColor: profile?.banner_color,
    bannerGradient: profile?.banner_gradient,
    cardBgColor: profile?.card_bg_color,
    cardAccentColor: profile?.card_accent_color,
    cardTextColor: profile?.card_text_color,
    cardBorderColor: profile?.card_border_color,
    customStatusEmoji: profile?.custom_status_emoji,
    customStatusText: profile?.custom_status_text,
    customBadgeText: profile?.custom_badge_text,
    customBadgeColor: profile?.custom_badge_color,
    avatarFrame: profile?.avatar_frame ?? "none",
    cardTheme: profile?.card_theme ?? "default",
    role,
    onlineStatus: status,
    activeGameName: activeGame?.game_name ?? null,
    activeGameElapsed: elapsedStr ?? null,
    activeGameStartedAtMs: activeGame?.started_at_ms ?? null,
    activeGameIconUrl: gameIconUrl ?? null,
    entrySoundUrl: profile?.entry_sound_url,
  };
}

interface MemberContextMenuContentProps {
  isSelf: boolean;
  member: ServerMemberWithProfile | null;
  userVolume: number;
  onUserVolumeChange: (vol: number) => void;
  activeServerId: string | null;
  isOwnerOrAdmin: boolean;
  memberVoiceChannelId: string | null;
  voiceChannels: ChannelRow[];
  onMoveToVoiceChannel: (targetChannel: ChannelRow) => void;
  onInspectProfile: () => void;
  onRequestKick?: (member: ServerMemberWithProfile) => void;
}

const EMPTY_ROLES: ServerRoleRow[] = [];

export function MemberContextMenuContent({
  isSelf,
  member,
  userVolume,
  onUserVolumeChange,
  activeServerId,
  isOwnerOrAdmin,
  memberVoiceChannelId,
  voiceChannels,
  onMoveToVoiceChannel,
  onInspectProfile,
  onRequestKick,
}: MemberContextMenuContentProps) {
  const serverRoles = useServerStore((s) =>
    activeServerId
      ? (s.rolesByServer[activeServerId] ?? EMPTY_ROLES)
      : EMPTY_ROLES,
  );
  const assignMemberRole = useServerStore((s) => s.assignMemberRole);
  const friendships = useFriendsStore((s) => s.friendships);
  const sendFriendRequestByUserId = useFriendsStore(
    (s) => s.sendFriendRequestByUserId,
  );
  const openOrCreateDm = useFriendsStore((s) => s.openOrCreateDm);

  const targetUserId = member?.user_id ?? null;
  const existingFriendship = targetUserId
    ? friendships.find(
        (f) =>
          f.requester_id === targetUserId || f.addressee_id === targetUserId,
      )
    : undefined;

  const canMoveVoice =
    Boolean(activeServerId) &&
    Boolean(memberVoiceChannelId) &&
    voiceChannels.length > 1 &&
    (isSelf || isOwnerOrAdmin);

  const canManageRole =
    Boolean(activeServerId) && Boolean(member) && isOwnerOrAdmin;

  const canKick =
    Boolean(member) &&
    Boolean(onRequestKick) &&
    isOwnerOrAdmin &&
    !isSelf &&
    member?.role !== "owner";

  return (
    <ContextMenu.Portal>
      <ContextMenu.Content
        collisionPadding={16}
        className="min-w-[235px] max-h-[calc(100dvh-28px)] overflow-y-auto rounded-xl scoped-glass p-1.5 shadow-2xl z-[75] text-xs text-[#FAFAFA] space-y-0.5 animate-popover-in"
      >
        <ContextMenu.Item
          onSelect={onInspectProfile}
          className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]"
        >
          <UserCheck className="w-3.5 h-3.5 text-[#A1A1AA]" strokeWidth={1.5} />
          <span>Ver Cartão de Perfil</span>
        </ContextMenu.Item>

        {!isSelf && targetUserId && (
          <>
            <ContextMenu.Item
              onSelect={() => {
                void openOrCreateDm(targetUserId)
                  .then((dm) => {
                    window.dispatchEvent(
                      new CustomEvent("cafofo:open-dm", {
                        detail: { dmChannelId: dm.id },
                      }),
                    );
                  })
                  .catch(() => {});
              }}
              className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]"
            >
              <MessageSquare
                className="w-3.5 h-3.5 text-[#EF4444]"
                strokeWidth={1.5}
              />
              <span>Enviar Mensagem Direta</span>
            </ContextMenu.Item>

            {(!existingFriendship ||
              (existingFriendship.status === "pending" &&
                existingFriendship.direction === "incoming")) && (
              <ContextMenu.Item
                onSelect={() => {
                  void sendFriendRequestByUserId(targetUserId).catch(() => {});
                }}
                className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]"
              >
                <UserPlus
                  className="w-3.5 h-3.5 text-emerald-400"
                  strokeWidth={1.5}
                />
                <span>
                  {existingFriendship?.direction === "incoming"
                    ? "Aceitar Pedido de Amizade"
                    : "Adicionar como Amigo"}
                </span>
              </ContextMenu.Item>
            )}
          </>
        )}

        {!isSelf && (
          <div
            className="px-2.5 py-2 rounded-lg bg-[#09090B]/65 hairline-box my-1 space-y-1.5"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-[#A1A1AA] flex items-center gap-1.5">
                <Volume2 className="w-3 h-3" strokeWidth={1.5} />
                Volume Individual
              </span>
              <span className="font-mono text-[#FAFAFA]">{userVolume}%</span>
            </div>
            <Slider.Root
              className="relative flex items-center select-none touch-none w-full h-4"
              value={[userVolume]}
              min={0}
              max={200}
              step={1}
              onValueChange={(vals) => onUserVolumeChange(vals[0] ?? 100)}
            >
              <Slider.Track className="bg-[#16161C] relative grow rounded-full h-1.5 hairline-box">
                <Slider.Range className="absolute bg-[#B91C1C] rounded-full h-full" />
              </Slider.Track>
              <Slider.Thumb
                className="block w-3.5 h-3.5 bg-[#FAFAFA] border border-[#B91C1C] rounded-full focus:outline-none"
                aria-label="Volume do membro"
              />
            </Slider.Root>
          </div>
        )}

        {canManageRole && member && activeServerId && (
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]">
              <span className="flex items-center gap-2">
                <Tag className="w-3.5 h-3.5 text-[#EF4444]" strokeWidth={1.5} />
                <span>Alterar Cargo / Tag</span>
              </span>
              <ChevronRight
                className="w-3.5 h-3.5 text-[#71717A]"
                strokeWidth={1.5}
              />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                sideOffset={6}
                collisionPadding={16}
                className="min-w-[210px] max-h-[calc(100dvh-28px)] overflow-y-auto rounded-xl scoped-glass p-1.5 shadow-2xl z-[80] text-xs text-[#FAFAFA] space-y-0.5 animate-popover-in"
              >
                <div className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-[#71717A]">
                  Tags do Servidor
                </div>
                {serverRoles.map((r) => {
                  const isAssigned = member.role_id === r.id;
                  return (
                    <ContextMenu.Item
                      key={r.id}
                      onSelect={() => {
                        const nextSystemRole =
                          member.role === "owner"
                            ? undefined
                            : r.name.toUpperCase() === "ADMIN"
                              ? "admin"
                              : undefined;
                        void assignMemberRole({
                          serverId: activeServerId,
                          userId: member.user_id,
                          roleId: isAssigned ? null : r.id,
                          systemRole: nextSystemRole,
                        }).catch(() => {});
                      }}
                      className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0 border border-white/20"
                          style={{ backgroundColor: r.color }}
                        />
                        <span
                          className="font-mono text-[11px] font-semibold truncate"
                          style={{ color: r.color }}
                        >
                          {r.name}
                        </span>
                      </span>
                      {isAssigned && (
                        <Check
                          className="w-3.5 h-3.5 text-emerald-400 shrink-0"
                          strokeWidth={1.75}
                        />
                      )}
                    </ContextMenu.Item>
                  );
                })}

                <ContextMenu.Item
                  onSelect={() => {
                    void assignMemberRole({
                      serverId: activeServerId,
                      userId: member.user_id,
                      roleId: null,
                    }).catch(() => {});
                  }}
                  className="min-h-[32px] px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 cursor-pointer outline-none text-[#A1A1AA] hover:text-[#FAFAFA] hover:bg-[#16161C] focus:bg-[#16161C]"
                >
                  <span>Sem Tag Customizada</span>
                  {!member.role_id && (
                    <Check
                      className="w-3.5 h-3.5 text-[#71717A] shrink-0"
                      strokeWidth={1.5}
                    />
                  )}
                </ContextMenu.Item>

                {member.role !== "owner" && (
                  <>
                    <ContextMenu.Separator className="h-[1px] bg-white/[0.07] my-1" />
                    <ContextMenu.Item
                      onSelect={() => {
                        const nextRole =
                          member.role === "admin" ? "member" : "admin";
                        void assignMemberRole({
                          serverId: activeServerId,
                          userId: member.user_id,
                          roleId: member.role_id,
                          systemRole: nextRole,
                        }).catch(() => {});
                      }}
                      className="min-h-[32px] px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]"
                    >
                      <span className="flex items-center gap-2">
                        <Shield
                          className="w-3.5 h-3.5 text-[#EF4444]"
                          strokeWidth={1.5}
                        />
                        <span>Permissão de Admin</span>
                      </span>
                      {member.role === "admin" && (
                        <Check
                          className="w-3.5 h-3.5 text-emerald-400 shrink-0"
                          strokeWidth={1.75}
                        />
                      )}
                    </ContextMenu.Item>
                  </>
                )}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
        )}

        {canMoveVoice && (
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center justify-between gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]">
              <span className="flex items-center gap-2">
                <ArrowRightLeft
                  className="w-3.5 h-3.5 text-[#EF4444]"
                  strokeWidth={1.5}
                />
                <span>Mover para Sala de Voz</span>
              </span>
              <ChevronRight
                className="w-3.5 h-3.5 text-[#71717A]"
                strokeWidth={1.5}
              />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent
                sideOffset={6}
                collisionPadding={16}
                className="min-w-[180px] max-h-[calc(100dvh-28px)] overflow-y-auto rounded-xl scoped-glass p-1.5 shadow-2xl z-[80] text-xs text-[#FAFAFA] space-y-0.5 animate-popover-in"
              >
                {voiceChannels
                  .filter((vc) => vc.id !== memberVoiceChannelId)
                  .map((vc) => (
                    <ContextMenu.Item
                      key={vc.id}
                      onSelect={() => onMoveToVoiceChannel(vc)}
                      className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none hover:bg-[#16161C] focus:bg-[#16161C]"
                    >
                      <Volume2
                        className="w-3.5 h-3.5 text-[#A1A1AA]"
                        strokeWidth={1.5}
                      />
                      <span className="truncate">{vc.name}</span>
                    </ContextMenu.Item>
                  ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
        )}

        {canKick && member && onRequestKick && (
          <>
            <ContextMenu.Separator className="h-[1px] bg-white/[0.07] my-1" />
            <ContextMenu.Item
              onSelect={() => onRequestKick(member)}
              className="min-h-[34px] px-2.5 py-1.5 rounded-lg flex items-center gap-2 cursor-pointer outline-none text-[#F87171] hover:bg-[#1E1E26] focus:bg-[#1E1E26]"
            >
              <UserMinus className="w-3.5 h-3.5" strokeWidth={1.5} />
              <span>Expulsar do Servidor</span>
            </ContextMenu.Item>
          </>
        )}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  );
}

interface MemberInspectAndKickDialogsProps {
  activeServerId: string | null;
  selfUserId: string | undefined;
  userVolumes: Record<string, number>;
  setUserVolume: (userId: string, volume: number) => void;
  inspectedCard: { userId: string; data: ProfileCardData } | null;
  onCloseInspect: () => void;
  kickCandidate: ServerMemberWithProfile | null;
  onCloseKick: () => void;
}

export function MemberInspectAndKickDialogs({
  activeServerId,
  selfUserId,
  userVolumes,
  setUserVolume,
  inspectedCard,
  onCloseInspect,
  kickCandidate,
  onCloseKick,
}: MemberInspectAndKickDialogsProps) {
  const kickMember = useServerStore((s) => s.kickMember);
  const [kickError, setKickError] = useState<string | null>(null);

  return (
    <>
      <Modal
        open={Boolean(inspectedCard)}
        onOpenChange={(open) => !open && onCloseInspect()}
        overlayZIndexClass="z-[75]"
        contentClassName="w-[min(22rem,92vw)] rounded-xl overflow-hidden shadow-2xl"
      >
        <Dialog.Title className="sr-only">
          Cartão de Perfil de {inspectedCard?.data.displayName ?? "Membro"}
        </Dialog.Title>
        {inspectedCard && (
          <ProfileCardPreview
            data={inspectedCard.data}
            userVolume={
              inspectedCard.userId !== selfUserId
                ? (userVolumes[inspectedCard.userId] ?? 100)
                : undefined
            }
            onUserVolumeChange={
              inspectedCard.userId !== selfUserId
                ? (vol) => setUserVolume(inspectedCard.userId, vol)
                : undefined
            }
          />
        )}
      </Modal>

      <Modal
        open={Boolean(kickCandidate)}
        onOpenChange={(open) => {
          if (!open) {
            setKickError(null);
            onCloseKick();
          }
        }}
        overlayZIndexClass="z-[75]"
        contentClassName="w-[90vw] max-w-sm rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl space-y-4"
      >
        <Dialog.Title className="text-sm font-semibold text-[#FAFAFA]">
          Expulsar membro?
        </Dialog.Title>
        <Dialog.Description className="text-xs text-[#A1A1AA]">
          Tem certeza que deseja remover{" "}
          <strong className="text-[#FAFAFA]">
            {kickCandidate?.profile?.display_name ??
              kickCandidate?.profile?.username ??
              "este membro"}
          </strong>{" "}
          do servidor? Ele só poderá retornar com um novo código de convite.
        </Dialog.Description>
        {kickError && (
          <p className="text-xs text-[#F87171] font-mono">{kickError}</p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setKickError(null);
              onCloseKick();
            }}
            className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA]"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!activeServerId || !kickCandidate) return;
              setKickError(null);
              try {
                await kickMember({
                  serverId: activeServerId,
                  userId: kickCandidate.user_id,
                });
                onCloseKick();
              } catch (err) {
                setKickError(
                  err instanceof Error ? err.message : String(err),
                );
              }
            }}
            className="min-h-[40px] px-4 py-2 rounded-xl btn-non-destructive-active text-xs font-medium"
          >
            Expulsar
          </button>
        </div>
      </Modal>
    </>
  );
}
