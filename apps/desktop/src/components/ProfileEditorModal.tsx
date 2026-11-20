import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Slider from "@radix-ui/react-slider";
import * as Tabs from "@radix-ui/react-tabs";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import {
  usePresenceStore,
  useProfileEditor,
  type AvatarFrameStyle,
  type ProfileCardTheme,
} from "@cafofo/core-logic";
import {
  Check,
  ImagePlus,
  LogOut,
  Music,
  Palette,
  Play,
  Power,
  RefreshCw,
  Scissors,
  Sparkles,
  Square,
  Sticker,
  UserCheck,
  Volume2,
  X,
} from "lucide-react";
import {
  playVoiceJoinSound,
  useSystemSoundVolume,
} from "../lib/soundEffects";
import { isTauriRuntime, playEntrySound } from "../lib/tauri";
import type { AppUpdaterState } from "../lib/updater";
import { AudioTrimmerModal } from "./AudioTrimmerModal";
import { ImageCropperModal } from "./ImageCropperModal";
import { Modal } from "./Modal";
import {
  AvatarWithFrame,
  getCardThemeOverlayClass,
  ProfileCardPreview,
} from "./ProfileCardPreview";

interface ProfileEditorModalProps {
  onClose: () => void;
  onSignOut?: () => Promise<void> | void;
  updater?: AppUpdaterState;
}

const COLOR_FIELDS = [
  ["banner_color", "Cor do Banner", "#7F1D1D"],
  ["card_bg_color", "Fundo do Cartão", "#101014"],
  ["card_accent_color", "Acento Principal", "#B91C1C"],
  ["card_text_color", "Tipografia Principal", "#FAFAFA"],
  ["card_border_color", "Contorno do Cartão", "#27272A"],
  ["custom_badge_color", "Cor do Sticker", "#B91C1C"],
] as const;

const STICKER_PRESETS = [
  "DONO DO CAFOFO",
  "STREAMER 60FPS",
  "TRYHARD",
  "NIGHT OWL",
] as const;

const AVATAR_FRAME_OPTIONS: Array<{
  id: AvatarFrameStyle;
  label: string;
}> = [
  { id: "none", label: "Padrão" },
  { id: "crimson-pulse", label: "Pulso Carmesim" },
  { id: "cyber-cut", label: "Corte Cyber" },
  { id: "double-neon", label: "Duplo Neon" },
];

const CARD_THEME_OPTIONS: Array<{
  id: ProfileCardTheme;
  label: string;
  subtitle: string;
}> = [
  { id: "default", label: "Obsidiana", subtitle: "Fosco limpo" },
  { id: "obsidian-glass", label: "Vidro Escuro", subtitle: "Reflexo sutil" },
  { id: "liquid-water", label: "Água Líquida", subtitle: "Fluxo aqua" },
  { id: "crimson-fire", label: "Brasa Rubi", subtitle: "Fogo vivo" },
  { id: "cyber-hologram", label: "Holograma", subtitle: "Prisma CRT" },
  { id: "neon-grid", label: "Grade Neon", subtitle: "Malha cyber" },
];

const PALETTE_PRESETS = [
  {
    name: "Obsidian Crimson",
    banner_color: "#7F1D1D",
    card_bg_color: "#101014",
    card_accent_color: "#B91C1C",
    card_text_color: "#FAFAFA",
    card_border_color: "#27272A",
    custom_badge_color: "#B91C1C",
    banner_gradient:
      "radial-gradient(circle at 20% 20%, rgba(185, 28, 28, 0.55) 0%, transparent 65%), linear-gradient(135deg, #450A0A 0%, #09090B 100%)",
  },
  {
    name: "Netrunner Cyan",
    banner_color: "#0E7490",
    card_bg_color: "#0B1117",
    card_accent_color: "#06B6D4",
    card_text_color: "#ECFEFF",
    card_border_color: "#164E63",
    custom_badge_color: "#0891B2",
    banner_gradient:
      "radial-gradient(circle at 20% 25%, rgba(6, 182, 212, 0.45) 0%, transparent 65%), linear-gradient(135deg, #083344 0%, #09090B 100%)",
  },
  {
    name: "Phantom Violet",
    banner_color: "#581C87",
    card_bg_color: "#110D1A",
    card_accent_color: "#9333EA",
    card_text_color: "#FAF5FF",
    card_border_color: "#3B0764",
    custom_badge_color: "#7E22CE",
    banner_gradient:
      "radial-gradient(circle at 25% 20%, rgba(147, 51, 234, 0.5) 0%, transparent 65%), linear-gradient(135deg, #3B0764 0%, #09090B 100%)",
  },
  {
    name: "Stealth Mono",
    banner_color: "#27272A",
    card_bg_color: "#09090B",
    card_accent_color: "#52525B",
    card_text_color: "#FAFAFA",
    card_border_color: "#27272A",
    custom_badge_color: "#3F3F46",
    banner_gradient:
      "radial-gradient(circle at 25% 20%, rgba(255, 255, 255, 0.12) 0%, transparent 65%), linear-gradient(135deg, #18181B 0%, #09090B 100%)",
  },
] as const;

