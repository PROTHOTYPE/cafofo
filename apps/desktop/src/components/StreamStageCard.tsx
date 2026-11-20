import { useEffect, useRef, useState, type CSSProperties } from "react";
import * as Slider from "@radix-ui/react-slider";
import type { PeerState, ProfileRow } from "@cafofo/core-logic";
import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import {
  HeadphoneOff,
  Maximize2,
  MicOff,
  Minimize2,
  MonitorUp,
  Pin,
  PinOff,
  Volume2,
} from "lucide-react";
import { useTextScramble } from "../lib/useTextScramble";
import {
  AvatarWithFrame,
  getCardThemeOverlayClass,
} from "./ProfileCardPreview";

export interface StreamStageCardProps {
  peer: PeerState;
  profile?: ProfileRow | null;
  roleBadge?: { label: string; color: string } | null;
  isSelf: boolean;
  isPinned: boolean;
  theaterMode?: boolean;
  userVolume: number;
  streamVolume: number;
  remoteVideoTrack?: RemoteVideoTrack | LocalVideoTrack | null;
  onTogglePin: () => void;
  onUserVolumeChange: (val: number) => void;
  onStreamVolumeChange: (val: number) => void;
}

export function StreamStageCard({
  peer,
  profile,
  roleBadge,
  isSelf,
  isPinned,
  theaterMode = false,
  userVolume,
  streamVolume,
  remoteVideoTrack,
  onTogglePin,
  onUserVolumeChange,
  onStreamVolumeChange,
}: StreamStageCardProps) {
  const screen = peer.screen_sharing;
  const cardRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastTapRef = useRef<number>(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !remoteVideoTrack) return;
    el.playsInline = true;
    remoteVideoTrack.attach(el);
    if (
      "setPlayoutDelay" in remoteVideoTrack &&
      typeof remoteVideoTrack.setPlayoutDelay === "function"
    ) {
      remoteVideoTrack.setPlayoutDelay(0);
    }
    return () => {
      remoteVideoTrack.detach(el);
    };
  }, [remoteVideoTrack]);

  useEffect(() => {
    const handleFsChange = () => {
      const activeEl = document.fullscreenElement;
      const vidEl = videoRef.current as
        | (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })
        | null;
      setIsFullscreen(
        Boolean(
          (cardRef.current && activeEl === cardRef.current) ||
            vidEl?.webkitDisplayingFullscreen,
        ),
      );
    };

    const videoEl = videoRef.current;
    const onWebkitBegin = () => setIsFullscreen(true);
    const onWebkitEnd = () => setIsFullscreen(false);

    document.addEventListener("fullscreenchange", handleFsChange);
    videoEl?.addEventListener("webkitbeginfullscreen", onWebkitBegin);
    videoEl?.addEventListener("webkitendfullscreen", onWebkitEnd);

    return () => {
      document.removeEventListener("fullscreenchange", handleFsChange);
      videoEl?.removeEventListener("webkitbeginfullscreen", onWebkitBegin);
      videoEl?.removeEventListener("webkitendfullscreen", onWebkitEnd);
    };
  }, [remoteVideoTrack]);

  const toggleFullscreen = () => {
    const containerEl = cardRef.current;
    const videoEl = videoRef.current as
      | (HTMLVideoElement & {
          webkitEnterFullscreen?: () => void;
          webkitExitFullscreen?: () => void;
          webkitDisplayingFullscreen?: boolean;
        })
      | null;

    if (!containerEl) return;

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
      return;
    }

    if (
      videoEl?.webkitDisplayingFullscreen &&
      typeof videoEl.webkitExitFullscreen === "function"
    ) {
      videoEl.webkitExitFullscreen();
      return;
    }

    if (typeof containerEl.requestFullscreen === "function") {
      void containerEl.requestFullscreen().catch(() => {
        if (videoEl && typeof videoEl.webkitEnterFullscreen === "function") {
          videoEl.webkitEnterFullscreen();
        }
      });
    } else if (videoEl && typeof videoEl.webkitEnterFullscreen === "function") {
      videoEl.webkitEnterFullscreen();
    }
  };

  const handleStageTouchEnd = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      lastTapRef.current = 0;
      toggleFullscreen();
      return;
    }
    lastTapRef.current = now;
  };

  const hasLiveVideo = Boolean(remoteVideoTrack);
  const isStreaming = Boolean(screen || hasLiveVideo);

  const scrambledLive = useTextScramble(
    isStreaming ? "AO VIVO" : "EM VOZ",
    isStreaming,
    540,
  );
  const scrambledTitle = useTextScramble(
    screen?.source_title || peer.display_name,
    isStreaming,
    620,
  );

  const initials = (peer.display_name || "CF").slice(0, 2).toUpperCase();
  const bgColor = profile?.card_bg_color || "#101014";
  const accentColor = profile?.card_accent_color || "#B91C1C";
  const textColor = profile?.card_text_color || "#FAFAFA";
  const borderColor = profile?.card_border_color || "rgba(255, 255, 255, 0.08)";
  const bannerColor = profile?.banner_color || "#7F1D1D";
  const badgeText = profile?.custom_badge_text?.trim() || roleBadge?.label || null;
  const badgeColor =
    profile?.custom_badge_color || roleBadge?.color || accentColor;
  const statusEmoji = profile?.custom_status_emoji?.trim() || null;
  const statusText =
    profile?.custom_status_text?.trim() || profile?.custom_status?.trim() || null;
  const themeOverlayClass = getCardThemeOverlayClass(profile?.card_theme);

  const bannerBackgroundImage = profile?.banner_url
    ? `url(${profile.banner_url})`
    : profile?.banner_gradient
      ? profile.banner_gradient
      : `radial-gradient(circle at 25% 20%, ${accentColor}55 0%, transparent 65%), linear-gradient(135deg, ${bannerColor} 0%, #09090B 100%)`;

  return (
    <div
      ref={cardRef}
      onDoubleClick={toggleFullscreen}
      onTouchEnd={handleStageTouchEnd}
      className={`group relative overflow-hidden flex flex-col justify-between transition-all ${
        isStreaming || peer.speaking
          ? "animated-gradient-border"
          : "hairline-box"
      } ${
        isFullscreen
          ? "w-full h-full bg-black rounded-none"
          : isPinned
            ? "w-full h-full rounded-xl"
            : "w-full aspect-video rounded-xl"
      }`}
      style={
        {
          backgroundColor: remoteVideoTrack ? "#09090B" : bgColor,
          borderColor: !isStreaming && !peer.speaking ? borderColor : undefined,
          "--card-accent": accentColor,
        } as CSSProperties
      }
    >
      {/* Container Flex Embutido do Palco (sem coordenadas x, y absolutas fora da tela) */}
      <div className="absolute inset-0 overflow-hidden flex flex-col items-center justify-center">
        {remoteVideoTrack ? (
          <div className="relative w-full h-full flex flex-col items-center justify-center bg-black">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-contain bg-black"
            />
            {isSelf && (
              <span className="pointer-events-none absolute bottom-12 right-2.5 px-2 py-0.5 rounded-full bg-[#09090B]/80 border border-white/10 font-mono text-[9px] tracking-wider text-[#A1A1AA]">
                RETORNO LOCAL
              </span>
            )}
          </div>
        ) : screen ? (
          <div className="relative w-full h-full ruby-refraction-canvas architectural-grid-overlay flex flex-col items-center justify-center p-4">
            <div className="w-12 h-12 rounded-2xl bg-[#16161C]/90 hairline-box flex items-center justify-center mb-2 shadow-crimson-glow animate-radar-pulse-crimson">
              <MonitorUp className="w-6 h-6 text-[#EF4444]" strokeWidth={1.5} />
            </div>
            <p className="text-xs font-medium text-[#FAFAFA] max-w-[85%] truncate text-center">
              {scrambledTitle}
            </p>
            <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-[#A1A1AA]">
              <span>{screen.fps} FPS</span>
              <span>•</span>
              <span>WGC DIRECT3D11</span>
              {screen.has_audio && (
                <>
                  <span>•</span>
                  <span className="text-[#EF4444]">WASAPI ISOLADO</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <div
            className="relative w-full h-full flex flex-col items-center justify-center overflow-hidden"
            style={{ backgroundColor: bgColor }}
          >
            {/* Banner personalizado do usuário com fade suave para o fundo do cartão */}
            <div
              className="absolute inset-x-0 top-0 h-[56%] opacity-75"
              style={{
                backgroundColor: bannerColor,
                backgroundImage: bannerBackgroundImage,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }}
            />
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: `linear-gradient(180deg, rgba(9,9,11,0.12) 0%, ${bgColor}cc 52%, ${bgColor} 100%)`,
              }}
            />
            {themeOverlayClass && (
              <div
                className={`card-theme-overlay ${themeOverlayClass}`}
                aria-hidden="true"
              />
            )}

            {/* Avatar personalizado + Sticker + Status */}
            <div className="relative z-10 flex flex-col items-center justify-center gap-1.5 px-3 pt-4 pb-2 max-w-full">
              <div
                className={`rounded-2xl transition-all ${
                  peer.speaking ? "animate-radar-pulse-crimson" : ""
                }`}
              >
                <AvatarWithFrame
                  avatarUrl={profile?.avatar_url}
                  initials={initials}
                  frame={profile?.avatar_frame ?? "none"}
                  bgColor={bgColor}
                  accentColor={accentColor}
                  borderColor={borderColor}
                  sizePx={theaterMode ? 68 : 54}
                />
              </div>

              {badgeText && (
                <span
                  className="px-2 py-0.5 rounded-full font-mono text-[9px] font-semibold uppercase tracking-wider border max-w-[180px] truncate"
                  style={{
                    backgroundColor: `${badgeColor}24`,
                    borderColor: `${badgeColor}70`,
                    color: textColor,
                  }}
                >
                  {badgeText}
                </span>
              )}

              {(statusEmoji || statusText) && (
                <div className="px-2 py-0.5 rounded-full bg-[#09090B]/65 border border-white/[0.08] text-[10px] text-[#E4E4E7] max-w-[210px] truncate flex items-center gap-1">
                  {statusEmoji && <span>{statusEmoji}</span>}
                  {statusText && <span className="truncate">{statusText}</span>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Topo do Card: Nome + Ícone/Tag AO VIVO no canto superior esquerdo (quando transmitindo) */}
      <div className="relative z-10 p-2.5 sm:p-3 flex items-center justify-between gap-2 pointer-events-none">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          <span
            className="px-2 py-0.5 rounded-md bg-[#09090B]/85 hairline-box text-xs font-medium truncate max-w-[180px]"
            style={{ color: remoteVideoTrack ? "#FAFAFA" : textColor }}
          >
            {peer.display_name}
            {isSelf ? " (você)" : ""}
          </span>
          {isStreaming && (
            <span
              className="px-2 py-0.5 rounded-full bg-[#7F1D1D]/95 border border-[#EF4444] text-[10px] font-mono font-semibold tracking-wider text-[#FAFAFA] flex items-center gap-1.5 shadow-sm shrink-0"
              title="Transmitindo tela ao vivo"
            >
              <MonitorUp className="w-3 h-3 text-[#FCA5A5] shrink-0" strokeWidth={1.75} />
              <span className="w-1.5 h-1.5 rounded-full bg-[#EF4444] animate-ping" />
              <span>{scrambledLive}</span>
            </span>
          )}
          {peer.reconnecting && (
            <span className="px-1.5 py-0.5 rounded bg-[#1E1E26] text-[#F87171] font-mono text-[10px]">
              RECONECTANDO
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {peer.muted && (
            <span className="p-1 rounded-md bg-[#1E1E26]/95 text-[#F87171]">
              <MicOff className="w-3.5 h-3.5" strokeWidth={1.5} />
            </span>
          )}
          {peer.deafened && (
            <span className="p-1 rounded-md bg-[#1E1E26]/95 text-[#F87171]">
              <HeadphoneOff className="w-3.5 h-3.5" strokeWidth={1.5} />
            </span>
          )}
        </div>
      </div>

      {/* Rodapé Flutuante em Vidro Cirúrgico (Scoped Glass Embutido) */}
      <div
        className="relative z-10 p-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-150"
        onDoubleClick={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
      >
        <div className="scoped-glass rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onTogglePin}
              className="min-h-[32px] flex items-center gap-1.5 text-[11px] font-medium text-[#FAFAFA] hover:text-[#EF4444] transition-colors"
            >
              {isPinned ? (
                <>
                  <PinOff className="w-3.5 h-3.5" strokeWidth={1.5} />
                  <span>Desafixar</span>
                </>
              ) : (
                <>
                  <Pin className="w-3.5 h-3.5" strokeWidth={1.5} />
                  <span>Fixar</span>
                </>
              )}
            </button>

            <button
              type="button"
              onClick={toggleFullscreen}
              className="min-h-[32px] flex items-center gap-1.5 text-[11px] font-medium text-[#FAFAFA] hover:text-[#EF4444] transition-colors"
              aria-label={isFullscreen ? "Sair da Tela Cheia" : "Tela Cheia"}
              title={isFullscreen ? "Sair da Tela Cheia" : "Tela Cheia"}
            >
              {isFullscreen ? (
                <>
                  <Minimize2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                  <span>Sair</span>
                </>
              ) : (
                <>
                  <Maximize2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                  <span>Tela Cheia</span>
                </>
              )}
            </button>
          </div>

          {!isSelf && (
            <div className="flex items-center gap-4 flex-1 justify-end min-w-[180px]">
              {/* Volume de Voz */}
              <div className="flex items-center gap-2 w-32">
                <Volume2
                  className="w-3.5 h-3.5 text-[#A1A1AA] shrink-0"
                  strokeWidth={1.5}
                />
                <Slider.Root
                  className="relative flex items-center select-none touch-none w-full h-4"
                  value={[userVolume]}
                  min={0}
                  max={200}
                  step={1}
                  onValueChange={(v) => onUserVolumeChange(v[0] ?? 100)}
                >
                  <Slider.Track className="bg-black/60 relative grow rounded-full h-1">
                    <Slider.Range className="absolute bg-[#B91C1C] rounded-full h-full" />
                  </Slider.Track>
                  <Slider.Thumb
                    className="block w-3 h-3 bg-[#FAFAFA] border border-[#B91C1C] rounded-full focus:outline-none"
                    aria-label="Volume de voz"
                  />
                </Slider.Root>
                <span className="font-mono text-[10px] text-[#FAFAFA] w-8 text-right">
                  {userVolume}%
                </span>
              </div>

              {/* Volume da Stream (se houver áudio isolado) */}
              {screen?.has_audio && (
                <div className="flex items-center gap-2 w-32">
                  <MonitorUp
                    className="w-3.5 h-3.5 text-[#EF4444] shrink-0"
                    strokeWidth={1.5}
                  />
                  <Slider.Root
                    className="relative flex items-center select-none touch-none w-full h-4"
                    value={[streamVolume]}
                    min={0}
                    max={200}
                    step={1}
                    onValueChange={(v) => onStreamVolumeChange(v[0] ?? 100)}
                  >
                    <Slider.Track className="bg-black/60 relative grow rounded-full h-1">
                      <Slider.Range className="absolute bg-[#EF4444] rounded-full h-full" />
                    </Slider.Track>
                    <Slider.Thumb
                      className="block w-3 h-3 bg-[#FAFAFA] border border-[#EF4444] rounded-full focus:outline-none"
                      aria-label="Volume da transmissão"
                    />
                  </Slider.Root>
                  <span className="font-mono text-[10px] text-[#FAFAFA] w-8 text-right">
                    {streamVolume}%
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
