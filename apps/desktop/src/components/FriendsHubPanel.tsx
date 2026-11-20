import { useMemo, useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  useAuthStore,
  useFriendsStore,
  usePresenceStore,
  type FriendshipWithProfile,
  type PresenceStatus,
} from "@cafofo/core-logic";
import {
  Ban,
  Check,
  Copy,
  Gamepad2,
  MessageSquare,
  PanelLeft,
  Phone,
  Search,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
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

type FriendsTab = "online" | "all" | "pending" | "blocked" | "add";

interface FriendsHubPanelProps {
  onOpenDmChannel: (dmChannelId: string) => void;
  onOpenLeftDrawer?: () => void;
}

export function FriendsHubPanel({
  onOpenDmChannel,
  onOpenLeftDrawer,
}: FriendsHubPanelProps) {
  const selfProfile = useAuthStore((s) => s.profile);
  const friendships = useFriendsStore((s) => s.friendships);
  const friendPresenceByUser = useFriendsStore((s) => s.friendPresenceByUser);
  const sendFriendRequestByUsername = useFriendsStore(
    (s) => s.sendFriendRequestByUsername,
  );
  const acceptFriendRequest = useFriendsStore((s) => s.acceptFriendRequest);
  const removeOrDeclineFriendship = useFriendsStore(
    (s) => s.removeOrDeclineFriendship,
  );
  const blockUser = useFriendsStore((s) => s.blockUser);
  const openOrCreateDm = useFriendsStore((s) => s.openOrCreateDm);
  const startDirectCall = useFriendsStore((s) => s.startDirectCall);

  const onlineByServer = usePresenceStore((s) => s.onlineByServer);
  const gameCatalog = usePresenceStore((s) => s.gameCatalog);
  const gameIcons = useGameIcons();

  const [tab, setTab] = useState<FriendsTab>("online");
  const [search, setSearch] = useState("");
  const [addUsername, setAddUsername] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addFeedback, setAddFeedback] = useState<{
    kind: "ok" | "err";
    text: string;
  } | null>(null);
  const [copiedSelfUsername, setCopiedSelfUsername] = useState(false);
  const [inspectedCard, setInspectedCard] = useState<ProfileCardData | null>(
    null,
  );

  const resolveFriendPresence = (userId: string) => {
    const globalPres = friendPresenceByUser[userId];
    if (globalPres) {
      return {
        status: globalPres.status,
        game: globalPres.game_presence,
      };
    }
    for (const serverMap of Object.values(onlineByServer)) {
      const found = serverMap[userId];
      if (found) {
        return {
          status: found.status,
          game: found.game_presence,
        };
      }
    }
    return {
      status: "offline" as PresenceStatus,
      game: null,
    };
  };

  const { accepted, pendingIncoming, pendingOutgoing, blocked } = useMemo(() => {
    const acc: FriendshipWithProfile[] = [];
    const pendIn: FriendshipWithProfile[] = [];
    const pendOut: FriendshipWithProfile[] = [];
    const blk: FriendshipWithProfile[] = [];

    for (const f of friendships) {
      if (f.status === "accepted") acc.push(f);
      else if (f.status === "blocked") blk.push(f);
      else if (f.direction === "incoming") pendIn.push(f);
      else pendOut.push(f);
    }

    return {
      accepted: acc,
      pendingIncoming: pendIn,
      pendingOutgoing: pendOut,
      blocked: blk,
    };
  }, [friendships]);

  const query = search.trim().toLowerCase();
  const matchesQuery = (f: FriendshipWithProfile) => {
    if (!query) return true;
    const name = (f.otherUser?.display_name ?? "").toLowerCase();
    const uname = (f.otherUser?.username ?? "").toLowerCase();
    return name.includes(query) || uname.includes(query);
  };

  const onlineFriends = accepted.filter((f) => {
    const uid = f.otherUser?.id ?? (f.direction === "outgoing" ? f.addressee_id : f.requester_id);
    const { status } = resolveFriendPresence(uid);
    return status !== "offline" && matchesQuery(f);
  });

  const allFriends = accepted.filter(matchesQuery);
  const pendingCount = pendingIncoming.length;

  const handleAddFriend = async (e: FormEvent) => {
    e.preventDefault();
    setAddFeedback(null);
    setAddBusy(true);
    try {
      const res = await sendFriendRequestByUsername(addUsername);
      setAddUsername("");
      setAddFeedback({
        kind: "ok",
        text:
          res.status === "accepted"
            ? `Amizade confirmada com ${res.otherUser?.display_name ?? "seu amigo"}!`
            : `Pedido enviado para ${res.otherUser?.display_name ?? `@${addUsername.replace(/^@/, "")}`}.`,
      });
    } catch (err) {
      setAddFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAddBusy(false);
    }
  };

  const handleStartMessage = async (otherUserId: string) => {
    try {
      const dm = await openOrCreateDm(otherUserId);
      onOpenDmChannel(dm.id);
    } catch (err) {
      setAddFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleStartCall = async (f: FriendshipWithProfile) => {
    const otherId =
      f.otherUser?.id ??
      (f.direction === "outgoing" ? f.addressee_id : f.requester_id);
    const otherName =
      f.otherUser?.display_name || f.otherUser?.username || "Amigo";
    try {
      const dm = await openOrCreateDm(otherId);
      onOpenDmChannel(dm.id);
      await startDirectCall({
        dmChannelId: dm.id,
        calleeId: otherId,
        calleeName: otherName,
        calleeAvatarUrl: f.otherUser?.avatar_url ?? null,
      });
    } catch (err) {
      setAddFeedback({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const statusDot = (status: PresenceStatus) =>
    status === "online"
      ? "bg-emerald-400"
      : status === "idle"
        ? "bg-amber-400"
        : status === "dnd"
          ? "bg-[#EF4444]"
          : "bg-[#52525B]";

  const statusLabel = (status: PresenceStatus) =>
    status === "online"
      ? "Online"
      : status === "idle"
        ? "Ausente"
        : status === "dnd"
          ? "Não Perturbe"
          : "Offline";

  const renderFriendRow = (f: FriendshipWithProfile) => {
    const otherId =
      f.otherUser?.id ??
      (f.direction === "outgoing" ? f.addressee_id : f.requester_id);
    const displayName =
      f.otherUser?.display_name || f.otherUser?.username || otherId.slice(0, 8);
    const username = f.otherUser?.username || otherId.slice(0, 8);
    const initials = displayName.slice(0, 2).toUpperCase();
    const { status, game } = resolveFriendPresence(otherId);
    const gameIconUrl = game
      ? resolveGameIconUrl({
          icons: gameIcons,
          gameId: game.game_id,
          processName: game.process_name,
          gameCatalog,
        })
      : null;

    const cardData = buildMemberCardData({
      userId: otherId,
      displayName,
      profile: f.otherUser,
      role: null,
      status,
      activeGame: game,
      gameIconUrl,
    });

    return (
      <div
        key={f.id}
        className="group px-3.5 py-2.5 rounded-xl bg-[#101014]/80 hover:bg-[#101014] hairline-box hover:border-white/[0.14] flex items-center justify-between gap-3 transition-all"
      >
        <button
          type="button"
          onClick={() => setInspectedCard(cardData)}
          className="flex items-center gap-3 min-w-0 flex-1 text-left cursor-pointer"
          title="Ver cartão de perfil"
        >
          <div className="relative shrink-0">
            <AvatarWithFrame
              avatarUrl={f.otherUser?.avatar_url}
              initials={initials}
              frame={f.otherUser?.avatar_frame ?? "none"}
              bgColor={f.otherUser?.card_bg_color ?? "#101014"}
              accentColor={f.otherUser?.card_accent_color ?? "#B91C1C"}
              borderColor={f.otherUser?.card_border_color ?? "rgba(255,255,255,0.14)"}
              sizePx={42}
            />
            <span
              className={`w-3 h-3 rounded-full absolute -bottom-0.5 -right-0.5 border-2 border-[#101014] ${statusDot(status)}`}
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold text-[#FAFAFA] truncate">
                {displayName}
              </span>
              <span className="font-mono text-[11px] text-[#71717A] truncate hidden sm:inline">
                @{username}
              </span>
            </div>

            {game ? (
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[#D4D4D8] truncate">
                {gameIconUrl ? (
                  <img
                    src={gameIconUrl}
                    alt=""
                    className="w-3.5 h-3.5 rounded-sm object-contain shrink-0"
                  />
                ) : (
                  <Gamepad2
                    className="w-3.5 h-3.5 text-[#EF4444] shrink-0"
                    strokeWidth={1.5}
                  />
                )}
                <span className="truncate">Jogando {game.game_name}</span>
              </div>
            ) : f.otherUser?.custom_status_text || f.otherUser?.custom_status_emoji ? (
              <div className="mt-0.5 text-[11px] text-[#A1A1AA] truncate">
                {f.otherUser?.custom_status_emoji}{" "}
                {f.otherUser?.custom_status_text}
              </div>
            ) : (
              <div className="mt-0.5 font-mono text-[10px] text-[#71717A]">
                {statusLabel(status)}
              </div>
            )}
          </div>
        </button>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void handleStartMessage(otherId)}
            className="min-h-[36px] min-w-[36px] px-2.5 py-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#FAFAFA] text-xs flex items-center gap-1.5 transition-colors"
            title="Enviar Mensagem Direta"
          >
            <MessageSquare className="w-3.5 h-3.5 text-[#EF4444]" strokeWidth={1.5} />
            <span className="hidden md:inline">Mensagem</span>
          </button>

          <button
            type="button"
            onClick={() => void handleStartCall(f)}
            className="min-h-[36px] min-w-[36px] px-2.5 py-1.5 rounded-lg bg-[#16161C] hover:bg-emerald-600/20 hairline-box hover:border-emerald-500/50 text-emerald-400 text-xs flex items-center gap-1.5 transition-colors"
            title="Iniciar Call 1:1"
          >
            <Phone className="w-3.5 h-3.5" strokeWidth={1.75} />
            <span className="hidden lg:inline">Ligar</span>
          </button>

          <button
            type="button"
            onClick={() => void removeOrDeclineFriendship(f.id)}
            className="min-h-[36px] min-w-[36px] p-2 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#71717A] hover:text-[#F87171] transition-colors"
            title="Remover amigo"
            aria-label="Remover amigo"
          >
            <UserMinus className="w-3.5 h-3.5" strokeWidth={1.5} />
          </button>

          <button
            type="button"
            onClick={() => void blockUser(otherId)}
            className="min-h-[36px] min-w-[36px] p-2 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#71717A] hover:text-[#F87171] transition-colors"
            title="Bloquear usuário"
            aria-label="Bloquear usuário"
          >
            <Ban className="w-3.5 h-3.5" strokeWidth={1.5} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-[#16161C]">
      {/* Header Obsidiana & Carmesim com Abas */}
      <header className="min-h-[56px] px-3 sm:px-5 py-2 crimson-header-glow crimson-header-animated-border hairline-b flex flex-wrap items-center justify-between gap-2 shrink-0 select-none">
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {onOpenLeftDrawer && (
            <button
              type="button"
              onClick={onOpenLeftDrawer}
              className="md:hidden min-h-[38px] min-w-[38px] rounded-lg bg-[#101014] hairline-box text-[#FAFAFA] flex items-center justify-center shrink-0"
              aria-label="Abrir menu lateral"
            >
              <PanelLeft className="w-4 h-4" strokeWidth={1.5} />
            </button>
          )}
          <div className="flex items-center gap-2 pr-2 border-r border-white/[0.08]">
            <Users className="w-4 h-4 text-[#EF4444]" strokeWidth={1.75} />
            <h2 className="text-sm font-semibold text-[#FAFAFA]">Amigos</h2>
          </div>

          <div className="flex items-center gap-1 flex-wrap text-xs">
            {(
              [
                ["online", `Online (${onlineFriends.length})`],
                ["all", `Todos (${accepted.length})`],
                ["pending", "Pendentes"],
                ["blocked", `Bloqueados (${blocked.length})`],
              ] as const
            ).map(([key, label]) => {
              const active = tab === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`px-2.5 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-colors ${
                    active
                      ? "bg-[#101014] text-[#FAFAFA] hairline-box"
                      : "text-[#A1A1AA] hover:text-[#FAFAFA] hover:bg-white/[0.04]"
                  }`}
                >
                  <span>{label}</span>
                  {key === "pending" && pendingCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-[#B91C1C] font-mono text-[10px] leading-none text-white">
                      {pendingCount}
                    </span>
                  )}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => {
                setAddFeedback(null);
                setTab("add");
              }}
              className={`px-3 py-1.5 rounded-lg font-medium flex items-center gap-1.5 transition-all ${
                tab === "add"
                  ? "bg-emerald-600/20 border border-emerald-500/50 text-emerald-300"
                  : "btn-crimson-vivid text-white"
              }`}
            >
              <UserPlus className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span>Adicionar Amigo</span>
            </button>
          </div>
        </div>
      </header>

      {/* Conteúdo Principal */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-4 animate-cyber-slide">
        {tab === "add" ? (
          <div className="max-w-xl space-y-4">
            <div className="p-5 rounded-2xl bg-[#101014] hairline-box space-y-3">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-[#FAFAFA] flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-[#EF4444]" strokeWidth={1.75} />
                  <span>Adicionar por @username</span>
                </h3>
                <p className="text-xs text-[#A1A1AA]">
                  Digite o nome de usuário do seu amigo para enviar um pedido de amizade e liberar DMs e calls 1:1.
                </p>
              </div>

              <form onSubmit={handleAddFriend} className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  required
                  value={addUsername}
                  onChange={(e) => setAddUsername(e.target.value)}
                  placeholder="Ex: @prototype ou pedro"
                  className="flex-1 px-3.5 py-2.5 rounded-xl bg-[#09090B] hairline-box font-mono text-sm text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
                />
                <button
                  type="submit"
                  disabled={addBusy || !addUsername.trim()}
                  className="min-h-[42px] px-4 py-2 rounded-xl btn-crimson-vivid disabled:opacity-45 text-xs font-medium text-white flex items-center justify-center gap-1.5 shrink-0"
                >
                  <UserCheck className="w-4 h-4" strokeWidth={1.75} />
                  <span>{addBusy ? "Enviando..." : "Enviar Pedido"}</span>
                </button>
              </form>

              {addFeedback && (
                <div
                  className={`px-3 py-2 rounded-xl text-xs font-mono ${
                    addFeedback.kind === "ok"
                      ? "bg-emerald-500/15 border border-emerald-500/35 text-emerald-300"
                      : "bg-[#1E1E26] border border-[#F87171]/35 text-[#F87171]"
                  }`}
                >
                  {addFeedback.text}
                </div>
              )}
            </div>

            {selfProfile?.username && (
              <div className="px-4 py-3 rounded-xl bg-[#101014]/70 hairline-box flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <span className="text-[#71717A] block text-[10px] font-mono uppercase">
                    Seu @username no Cafofo
                  </span>
                  <span className="font-mono text-sm text-[#FAFAFA]">
                    @{selfProfile.username}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void copyPlainText(`@${selfProfile.username}`);
                    setCopiedSelfUsername(true);
                    setTimeout(() => setCopiedSelfUsername(false), 1800);
                  }}
                  className="px-3 py-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#FAFAFA] flex items-center gap-1.5 shrink-0"
                >
                  {copiedSelfUsername ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" strokeWidth={1.75} />
                      <span>Copiado</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-[#A1A1AA]" strokeWidth={1.5} />
                      <span>Copiar</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {(tab === "online" || tab === "all") && (
              <div className="relative max-w-md">
                <Search
                  className="w-3.5 h-3.5 text-[#71717A] absolute left-3 top-1/2 -translate-y-1/2"
                  strokeWidth={1.5}
                />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filtrar amigos por nome ou @username..."
                  className="w-full pl-9 pr-3 py-2 rounded-xl bg-[#101014] hairline-box text-xs text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
                />
              </div>
            )}

            {tab === "online" && (
              <div className="space-y-2">
                <div className="font-mono text-[10px] uppercase tracking-wider text-[#71717A]">
                  ONLINE AGORA — {onlineFriends.length}
                </div>
                {onlineFriends.length === 0 ? (
                  <div className="py-12 text-center space-y-2">
                    <p className="text-sm font-medium text-[#FAFAFA]">
                      Nenhum amigo online no momento
                    </p>
                    <p className="text-xs text-[#71717A]">
                      Veja a aba Todos ou adicione novos amigos pelo @username.
                    </p>
                  </div>
                ) : (
                  onlineFriends.map(renderFriendRow)
                )}
              </div>
            )}

            {tab === "all" && (
              <div className="space-y-2">
                <div className="font-mono text-[10px] uppercase tracking-wider text-[#71717A]">
                  TODOS OS AMIGOS — {allFriends.length}
                </div>
                {allFriends.length === 0 ? (
                  <div className="py-12 text-center space-y-3">
                    <p className="text-sm font-medium text-[#FAFAFA]">
                      Sua lista de amigos ainda está vazia
                    </p>
                    <button
                      type="button"
                      onClick={() => setTab("add")}
                      className="px-4 py-2 rounded-xl btn-crimson-vivid text-xs font-medium text-white inline-flex items-center gap-1.5"
                    >
                      <UserPlus className="w-3.5 h-3.5" strokeWidth={1.75} />
                      <span>Adicionar Primeiro Amigo</span>
                    </button>
                  </div>
                ) : (
                  allFriends.map(renderFriendRow)
                )}
              </div>
            )}

            {tab === "pending" && (
              <div className="space-y-5">
                <div className="space-y-2">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-[#EF4444]">
                    PEDIDOS RECEBIDOS — {pendingIncoming.length}
                  </div>
                  {pendingIncoming.length === 0 ? (
                    <p className="text-xs text-[#71717A] py-2">
                      Nenhum pedido recebido pendente.
                    </p>
                  ) : (
                    pendingIncoming.map((f) => {
                      const name =
                        f.otherUser?.display_name ||
                        f.otherUser?.username ||
                        f.requester_id.slice(0, 8);
                      return (
                        <div
                          key={f.id}
                          className="px-3.5 py-2.5 rounded-xl bg-[#101014] hairline-box flex items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <AvatarWithFrame
                              avatarUrl={f.otherUser?.avatar_url}
                              initials={name.slice(0, 2).toUpperCase()}
                              frame={f.otherUser?.avatar_frame ?? "none"}
                              accentColor={f.otherUser?.card_accent_color ?? "#B91C1C"}
                              sizePx={40}
                            />
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-[#FAFAFA] truncate">
                                {name}
                              </div>
                              <div className="font-mono text-[10px] text-[#71717A] truncate">
                                @{f.otherUser?.username ?? f.requester_id.slice(0, 8)} • Pedido recebido
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => void acceptFriendRequest(f.id)}
                              className="min-h-[36px] px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium flex items-center gap-1.5"
                            >
                              <Check className="w-3.5 h-3.5" strokeWidth={2} />
                              <span>Aceitar</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeOrDeclineFriendship(f.id)}
                              className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#F87171] text-xs flex items-center gap-1"
                            >
                              <X className="w-3.5 h-3.5" strokeWidth={1.75} />
                              <span className="hidden sm:inline">Recusar</span>
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                <div className="space-y-2">
                  <div className="font-mono text-[10px] uppercase tracking-wider text-[#71717A]">
                    PEDIDOS ENVIADOS — {pendingOutgoing.length}
                  </div>
                  {pendingOutgoing.length === 0 ? (
                    <p className="text-xs text-[#71717A] py-2">
                      Nenhum pedido enviado aguardando resposta.
                    </p>
                  ) : (
                    pendingOutgoing.map((f) => {
                      const name =
                        f.otherUser?.display_name ||
                        f.otherUser?.username ||
                        f.addressee_id.slice(0, 8);
                      return (
                        <div
                          key={f.id}
                          className="px-3.5 py-2.5 rounded-xl bg-[#101014]/70 hairline-box flex items-center justify-between gap-3"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <AvatarWithFrame
                              avatarUrl={f.otherUser?.avatar_url}
                              initials={name.slice(0, 2).toUpperCase()}
                              frame={f.otherUser?.avatar_frame ?? "none"}
                              accentColor={f.otherUser?.card_accent_color ?? "#B91C1C"}
                              sizePx={38}
                            />
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-[#FAFAFA] truncate">
                                {name}
                              </div>
                              <div className="font-mono text-[10px] text-[#71717A]">
                                Aguardando aceitação...
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => void removeOrDeclineFriendship(f.id)}
                            className="min-h-[34px] px-3 py-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-xs text-[#A1A1AA] hover:text-[#F87171]"
                          >
                            Cancelar
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {tab === "blocked" && (
              <div className="space-y-2">
                <div className="font-mono text-[10px] uppercase tracking-wider text-[#71717A]">
                  BLOQUEADOS — {blocked.length}
                </div>
                {blocked.length === 0 ? (
                  <p className="text-xs text-[#71717A] py-8 text-center">
                    Nenhum usuário bloqueado.
                  </p>
                ) : (
                  blocked.map((f) => {
                    const name =
                      f.otherUser?.display_name ||
                      f.otherUser?.username ||
                      "Usuário";
                    return (
                      <div
                        key={f.id}
                        className="px-3.5 py-2.5 rounded-xl bg-[#101014]/70 hairline-box flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-[#FAFAFA] truncate">
                            {name}
                          </div>
                          <div className="font-mono text-[10px] text-[#71717A]">
                            @{f.otherUser?.username ?? "bloqueado"}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void removeOrDeclineFriendship(f.id)}
                          className="min-h-[34px] px-3 py-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-xs text-[#FAFAFA]"
                        >
                          Desbloquear
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Modal de Inspeção do Cartão de Perfil do Amigo */}
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
