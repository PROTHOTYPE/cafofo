import { useEffect, useState, type CSSProperties } from "react";
import * as Slider from "@radix-ui/react-slider";
import type { AvatarFrameStyle, ProfileCardTheme } from "@cafofo/core-logic";
import { Gamepad2, Radio, Shield, Sparkles, Volume2 } from "lucide-react";
import { formatGameElapsedHMS } from "../lib/gameIcons";

export function getCardThemeOverlayClass(
  theme?: ProfileCardTheme | null,
): string | null {
  switch (theme) {
    case "obsidian-glass":
      return "card-theme-obsidian-glass";
    case "liquid-water":
      return "card-theme-liquid-water";
    case "crimson-fire":
      return "card-theme-crimson-fire";
    case "cyber-hologram":
      return "card-theme-cyber-hologram";
    case "neon-grid":
      return "card-theme-neon-grid";
    default:
      return null;
  }
}

export interface ProfileCardData {
  username: string;
  displayName: string;
  bio?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  bannerColor?: string | null;
  bannerGradient?: string | null;
  cardBgColor?: string | null;
  cardAccentColor?: string | null;
  cardTextColor?: string | null;
  cardBorderColor?: string | null;
  customStatusEmoji?: string | null;
  customStatusText?: string | null;
  customBadgeText?: string | null;
  customBadgeColor?: string | null;
  avatarFrame?: AvatarFrameStyle | null;
  cardTheme?: ProfileCardTheme | null;
  role?: string | null;
  onlineStatus?: "online" | "idle" | "dnd" | "offline";
  activeGameName?: string | null;
  activeGameElapsed?: string | null;
  activeGameStartedAtMs?: number | null;
  activeGameIconUrl?: string | null;
  entrySoundUrl?: string | null;
}

interface AvatarWithFrameProps {
  avatarUrl?: string | null;
  initials: string;
  frame?: AvatarFrameStyle | null;
  bgColor?: string;
  accentColor?: string;
  borderColor?: string;
  sizePx?: number;
}

export function AvatarWithFrame({
  avatarUrl,
  initials,
  frame = "none",
  bgColor = "#101014",
  accentColor = "#B91C1C",
  borderColor = "rgba(255, 255, 255, 0.14)",
  sizePx = 68,
}: AvatarWithFrameProps) {
  const inner = (
    <div
      className="w-full h-full overflow-hidden flex items-center justify-center font-bold bg-[#16161C]"
      style={{
        borderRadius: frame === "cyber-cut" ? undefined : "14px",
        clipPath:
          frame === "cyber-cut"
            ? "polygon(18% 0%, 82% 0%, 100% 18%, 100% 82%, 82% 100%, 18% 100%, 0% 82%, 0% 18%)"
            : undefined,
      }}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={initials}
          className="w-full h-full object-cover"
        />
      ) : (
        <span style={{ color: accentColor }}>{initials}</span>
      )}
    </div>
  );

  if (frame === "crimson-pulse") {
    return (
      <div
        className="relative rounded-2xl p-[3px] shadow-[0_0_20px_rgba(185,28,28,0.65)] animate-pulse"
        style={{
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          background: `linear-gradient(135deg, #EF4444 0%, ${accentColor} 100%)`,
          border: `2px solid ${bgColor}`,
        }}
      >
        {inner}
      </div>
    );
  }

  if (frame === "cyber-cut") {
    return (
      <div
        className="relative p-[2.5px] shadow-xl"
        style={{
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          backgroundColor: accentColor,
          clipPath:
            "polygon(18% 0%, 82% 0%, 100% 18%, 100% 82%, 82% 100%, 18% 100%, 0% 82%, 0% 18%)",
        }}
      >
        {inner}
      </div>
    );
  }

  if (frame === "double-neon") {
    return (
      <div
        className="relative rounded-2xl p-[2.5px]"
        style={{
          width: `${sizePx}px`,
          height: `${sizePx}px`,
          background: `linear-gradient(135deg, ${accentColor} 0%, #EF4444 100%)`,
          boxShadow: `0 0 18px ${accentColor}66`,
        }}
      >
        <div
          className="w-full h-full rounded-[13px] p-[2.5px]"
          style={{
            backgroundColor: bgColor,
            border: "1px solid rgba(255,255,255,0.22)",
          }}
        >
          {inner}
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl overflow-hidden flex items-center justify-center text-lg font-bold shadow-lg"
      style={{
        width: `${sizePx}px`,
        height: `${sizePx}px`,
        backgroundColor: "#16161C",
        border: `3px solid ${bgColor}`,
        boxShadow: `0 0 0 1px ${borderColor}`,
      }}
    >
      {inner}
    </div>
  );
}