const BANNER_GRADIENT_OPTIONS: Array<{
  label: string;
  value: string | null;
  preview: string;
}> = [
  {
    label: "Sólido",
    value: null,
    preview: "linear-gradient(135deg, #18181B 0%, #09090B 100%)",
  },
  {
    label: "Rubi Brasa",
    value:
      "radial-gradient(circle at 20% 20%, rgba(185, 28, 28, 0.55) 0%, transparent 65%), linear-gradient(135deg, #450A0A 0%, #09090B 100%)",
    preview: "linear-gradient(135deg, #991B1B 0%, #09090B 100%)",
  },
  {
    label: "Ciano Cyber",
    value:
      "radial-gradient(circle at 20% 25%, rgba(6, 182, 212, 0.45) 0%, transparent 65%), linear-gradient(135deg, #083344 0%, #09090B 100%)",
    preview: "linear-gradient(135deg, #0891B2 0%, #09090B 100%)",
  },
  {
    label: "Violeta Neon",
    value:
      "radial-gradient(circle at 25% 20%, rgba(147, 51, 234, 0.5) 0%, transparent 65%), linear-gradient(135deg, #3B0764 0%, #09090B 100%)",
    preview: "linear-gradient(135deg, #7E22CE 0%, #09090B 100%)",
  },
  {
    label: "Grafite Fosco",
    value:
      "radial-gradient(circle at 25% 20%, rgba(255, 255, 255, 0.12) 0%, transparent 65%), linear-gradient(135deg, #18181B 0%, #09090B 100%)",
    preview: "linear-gradient(135deg, #3F3F46 0%, #09090B 100%)",
  },
];

