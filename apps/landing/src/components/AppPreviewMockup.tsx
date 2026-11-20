import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "framer-motion";
import {
  Disc3,
  Gamepad2,
  Hash,
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  MonitorUp,
  Pause,
  Play,
  SkipForward,
  Sparkles,
  Volume2,
} from "lucide-react";
import { BrandMark } from "./BrandMark";

const DEMO_TRACKS = [
  { title: "Midnight Drive (Lo-Fi Mix)", requester: "Guii", duration: "03:40" },
  { title: "Synthwave Overdrive 1989", requester: "Predo", duration: "04:12" },
  { title: "Night City Ambient Session", requester: "Matheus", duration: "02:58" },
];

export function AppPreviewMockup() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [focusedUser, setFocusedUser] = useState<"predo" | "guii">("predo");
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [rnnoise, setRnnoise] = useState(true);
  const [isPlaying, setIsPlaying] = useState(true);
  const [trackIndex, setTrackIndex] = useState(0);
  const [progressPct, setProgressPct] = useState(42);

  // Tilt 3D suave seguindo o ponteiro
  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const smoothX = useSpring(mouseX, { stiffness: 180, damping: 24 });
  const smoothY = useSpring(mouseY, { stiffness: 180, damping: 24 });
  const rotateX = useTransform(smoothY, [-0.5, 0.5], [3.5, -3.5]);
  const rotateY = useTransform(smoothX, [-0.5, 0.5], [-4.5, 4.5]);

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    mouseX.set((e.clientX - rect.left) / rect.width - 0.5);
    mouseY.set((e.clientY - rect.top) / rect.height - 0.5);
  };

  const handleMouseLeave = () => {
    mouseX.set(0);
    mouseY.set(0);
  };

  useEffect(() => {
    if (!isPlaying) return;
    const id = window.setInterval(() => {
      setProgressPct((prev) => {
        if (prev >= 98) {
          setTrackIndex((idx) => (idx + 1) % DEMO_TRACKS.length);
          return 4;
        }
        return prev + 1.5;
      });
    }, 350);
    return () => window.clearInterval(id);
  }, [isPlaying]);

  const currentTrack = DEMO_TRACKS[trackIndex];

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ perspective: 1200 }}
      className="relative"
    >
      <motion.div
        style={{ rotateX, rotateY, transformStyle: "preserve-3d" }}
        initial={{ opacity: 0, y: 34, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.7, delay: 0.24, ease: [0.22, 1, 0.36, 1] }}
        className="relative rounded-2xl bg-[#101014] hairline-box shadow-[0_32px_96px_rgba(0,0,0,0.82),0_0_50px_rgba(185,28,28,0.12)] overflow-hidden"
      >
        {/* Barra superior estilo janela desktop */}
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#09090B] border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#EF4444]/70" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#27272A]" />
            <span className="w-2.5 h-2.5 rounded-full bg-[#27272A]" />
            <span className="ml-2 font-mono text-[11px] text-[#71717A]">
              Cafofo Desktop — QG da Madrugada
            </span>
          </div>
          <div className="flex items-center gap-2 font-mono text-[10px] text-[#A1A1AA]">
            <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[#16161C] hairline-box text-[#A1A1AA]">
              <Sparkles className="w-3 h-3 text-[#EF4444]" />
              Interativo — teste os botões
            </span>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/25 text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              14 ms • GRU
            </span>
          </div>
        </div>

        {/* Corpo da interface */}
        <div className="grid grid-cols-1 md:grid-cols-12 min-h-[385px] bg-[#09090B]">
          {/* Rail + Canais */}
          <div className="hidden md:flex md:col-span-3 border-r border-white/[0.06] bg-[#101014]/70">
            <div className="w-12 border-r border-white/[0.06] py-3 flex flex-col items-center gap-2.5">
              <BrandMark size="sm" />
              <motion.div
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.94 }}
                className="w-8 h-8 rounded-xl bg-[#16161C] border border-[#B91C1C]/60 flex items-center justify-center font-mono text-[11px] text-[#FAFAFA] cursor-pointer"
              >
                QG
              </motion.div>
              <motion.div
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.94 }}
                className="w-8 h-8 rounded-xl bg-[#16161C]/60 hairline-box flex items-center justify-center font-mono text-[11px] text-[#71717A] hover:text-[#FAFAFA] cursor-pointer"
              >
                CS
              </motion.div>
            </div>

            <div className="flex-1 p-3 space-y-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-wider text-[#71717A] mb-1.5">
                  Texto
                </p>
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#16161C] text-[#FAFAFA]">
                    <Hash className="w-3.5 h-3.5 text-[#EF4444]" />
                    <span>geral</span>
                  </div>
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[#71717A]">
                    <Hash className="w-3.5 h-3.5" />
                    <span>clipes</span>
                  </div>
                </div>
              </div>

              <div>
                <p className="font-mono text-[10px] uppercase tracking-wider text-[#71717A] mb-1.5">
                  Voz
                </p>
                <div className="space-y-1.5 text-xs">
                  <div className="px-2 py-1.5 rounded-lg bg-[#B91C1C]/15 border border-[#B91C1C]/40 text-[#FAFAFA] flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Volume2 className="w-3.5 h-3.5 text-[#EF4444]" />
                      <span>Voz Principal</span>
                    </span>
                    <span className="font-mono text-[10px] text-[#EF4444]">3</span>
                  </div>
                  <div className="pl-4 space-y-1 text-[11px] text-[#A1A1AA]">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          muted ? "bg-[#F87171]" : "bg-emerald-400"
                        }`}
                      />
                      <span>Predo</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      <span>Guii</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#71717A]" />
                      <span>Matheus</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Palco Central 16:9 + Controles de Voz */}
          <div className="md:col-span-6 p-4 flex flex-col justify-between gap-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-[#A1A1AA] flex items-center gap-1.5">
                <MonitorUp className="w-3.5 h-3.5 text-[#EF4444]" />
                Palco de Voz & Transmissões
              </span>
              <span className="px-2 py-0.5 rounded-md bg-[#B91C1C]/20 border border-[#B91C1C]/40 font-mono text-[10px] text-[#F87171]">
                AO VIVO • 1080p60
              </span>
            </div>

            {/* Cards interativos de participantes */}
            <div className="grid grid-cols-2 gap-2.5 flex-1">
              {(
                [
                  {
                    id: "predo" as const,
                    name: "Predo",
                    initials: "PR",
                    badge: "DONO DO CAFOFO",
                    badgeBg: "bg-[#B91C1C]/85",
                    gradient:
                      "from-[#450A0A]/85 via-[#101014] to-[#09090B]",
                    avatarBorder: "border-[#EF4444]",
                    footer: "Counter-Strike 2",
                    isGame: true,
                  },
                  {
                    id: "guii" as const,
                    name: "Guii",
                    initials: "GU",
                    badge: "STREAMER 60FPS",
                    badgeBg: "bg-purple-600/75",
                    gradient:
                      "from-[#3B0764]/70 via-[#101014] to-[#09090B]",
                    avatarBorder: "border-purple-400/70",
                    footer: "Transmitindo janela",
                    isGame: false,
                  },
                ] as const
              ).map((card) => {
                const isFocused = focusedUser === card.id;
                return (
                  <motion.button
                    key={card.id}
                    type="button"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => setFocusedUser(card.id)}
                    className={`relative text-left rounded-xl p-3 bg-gradient-to-br ${card.gradient} hairline-box flex flex-col justify-between cursor-pointer focus:outline-none`}
                  >
                    {isFocused && (
                      <motion.div
                        layoutId="stageFocusRing"
                        transition={{
                          type: "spring",
                          stiffness: 380,
                          damping: 30,
                        }}
                        className="pointer-events-none absolute inset-0 rounded-xl border-2 border-[#EF4444] shadow-[0_0_24px_rgba(239,68,68,0.22)]"
                      />
                    )}

                    <div className="flex items-center justify-between w-full relative z-10">
                      <span className="px-1.5 py-0.5 rounded bg-black/55 font-mono text-[10px] text-[#FAFAFA]">
                        {card.name}
                      </span>
                      <span
                        className={`w-2 h-2 rounded-full ${
                          card.id === "predo" && muted
                            ? "bg-[#F87171]"
                            : "bg-emerald-400 shadow-[0_0_8px_#34d399]"
                        }`}
                      />
                    </div>

                    <div className="my-4 flex flex-col items-center gap-1.5 w-full relative z-10">
                      <div
                        className={`w-12 h-12 rounded-2xl bg-[#16161C] border-2 ${card.avatarBorder} flex items-center justify-center font-mono text-sm font-semibold`}
                      >
                        {card.initials}
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full ${card.badgeBg} font-mono text-[9px] tracking-wider uppercase`}
                      >
                        {card.badge}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-[10px] text-[#A1A1AA] font-mono relative z-10 w-full">
                      {card.isGame ? (
                        <Gamepad2 className="w-3 h-3 text-[#EF4444] shrink-0" />
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-400 shrink-0" />
                      )}
                      <span className="truncate">{card.footer}</span>
                    </div>
                  </motion.button>
                );
              })}
            </div>

            {/* Barra inferior interativa de áudio RNNoise */}
            <div className="rounded-xl bg-[#101014] hairline-box px-3 py-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                {/* Equalizador vivo reagindo ao mute */}
                <div className="flex items-end gap-[2px] h-3.5 w-5">
                  {[
                    "animate-eq-1",
                    "animate-eq-2",
                    "animate-eq-3",
                    "animate-eq-4",
                  ].map((anim, i) => (
                    <span
                      key={i}
                      className={`w-[3px] h-full rounded-full origin-bottom transition-colors ${
                        muted
                          ? "bg-[#3F3F46] scale-y-[0.25]"
                          : `bg-emerald-400 ${anim}`
                      }`}
                    />
                  ))}
                </div>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onClick={() => setRnnoise((v) => !v)}
                  className={`px-2 py-0.5 rounded-md font-mono text-[10px] border transition-colors ${
                    rnnoise
                      ? "bg-[#B91C1C]/20 border-[#B91C1C]/50 text-[#FAFAFA]"
                      : "bg-[#16161C] border-white/[0.08] text-[#71717A]"
                  }`}
                  title="Alternar supressor de ruído RNNoise"
                >
                  RNNOISE {rnnoise ? "ON" : "OFF"} • 64kbps
                </motion.button>
              </div>

              <div className="flex items-center gap-1.5">
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.07 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setMuted((v) => !v)}
                  className={`p-1.5 rounded-lg border transition-colors ${
                    muted
                      ? "bg-[#B91C1C]/25 border-[#EF4444]/60 text-[#F87171]"
                      : "bg-[#16161C] border-white/[0.08] text-[#FAFAFA] hover:bg-[#1E1E26]"
                  }`}
                  title={muted ? "Ativar microfone" : "Mutar microfone"}
                >
                  {muted ? (
                    <MicOff className="w-3.5 h-3.5" />
                  ) : (
                    <Mic className="w-3.5 h-3.5" />
                  )}
                </motion.button>
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.07 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => setDeafened((v) => !v)}
                  className={`p-1.5 rounded-lg border transition-colors ${
                    deafened
                      ? "bg-[#B91C1C]/25 border-[#EF4444]/60 text-[#F87171]"
                      : "bg-[#16161C] border-white/[0.08] text-[#FAFAFA] hover:bg-[#1E1E26]"
                  }`}
                  title={deafened ? "Reativar áudio" : "Ensurdecer"}
                >
                  {deafened ? (
                    <HeadphoneOff className="w-3.5 h-3.5" />
                  ) : (
                    <Headphones className="w-3.5 h-3.5" />
                  )}
                </motion.button>
              </div>
            </div>
          </div>

          {/* Painel Direito Interativo: Bot de Música */}
          <div className="md:col-span-3 border-t md:border-t-0 md:border-l border-white/[0.06] bg-[#101014]/70 p-3.5 flex flex-col justify-between gap-3">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-[#EF4444] flex items-center gap-1.5">
                  <Disc3
                    className={`w-3.5 h-3.5 ${isPlaying ? "animate-spin" : ""}`}
                    style={{ animationDuration: "5s" }}
                  />
                  Bot de Música
                </span>
                <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                  {isPlaying ? "TOCANDO" : "PAUSADO"}
                </span>
              </div>

              <div className="rounded-xl bg-[#09090B] hairline-box p-3 space-y-2.5">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={currentTrack.title}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.22 }}
                    className="space-y-0.5"
                  >
                    <p className="text-xs font-medium text-[#FAFAFA] truncate">
                      {currentTrack.title}
                    </p>
                    <p className="text-[10px] font-mono text-[#71717A]">
                      Pedido por {currentTrack.requester}
                    </p>
                  </motion.div>
                </AnimatePresence>

                <div className="space-y-1">
                  <div className="h-1.5 w-full rounded-full bg-[#1E1E26] overflow-hidden">
                    <motion.div
                      className="h-full rounded-full bg-[#B91C1C]"
                      animate={{ width: `${progressPct}%` }}
                      transition={{ duration: 0.3, ease: "linear" }}
                    />
                  </div>
                  <div className="flex justify-between font-mono text-[9px] text-[#71717A]">
                    <span>{isPlaying ? "SYNC" : "PAUSA"}</span>
                    <span>{currentTrack.duration}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 pt-0.5">
                  <motion.button
                    type="button"
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.94 }}
                    onClick={() => setIsPlaying((v) => !v)}
                    className="flex-1 py-1.5 rounded-lg bg-[#B91C1C] hover:bg-[#DC2626] flex items-center justify-center gap-1 text-[10px] font-medium text-[#FAFAFA] transition-colors"
                  >
                    {isPlaying ? (
                      <>
                        <Pause className="w-3 h-3 fill-white text-white" />
                        <span>Pausar</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3 h-3 fill-white text-white" />
                        <span>Tocar</span>
                      </>
                    )}
                  </motion.button>
                  <motion.button
                    type="button"
                    whileHover={{ scale: 1.08 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => {
                      setTrackIndex((idx) => (idx + 1) % DEMO_TRACKS.length);
                      setProgressPct(6);
                      setIsPlaying(true);
                    }}
                    className="p-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA] transition-colors"
                    title="Próxima faixa"
                  >
                    <SkipForward className="w-3.5 h-3.5" />
                  </motion.button>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-[#09090B]/80 hairline-box p-2.5 space-y-1">
              <p className="font-mono text-[10px] text-[#71717A] uppercase">
                Game Detector
              </p>
              <p className="text-[11px] text-[#FAFAFA] flex items-center gap-1.5">
                <Gamepad2 className="w-3.5 h-3.5 text-[#EF4444]" />
                <span>Detecta seu jogo ao vivo</span>
              </p>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