interface ProfileCardPreviewProps {
  data: ProfileCardData;
  /** Volume individual (0-200%) exibido quando for outro membro na sala */
  userVolume?: number;
  onUserVolumeChange?: (volume: number) => void;
  /** Callback para testar som de entrada no editor */
  onTestEntrySound?: () => void;
  isPlayingSound?: boolean;
  compact?: boolean;
}

export function ProfileCardPreview({
  data,
  userVolume,
  onUserVolumeChange,
  onTestEntrySound,
  isPlayingSound = false,
}: ProfileCardPreviewProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!data.activeGameStartedAtMs) return;
    setNowMs(Date.now());
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [data.activeGameStartedAtMs]);

  const bgColor = data.cardBgColor || "#101014";
  const accentColor = data.cardAccentColor || "#B91C1C";
  const textColor = data.cardTextColor || "#FAFAFA";
  const borderColor = data.cardBorderColor || "rgba(255, 255, 255, 0.12)";
  const bannerColor = data.bannerColor || "#7F1D1D";
  const badgeColor = data.customBadgeColor || accentColor;

  const initials = (data.displayName || data.username || "CF")
    .slice(0, 2)
    .toUpperCase();

  const statusColor =
    data.onlineStatus === "online"
      ? "#10B981"
      : data.onlineStatus === "idle"
        ? "#F59E0B"
        : data.onlineStatus === "dnd"
          ? "#EF4444"
          : "#52525B";

  const roleFallbackBadge =
    data.role === "owner"
      ? "DONO DO CAFOFO"
      : data.role === "admin"
        ? "GUARDIÃO"
        : "MEMBRO";

  const stickerLabel = data.customBadgeText?.trim() || roleFallbackBadge;

  const bannerBackgroundImage = data.bannerUrl
    ? `url(${data.bannerUrl})`
    : data.bannerGradient
      ? data.bannerGradient
      : `radial-gradient(circle at 25% 20%, ${accentColor}66 0%, transparent 65%), linear-gradient(135deg, ${bannerColor} 0%, #09090B 100%)`;

  const themeOverlayClass = getCardThemeOverlayClass(data.cardTheme);

  return (
    <div
      className="relative w-full rounded-xl overflow-hidden shadow-2xl transition-colors"
      style={
        {
          backgroundColor: bgColor,
          color: textColor,
          border: `1px solid ${borderColor}`,
          "--card-accent": accentColor,
        } as CSSProperties
      }
    >
      {themeOverlayClass && (
        <div
          className={`card-theme-overlay ${themeOverlayClass}`}
          aria-hidden="true"
        />
      )}

      {/* Banner Superior com Scoped Glass Overlay */}
      <div
        className="relative z-10 h-28 w-full overflow-hidden"
        style={{
          backgroundColor: bannerColor,
          backgroundImage: bannerBackgroundImage,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        {/* Scoped Glass Overlay no Banner de Perfil */}
        <div className="scoped-glass absolute top-2.5 right-2.5 px-2.5 py-1 rounded-full flex items-center gap-1.5 text-[11px] font-mono text-[#FAFAFA]">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: statusColor }}
          />
          <span className="uppercase tracking-wider">
            {data.onlineStatus ?? "online"}
          </span>
        </div>

        {data.entrySoundUrl && onTestEntrySound && (
          <button
            type="button"
            onClick={onTestEntrySound}
            className="scoped-glass absolute top-2.5 left-2.5 z-20 px-2.5 py-1 rounded-full flex items-center gap-1.5 text-[11px] font-medium text-[#FAFAFA] hover:border-white/30 transition"
          >
            <Radio className="w-3 h-3 text-[#EF4444]" strokeWidth={1.5} />
            <span>{isPlayingSound ? "Parar Som" : "Ouvir Entrada"}</span>
          </button>
        )}
      </div>

      {/* Corpo do Cartão */}
      <div className="px-4 pb-4 relative z-10">
        {/* Avatar Sobreposto com Moldura */}
        <div className="relative -mt-9 mb-3 flex items-end justify-between gap-2">
          <AvatarWithFrame
            avatarUrl={data.avatarUrl}
            initials={initials}
            frame={data.avatarFrame ?? "none"}
            bgColor={bgColor}
            accentColor={accentColor}
            borderColor={borderColor}
            sizePx={68}
          />

          {/* Stickers do perfil */}
          <div className="flex flex-wrap gap-1.5 justify-end pt-2">
            <span
              className="die-cut-sticker"
              style={{
                backgroundColor: badgeColor,
                color: "#FAFAFA",
              }}
            >
              <Shield className="w-3 h-3" strokeWidth={1.75} />
              {stickerLabel}
            </span>

            {data.entrySoundUrl && (
              <span
                className="die-cut-sticker"
                style={{
                  backgroundColor: "#16161C",
                  color: "#FAFAFA",
                }}
              >
                <Sparkles className="w-3 h-3 text-[#EF4444]" strokeWidth={1.75} />
                SOM DE ENTRADA
              </span>
            )}
          </div>
        </div>

        {/* Nome & Username */}
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold tracking-tight leading-snug truncate">
            {data.displayName || "Sem nome"}
          </h3>
          <p className="text-xs font-mono opacity-65 truncate">
            @{data.username || "cafofo"}
          </p>
        </div>

        {/* Status Customizado */}
        {(data.customStatusEmoji || data.customStatusText) && (
          <div
            className="mt-2.5 px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2"
            style={{
              backgroundColor: "rgba(9, 9, 11, 0.55)",
              border: "1px solid rgba(255, 255, 255, 0.07)",
            }}
          >
            {data.customStatusEmoji && (
              <span className="text-sm leading-none">{data.customStatusEmoji}</span>
            )}
            <span className="truncate opacity-90">{data.customStatusText}</span>
          </div>
        )}

        {/* Bio */}
        {data.bio && (
          <div className="mt-3 pt-2.5 border-t border-white/[0.07]">
            <div className="text-[10px] font-mono uppercase tracking-wider opacity-50 mb-1">
              Sobre
            </div>
            <p className="text-xs leading-relaxed opacity-85 whitespace-pre-wrap line-clamp-3">
              {data.bio}
            </p>
          </div>
        )}

        {/* Presença de Jogo em Tempo Real */}
        {data.activeGameName && (
          <div
            className="mt-3 p-2.5 rounded-lg flex items-center justify-between gap-2"
            style={{
              backgroundColor: "rgba(9, 9, 11, 0.65)",
              border: `1px solid ${accentColor}55`,
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div
                className="w-7 h-7 rounded-md flex items-center justify-center shrink-0 overflow-hidden"
                style={{ backgroundColor: `${accentColor}26`, color: accentColor }}
              >
                {data.activeGameIconUrl ? (
                  <img
                    src={data.activeGameIconUrl}
                    alt={data.activeGameName}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <Gamepad2 className="w-4 h-4" strokeWidth={1.5} />
                )}
              </div>
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider opacity-60 font-medium">
                  Jogando agora
                </div>
                <div className="text-xs font-semibold truncate">
                  {data.activeGameName}
                </div>
              </div>
            </div>
            {(data.activeGameStartedAtMs || data.activeGameElapsed) && (
              <span className="font-mono text-[11px] px-2 py-0.5 rounded bg-black/40 border border-white/[0.07] shrink-0">
                {data.activeGameStartedAtMs
                  ? formatGameElapsedHMS(data.activeGameStartedAtMs, nowMs)
                  : data.activeGameElapsed}
              </span>
            )}
          </div>
        )}

        {/* Slider Radix de Volume Individual (0% - 200%) */}
        {typeof userVolume === "number" && onUserVolumeChange && (
          <div className="mt-3 pt-3 border-t border-white/[0.07] space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5 opacity-75">
                <Volume2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                Volume do Usuário
              </span>
              <span className="font-mono text-[11px] font-medium">
                {userVolume}%
              </span>
            </div>
            <Slider.Root
              className="relative flex items-center select-none touch-none w-full h-4"
              value={[userVolume]}
              min={0}
              max={200}
              step={1}
              onValueChange={(vals) => onUserVolumeChange(vals[0] ?? 100)}
            >
              <Slider.Track className="bg-black/60 relative grow rounded-full h-1.5 overflow-hidden border border-white/[0.07]">
                <Slider.Range
                  className="absolute h-full rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
              </Slider.Track>
              <Slider.Thumb
                className="block w-3.5 h-3.5 bg-[#FAFAFA] rounded-full shadow focus:outline-none border"
                style={{ borderColor: accentColor }}
                aria-label="Volume do usuário"
              />
            </Slider.Root>
          </div>
        )}
      </div>
    </div>
  );
}