export function ProfileEditorModal({
  onClose,
  onSignOut,
  updater,
}: ProfileEditorModalProps) {
  const {
    profile,
    draft,
    saving,
    uploadingBucket,
    error,
    setField,
    save,
    uploadAvatar,
    uploadBanner,
    uploadEntrySound,
  } = useProfileEditor();

  const currentGame = usePresenceStore((s) => s.currentGame);
  const [systemSoundVolume, setSystemSoundVolume] = useSystemSoundVolume();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlayingSound, setIsPlayingSound] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [pendingBannerFile, setPendingBannerFile] = useState<File | null>(null);
  const [pendingAudioFile, setPendingAudioFile] = useState<File | null>(null);
  const [signOutConfirmOpen, setSignOutConfirmOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [autostartOn, setAutostartOn] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    void isAutostartEnabled()
      .then((enabled) => setAutostartOn(enabled))
      .catch(() => setAutostartOn(null));
  }, []);

  const handleToggleAutostart = async () => {
    if (!isTauriRuntime() || autostartBusy || autostartOn === null) return;
    setAutostartBusy(true);
    try {
      if (autostartOn) {
        await disableAutostart();
        setAutostartOn(false);
      } else {
        await enableAutostart();
        setAutostartOn(true);
      }
    } catch {
      // Mantém estado atual em caso de erro de permissão
    } finally {
      setAutostartBusy(false);
    }
  };

  const stopPreviewSound = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setIsPlayingSound(false);
  };

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = Math.max(
        0,
        Math.min(1, draft.entry_sound_volume),
      );
    }
  }, [draft.entry_sound_volume]);

  const handleTogglePreviewSound = async () => {
    if (isPlayingSound) {
      stopPreviewSound();
      return;
    }
    if (!profile?.entry_sound_url) return;

    try {
      const audio = new Audio(profile.entry_sound_url);
      audio.volume = Math.max(0, Math.min(1, draft.entry_sound_volume));
      audio.onended = () => {
        audioRef.current = null;
        setIsPlayingSound(false);
      };
      audioRef.current = audio;
      setIsPlayingSound(true);
      await audio.play();
    } catch {
      audioRef.current = null;
      setIsPlayingSound(false);
      if (isTauriRuntime()) {
        await playEntrySound(profile.entry_sound_url, draft.entry_sound_volume);
      }
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    await save();
    setSavedToast(true);
    setTimeout(() => setSavedToast(false), 2400);
  };

  const applyPalettePreset = (preset: (typeof PALETTE_PRESETS)[number]) => {
    setField("banner_color", preset.banner_color);
    setField("card_bg_color", preset.card_bg_color);
    setField("card_accent_color", preset.card_accent_color);
    setField("card_text_color", preset.card_text_color);
    setField("card_border_color", preset.card_border_color);
    setField("custom_badge_color", preset.custom_badge_color);
    setField("banner_gradient", preset.banner_gradient);
  };

  const initials = (draft.display_name || profile?.username || "CF")
    .slice(0, 2)
    .toUpperCase();
  const liveAccent = draft.card_accent_color || "#B91C1C";

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) {
          stopPreviewSound();
          onClose();
        }
      }}
      overlayZIndexClass="z-[70]"
      contentClassName="w-[95vw] max-w-4xl rounded-2xl bg-[#09090B] hairline-box shadow-2xl overflow-y-auto lg:overflow-hidden flex flex-col lg:flex-row lg:h-[min(88dvh,760px)] max-h-[90dvh]"
    >
      {/* Metade Esquerda: Vitrine Luminosa + Preview ao Vivo com Reflexo Dinâmico */}
      <div className="ruby-refraction-canvas hairline-r p-4 sm:p-6 xl:p-7 flex flex-col justify-between relative min-h-0 lg:w-[46%] lg:shrink-0 lg:overflow-y-auto overflow-hidden">
        <div
          className="absolute -top-20 -left-20 w-72 h-72 rounded-full pointer-events-none transition-all duration-300 animate-cyber-pulse"
          style={{
            background: `radial-gradient(circle, ${liveAccent}45 0%, transparent 70%)`,
          }}
        />
        <div className="absolute inset-0 architectural-grid-overlay pointer-events-none opacity-60" />

        <div className="relative z-10 flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#EF4444]" strokeWidth={1.5} />
            <span className="text-xs font-mono uppercase tracking-wider text-[#FAFAFA]">
              PREVIEW AO VIVO DO PERFIL
            </span>
          </div>
          <span className="px-2 py-0.5 rounded-full bg-[#7F1D1D] border border-[#EF4444] font-mono text-[10px] text-[#FAFAFA] flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            SYNC TEMPO REAL
          </span>
        </div>

        <div
          className="relative z-10 my-auto max-w-sm mx-auto w-full rounded-xl transition-all duration-300"
          style={{
            boxShadow: `0 0 38px ${liveAccent}33`,
          }}
        >
          <ProfileCardPreview
            data={{
              username: profile?.username || "cafofo",
              displayName: draft.display_name || "Seu Nome",
              bio: draft.bio,
              avatarUrl: profile?.avatar_url,
              bannerUrl: profile?.banner_url,
              bannerColor: draft.banner_color,
              bannerGradient: draft.banner_gradient,
              cardBgColor: draft.card_bg_color,
              cardAccentColor: draft.card_accent_color,
              cardTextColor: draft.card_text_color,
              cardBorderColor: draft.card_border_color,
              customStatusEmoji: draft.custom_status_emoji,
              customStatusText: draft.custom_status_text,
              customBadgeText: draft.custom_badge_text,
              customBadgeColor: draft.custom_badge_color,
              avatarFrame: draft.avatar_frame,
              cardTheme: draft.card_theme,
              role: "owner",
              onlineStatus: "online",
              activeGameName:
                currentGame?.game_name || "Counter-Strike 2 (Demo)",
              activeGameElapsed: "01:24:10",
              entrySoundUrl: profile?.entry_sound_url,
            }}
            onTestEntrySound={
              profile?.entry_sound_url
                ? () => void handleTogglePreviewSound()
                : undefined
            }
            isPlayingSound={isPlayingSound}
          />
        </div>

        <div className="relative z-10 mt-6 text-[11px] font-mono text-[#A1A1AA] text-center">
          Moldura, sticker, cores e som de entrada sincronizam com todo o grupo.
        </div>
      </div>

          {/* Metade Direita: Editor Sólido em Abas Radix (#09090B / #101014) */}
          <div className="bg-[#09090B] p-4 sm:p-6 xl:p-7 flex flex-col min-h-0 flex-1 lg:w-[54%] lg:overflow-hidden">
            <div className="flex items-center justify-between shrink-0 mb-4">
              <div>
                <Dialog.Title className="text-base font-semibold text-[#FAFAFA]">
                  Identidade Cafofo
                </Dialog.Title>
                <Dialog.Description className="text-xs text-[#A1A1AA]">
                  Personalize sticker, moldura do avatar, paleta e som de entrada
                </Dialog.Description>
              </div>

              <Dialog.Close asChild>
                <button
                  type="button"
                  className="min-h-[38px] min-w-[38px] p-1.5 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center justify-center shrink-0"
                >
                  <X className="w-4 h-4" strokeWidth={1.5} />
                </button>
              </Dialog.Close>
            </div>

            <form
              onSubmit={handleSubmit}
              className="flex flex-col flex-1 min-h-0"
            >
              <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-4">
                <Tabs.Root defaultValue="identity" className="space-y-4">
                  <Tabs.List className="grid grid-cols-3 p-1 rounded-xl bg-[#101014] hairline-box text-xs font-medium">
                    <Tabs.Trigger
                      value="identity"
                      className="min-h-[36px] py-1.5 rounded-lg flex items-center justify-center gap-1.5 data-[state=active]:bg-[#16161C] data-[state=active]:text-[#FAFAFA] text-[#A1A1AA]"
                    >
                      <UserCheck className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span>Perfil</span>
                    </Tabs.Trigger>
                    <Tabs.Trigger
                      value="colors"
                      className="min-h-[36px] py-1.5 rounded-lg flex items-center justify-center gap-1.5 data-[state=active]:bg-[#16161C] data-[state=active]:text-[#FAFAFA] text-[#A1A1AA]"
                    >
                      <Palette className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span>Cores</span>
                    </Tabs.Trigger>
                    <Tabs.Trigger
                      value="media"
                      className="min-h-[36px] py-1.5 rounded-lg flex items-center justify-center gap-1.5 data-[state=active]:bg-[#16161C] data-[state=active]:text-[#FAFAFA] text-[#A1A1AA]"
                    >
                      <Music className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span>Mídia & Som</span>
                    </Tabs.Trigger>
                  </Tabs.List>

                  {/* Aba 1: Perfil, Sticker Customizável & Moldura de Avatar */}
                  <Tabs.Content
                    value="identity"
                    className="space-y-4 focus:outline-none text-xs"
                  >
                    <label className="block space-y-1.5">
                      <span className="text-[#A1A1AA] font-medium">
                        Nome de Exibição
                      </span>
                      <input
                        type="text"
                        required
                        value={draft.display_name}
                        onChange={(e) =>
                          setField("display_name", e.target.value)
                        }
                        className="w-full px-3 py-2 rounded-xl bg-[#101014] hairline-box text-sm text-[#FAFAFA] focus:outline-none focus:border-[#B91C1C]"
                      />
                    </label>

                    <div className="grid grid-cols-3 gap-2.5">
                      <label className="block space-y-1.5">
                        <span className="text-[#A1A1AA] font-medium">
                          Emoji
                        </span>
                        <input
                          type="text"
                          value={draft.custom_status_emoji ?? ""}
                          onChange={(e) =>
                            setField("custom_status_emoji", e.target.value)
                          }
                          placeholder="🔥"
                          className="w-full px-3 py-2 rounded-xl bg-[#101014] hairline-box text-sm text-[#FAFAFA] focus:outline-none focus:border-[#B91C1C]"
                        />
                      </label>
                      <label className="col-span-2 block space-y-1.5">
                        <span className="text-[#A1A1AA] font-medium">
                          Status Customizado
                        </span>
                        <input
                          type="text"
                          value={draft.custom_status_text ?? ""}
                          onChange={(e) =>
                            setField("custom_status_text", e.target.value)
                          }
                          placeholder="Na call do Cafofo"
                          className="w-full px-3 py-2 rounded-xl bg-[#101014] hairline-box text-sm text-[#FAFAFA] focus:outline-none focus:border-[#B91C1C]"
                        />
                      </label>
                    </div>

                    <label className="block space-y-1.5">
                      <span className="text-[#A1A1AA] font-medium">
                        Bio / Sobre Você
                      </span>
                      <textarea
                        rows={2}
                        value={draft.bio ?? ""}
                        onChange={(e) => setField("bio", e.target.value)}
                        placeholder="Conte um pouco sobre você ou seu setup..."
                        className="w-full px-3 py-2 rounded-xl bg-[#101014] hairline-box text-xs text-[#FAFAFA] focus:outline-none focus:border-[#B91C1C] resize-none"
                      />
                    </label>

                    {/* Sticker Customizável */}
                    <div className="p-3 rounded-xl bg-[#101014] hairline-box space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-[#FAFAFA] flex items-center gap-1.5">
                          <Sticker
                            className="w-3.5 h-3.5 text-[#EF4444]"
                            strokeWidth={1.5}
                          />
                          Sticker Customizável
                        </span>
                        <span className="font-mono text-[10px] text-[#71717A]">
                          {(draft.custom_badge_text ?? "").length}/24
                        </span>
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          maxLength={24}
                          value={draft.custom_badge_text ?? ""}
                          onChange={(e) =>
                            setField("custom_badge_text", e.target.value)
                          }
                          placeholder="Ex: DONO DO CAFOFO"
                          className="flex-1 px-3 py-2 rounded-lg bg-[#09090B] hairline-box text-xs text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
                        />
                        <input
                          type="color"
                          value={
                            draft.custom_badge_color ||
                            draft.card_accent_color ||
                            "#B91C1C"
                          }
                          onChange={(e) =>
                            setField("custom_badge_color", e.target.value)
                          }
                          className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 shrink-0"
                          title="Cor do sticker"
                        />
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {STICKER_PRESETS.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setField("custom_badge_text", preset)}
                            className={`px-2 py-1 rounded-md font-mono text-[10px] transition-colors ${
                              draft.custom_badge_text === preset
                                ? "bg-[#B91C1C] text-[#FAFAFA]"
                                : "bg-[#16161C] hover:bg-[#1E1E26] text-[#A1A1AA] hairline-box"
                            }`}
                          >
                            {preset}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Seletor Visual de Moldura do Avatar */}
                    <div className="space-y-2">
                      <span className="text-[#A1A1AA] font-medium block">
                        Moldura do Avatar
                      </span>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        {AVATAR_FRAME_OPTIONS.map((opt) => {
                          const selected = draft.avatar_frame === opt.id;
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => setField("avatar_frame", opt.id)}
                              className={`p-2.5 rounded-xl flex flex-col items-center gap-2 transition-colors ${
                                selected
                                  ? "bg-[#16161C] border border-[#B91C1C] text-[#FAFAFA]"
                                  : "bg-[#101014] hover:bg-[#16161C] hairline-box text-[#A1A1AA]"
                              }`}
                            >
                              <AvatarWithFrame
                                avatarUrl={profile?.avatar_url}
                                initials={initials}
                                frame={opt.id}
                                bgColor={draft.card_bg_color || "#101014"}
                                accentColor={
                                  draft.card_accent_color || "#B91C1C"
                                }
                                borderColor={
                                  draft.card_border_color || "#27272A"
                                }
                                sizePx={38}
                              />
                              <span className="text-[11px] font-medium text-center leading-tight">
                                {opt.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </Tabs.Content>

                  {/* Aba 2: Presets de Paleta, Gradiente de Banner & Cores */}
                  <Tabs.Content
                    value="colors"
                    className="space-y-4 focus:outline-none text-xs"
                  >
                    {/* Modelos de Cartão Animados & Texturizados */}
                    <div className="space-y-2">
                      <span className="text-[#A1A1AA] font-medium block">
                        Modelo & Textura Animada do Cartão
                      </span>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {CARD_THEME_OPTIONS.map((opt) => {
                          const selected = draft.card_theme === opt.id;
                          const overlayCls = getCardThemeOverlayClass(opt.id);
                          return (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => setField("card_theme", opt.id)}
                              className={`p-2 rounded-xl text-left space-y-1.5 transition-colors ${
                                selected
                                  ? "bg-[#16161C] border border-[#B91C1C] text-[#FAFAFA]"
                                  : "bg-[#101014] hover:bg-[#16161C] hairline-box text-[#A1A1AA]"
                              }`}
                            >
                              <div
                                className="relative h-9 w-full rounded-lg overflow-hidden hairline-box"
                                style={
                                  {
                                    backgroundColor: "#111118",
                                    "--card-accent": liveAccent,
                                  } as CSSProperties
                                }
                              >
                                {overlayCls ? (
                                  <div
                                    className={`card-theme-overlay ${overlayCls}`}
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <div
                                    className="absolute inset-0 bg-gradient-to-br from-white/[0.06] via-transparent to-black/40"
                                    aria-hidden="true"
                                  />
                                )}
                              </div>
                              <div>
                                <span className="block text-[11px] font-medium text-[#FAFAFA] truncate leading-tight">
                                  {opt.label}
                                </span>
                                <span className="block text-[9px] font-mono text-[#71717A] truncate">
                                  {opt.subtitle}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <span className="text-[#A1A1AA] font-medium block">
                        Presets de Paleta (1 clique)
                      </span>
                      <div className="grid grid-cols-2 gap-2">
                        {PALETTE_PRESETS.map((preset) => (
                          <button
                            key={preset.name}
                            type="button"
                            onClick={() => applyPalettePreset(preset)}
                            className="p-2.5 rounded-xl bg-[#101014] hover:bg-[#16161C] hairline-box flex items-center justify-between gap-2 text-left transition-colors"
                          >
                            <span className="font-medium text-[#FAFAFA] truncate">
                              {preset.name}
                            </span>
                            <span className="flex items-center gap-1 shrink-0">
                              <span
                                className="w-3 h-3 rounded-full border border-white/20"
                                style={{ backgroundColor: preset.card_bg_color }}
                              />
                              <span
                                className="w-3 h-3 rounded-full border border-white/20"
                                style={{
                                  backgroundColor: preset.card_accent_color,
                                }}
                              />
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Gradiente de Banner */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[#A1A1AA] font-medium">
                          Gradiente do Banner (sem imagem)
                        </span>
                        {profile?.banner_url && (
                          <span className="text-[10px] font-mono text-[#71717A]">
                            Imagem ativa no banner
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                        {BANNER_GRADIENT_OPTIONS.map((g) => {
                          const active = (draft.banner_gradient ?? null) === g.value;
                          return (
                            <button
                              key={g.label}
                              type="button"
                              onClick={() => setField("banner_gradient", g.value)}
                              className={`p-1.5 rounded-xl text-center space-y-1 transition-colors ${
                                active
                                  ? "bg-[#16161C] border border-[#B91C1C] text-[#FAFAFA]"
                                  : "bg-[#101014] hairline-box text-[#A1A1AA]"
                              }`}
                            >
                              <div
                                className="h-6 w-full rounded-lg hairline-box"
                                style={{ backgroundImage: g.preview }}
                              />
                              <span className="block text-[10px] truncate">
                                {g.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {COLOR_FIELDS.map(([fieldKey, label, fallback]) => (
                        <label
                          key={fieldKey}
                          className="p-2.5 rounded-xl bg-[#101014] hairline-box space-y-1.5"
                        >
                          <span className="block text-[11px] text-[#A1A1AA]">
                            {label}
                          </span>
                          <div className="flex items-center gap-2">
                            <input
                              type="color"
                              value={draft[fieldKey] || fallback}
                              onChange={(e) =>
                                setField(fieldKey, e.target.value)
                              }
                              className="w-7 h-7 rounded cursor-pointer bg-transparent border-0"
                            />
                            <input
                              type="text"
                              value={draft[fieldKey] ?? ""}
                              onChange={(e) =>
                                setField(fieldKey, e.target.value)
                              }
                              className="w-full px-2 py-1 rounded-lg bg-[#09090B] hairline-box font-mono text-xs text-[#FAFAFA] focus:outline-none focus:border-[#B91C1C]"
                            />
                          </div>
                        </label>
                      ))}
                    </div>
                  </Tabs.Content>

                  {/* Aba 3: Upload de Avatar, Banner e Preview Play/Stop do Som de Entrada */}
                  <Tabs.Content
                    value="media"
                    className="space-y-3.5 focus:outline-none text-xs"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="p-3 rounded-xl bg-[#101014] hover:bg-[#16161C] hairline-box cursor-pointer transition-colors space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-[#FAFAFA] flex items-center gap-1.5">
                            <ImagePlus
                              className="w-3.5 h-3.5 text-[#EF4444]"
                              strokeWidth={1.5}
                            />
                            Avatar
                          </span>
                          <span className="font-mono text-[10px] text-[#71717A]">
                            MÁX 2MB
                          </span>
                        </div>
                        <p className="text-[11px] text-[#A1A1AA]">
                          {uploadingBucket === "avatars"
                            ? "Enviando avatar..."
                            : "Com recorte e zoom 1:1"}
                        </p>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) setPendingAvatarFile(f);
                            e.target.value = "";
                          }}
                        />
                      </label>

                      <label className="p-3 rounded-xl bg-[#101014] hover:bg-[#16161C] hairline-box cursor-pointer transition-colors space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-[#FAFAFA] flex items-center gap-1.5">
                            <ImagePlus
                              className="w-3.5 h-3.5 text-[#EF4444]"
                              strokeWidth={1.5}
                            />
                            Banner Superior
                          </span>
                          <span className="font-mono text-[10px] text-[#71717A]">
                            MÁX 5MB
                          </span>
                        </div>
                        <p className="text-[11px] text-[#A1A1AA]">
                          {uploadingBucket === "banners"
                            ? "Enviando banner..."
                            : "Com recorte e zoom 3:1"}
                        </p>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) setPendingBannerFile(f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </div>

                    {/* Som de Entrada na Call + Preview Play/Stop */}
                    <div className="p-3.5 rounded-xl bg-[#101014] hairline-box space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="font-medium text-[#FAFAFA] flex items-center gap-1.5">
                            <Music
                              className="w-3.5 h-3.5 text-[#EF4444]"
                              strokeWidth={1.5}
                            />
                            Som de Entrada na Sala de Voz
                          </div>
                          <div className="text-[11px] text-[#71717A]">
                            Escolha qualquer música ou áudio e recorte até 3s na tesoura integrada
                          </div>
                        </div>
                        <label className="min-h-[36px] px-2.5 py-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-xs text-[#FAFAFA] cursor-pointer shrink-0 flex items-center gap-1.5">
                          <Scissors className="w-3.5 h-3.5 text-[#EF4444]" strokeWidth={1.5} />
                          <span>
                            {uploadingBucket === "entrance-sounds"
                              ? "Enviando..."
                              : "Recortar Áudio"}
                          </span>
                          <input
                            type="file"
                            accept="audio/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) setPendingAudioFile(f);
                              e.target.value = "";
                            }}
                          />
                        </label>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-[#A1A1AA] flex items-center gap-1.5">
                            <Volume2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                            Volume do Som de Entrada
                          </span>
                          <span className="font-mono text-[#FAFAFA]">
                            {Math.round(draft.entry_sound_volume * 100)}%
                          </span>
                        </div>

                        <div className="flex items-center gap-3">
                          <Slider.Root
                            className="relative flex items-center select-none touch-none flex-1 h-5"
                            value={[Math.round(draft.entry_sound_volume * 100)]}
                            min={0}
                            max={100}
                            step={5}
                            onValueChange={(vals) =>
                              setField(
                                "entry_sound_volume",
                                (vals[0] ?? 80) / 100,
                              )
                            }
                          >
                            <Slider.Track className="bg-[#09090B] relative grow rounded-full h-1.5 hairline-box">
                              <Slider.Range className="absolute bg-[#B91C1C] rounded-full h-full" />
                            </Slider.Track>
                            <Slider.Thumb
                              className="block w-4 h-4 bg-[#FAFAFA] border border-[#B91C1C] rounded-full focus:outline-none"
                              aria-label="Volume do som de entrada"
                            />
                          </Slider.Root>

                          <button
                            type="button"
                            disabled={!profile?.entry_sound_url}
                            onClick={() => void handleTogglePreviewSound()}
                            className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors shrink-0 disabled:opacity-40 ${
                              isPlayingSound
                                ? "btn-non-destructive-active"
                                : "bg-[#B91C1C] hover:bg-[#991B1B] text-[#FAFAFA]"
                            }`}
                          >
                            {isPlayingSound ? (
                              <>
                                <Square className="w-3 h-3 fill-current" strokeWidth={1.5} />
                                <span>Parar</span>
                              </>
                            ) : (
                              <>
                                <Play className="w-3 h-3 fill-current" strokeWidth={1.5} />
                                <span>Testar</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Volume de Áudio de Sistema (Bipes de Radar Join/Leave/Mute) */}
                    <div className="p-3.5 rounded-xl bg-[#101014] hairline-box space-y-2.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <div>
                          <span className="font-medium text-[#FAFAFA] flex items-center gap-1.5">
                            <Volume2
                              className="w-3.5 h-3.5 text-[#EF4444]"
                              strokeWidth={1.5}
                            />
                            Áudio de Sistema (Join / Leave / Mute)
                          </span>
                          <span className="text-[11px] text-[#71717A] block mt-0.5">
                            Volume dos bipes sintetizados de radar ao entrar/sair da call
                          </span>
                        </div>
                        <span className="font-mono text-[#FAFAFA]">
                          {systemSoundVolume}%
                        </span>
                      </div>

                      <div className="flex items-center gap-3">
                        <Slider.Root
                          className="relative flex items-center select-none touch-none flex-1 h-5"
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
                            className="block w-4 h-4 bg-[#FAFAFA] border border-[#B91C1C] rounded-full focus:outline-none"
                            aria-label="Volume de áudio do sistema"
                          />
                        </Slider.Root>

                        <button
                          type="button"
                          onClick={() => playVoiceJoinSound()}
                          className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-xs font-medium text-[#FAFAFA] flex items-center gap-1.5 transition-colors shrink-0"
                        >
                          <Play
                            className="w-3 h-3 text-[#EF4444] fill-current"
                            strokeWidth={1.5}
                          />
                          <span>Testar Bipe</span>
                        </button>
                      </div>
                    </div>
                  </Tabs.Content>
                </Tabs.Root>

                {savedToast && (
                  <div className="px-3.5 py-2 rounded-full bg-[#7F1D1D]/90 border border-[#EF4444] text-xs font-mono text-[#FAFAFA] flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(185,28,28,0.35)] animate-cyber-slide">
                    <Check className="w-3.5 h-3.5 text-emerald-400" strokeWidth={1.75} />
                    <span>Identidade sincronizada com sucesso</span>
                  </div>
                )}

                {error && (
                  <div className="p-2.5 rounded-xl bg-[#1E1E26] border border-[#F87171]/30 text-xs text-[#F87171]">
                    {error}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-3 mt-3 hairline-t shrink-0 bg-[#09090B]">
                <div className="flex flex-wrap items-center gap-2">
                  {onSignOut && (
                    <button
                      type="button"
                      onClick={() => setSignOutConfirmOpen(true)}
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#16161C] hover:bg-[#1E1E26] border border-[#F87171]/25 text-xs text-[#F87171] flex items-center gap-1.5 transition-colors"
                      title="Sair da sua conta Cafofo"
                    >
                      <LogOut className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span>Encerrar Sessão</span>
                    </button>
                  )}

                  {updater?.supported && (
                    <button
                      type="button"
                      disabled={
                        updater.status === "checking" ||
                        updater.status === "downloading" ||
                        updater.status === "installing"
                      }
                      onClick={() =>
                        void updater.checkForUpdates({ silent: false })
                      }
                      className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA] disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                      title={
                        updater.error
                          ? updater.error
                          : "Verificar atualizações do aplicativo desktop"
                      }
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${
                          updater.status === "checking"
                            ? "animate-spin text-[#EF4444]"
                            : updater.status === "available"
                              ? "text-[#EF4444]"
                              : updater.status === "up-to-date"
                                ? "text-emerald-400"
                                : ""
                        }`}
                        strokeWidth={1.5}
                      />
                      <span className="font-mono text-[11px]">
                        {updater.status === "checking"
                          ? "Verificando..."
                          : updater.status === "available" &&
                              updater.availableVersion
                            ? `v${updater.availableVersion} disponível`
                            : updater.status === "up-to-date"
                              ? "Atualizado"
                              : updater.status === "error"
                                ? "Tentar novamente"
                                : "Verificar atualizações"}
                      </span>
                    </button>
                  )}

                  {isTauriRuntime() && autostartOn !== null && (
                    <button
                      type="button"
                      disabled={autostartBusy}
                      onClick={() => void handleToggleAutostart()}
                      className={`min-h-[38px] px-3 py-1.5 rounded-xl border text-xs flex items-center gap-1.5 transition-colors disabled:opacity-50 ${
                        autostartOn
                          ? "bg-[#16161C] border-emerald-500/35 text-emerald-400 hover:bg-[#1E1E26]"
                          : "bg-[#16161C] border-white/[0.08] text-[#A1A1AA] hover:text-[#FAFAFA]"
                      }`}
                      title="Iniciar Cafofo silenciosamente na bandeja ao ligar o Windows"
                    >
                      <Power className="w-3.5 h-3.5" strokeWidth={1.5} />
                      <span className="font-mono text-[11px]">
                        {autostartOn ? "Autostart: ON" : "Autostart: OFF"}
                      </span>
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2 ml-auto">
                  <button
                    type="button"
                    onClick={() => {
                      stopPreviewSound();
                      onClose();
                    }}
                    className="min-h-[38px] px-3.5 py-1.5 rounded-xl bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA]"
                  >
                    Fechar
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="min-h-[38px] px-4 py-1.5 rounded-xl btn-crimson-vivid disabled:opacity-50 text-xs font-medium text-[#FAFAFA] flex items-center gap-1.5"
                  >
                    <Check className="w-3.5 h-3.5" strokeWidth={1.75} />
                    <span>
                      {saving ? "Salvando..." : "Salvar Identidade"}
                    </span>
                  </button>
                </div>
              </div>
            </form>
          </div>

          <ImageCropperModal
            file={pendingAvatarFile}
            title="Recortar Avatar (1:1)"
            subtitle="Arraste e ajuste o zoom para enquadrar seu avatar"
            shape="rounded"
            aspectRatio={1}
            outputWidth={512}
            outputHeight={512}
            onCancel={() => setPendingAvatarFile(null)}
            onConfirm={async (croppedFile) => {
              await uploadAvatar(croppedFile);
              setPendingAvatarFile(null);
            }}
          />

          <ImageCropperModal
            file={pendingBannerFile}
            title="Recortar & Dimensionar Banner (3:1)"
            subtitle="Arraste e ajuste o zoom para enquadrar a faixa superior do perfil"
            shape="rounded"
            aspectRatio={3}
            outputWidth={1200}
            outputHeight={400}
            onCancel={() => setPendingBannerFile(null)}
            onConfirm={async (croppedFile) => {
              await uploadBanner(croppedFile);
              setPendingBannerFile(null);
            }}
          />

          <AudioTrimmerModal
            file={pendingAudioFile}
            maxDurationSec={3.0}
            onCancel={() => setPendingAudioFile(null)}
            onConfirm={async (trimmedFile) => {
              await uploadEntrySound(trimmedFile);
              setPendingAudioFile(null);
            }}
          />

          {/* Confirmação em 2 Etapas para Encerrar Sessão */}
          <Modal
            open={signOutConfirmOpen}
            onOpenChange={(open) => {
              if (!open && !signingOut) setSignOutConfirmOpen(false);
            }}
            overlayZIndexClass="z-[95]"
            contentClassName="w-[90vw] max-w-sm rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl space-y-4"
          >
            <Dialog.Title className="text-sm font-semibold text-[#FAFAFA] flex items-center gap-2">
              <LogOut className="w-4 h-4 text-[#F87171]" strokeWidth={1.75} />
              <span>Encerrar sessão?</span>
            </Dialog.Title>
            <Dialog.Description className="text-xs text-[#A1A1AA] leading-relaxed">
              Você será desconectado das salas de voz ativas e precisará entrar novamente com sua conta Cafofo.
            </Dialog.Description>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                disabled={signingOut}
                onClick={() => setSignOutConfirmOpen(false)}
                className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA]"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={signingOut}
                onClick={async () => {
                  if (!onSignOut) return;
                  setSigningOut(true);
                  try {
                    stopPreviewSound();
                    await onSignOut();
                    setSignOutConfirmOpen(false);
                    onClose();
                  } finally {
                    setSigningOut(false);
                  }
                }}
                className="min-h-[40px] px-4 py-2 rounded-xl btn-non-destructive-active text-xs font-medium flex items-center gap-1.5 disabled:opacity-50"
              >
                <LogOut className="w-3.5 h-3.5" strokeWidth={1.5} />
                <span>{signingOut ? "Saindo..." : "Confirmar Saída"}</span>
              </button>
            </div>
          </Modal>
    </Modal>
  );
}
