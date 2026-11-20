import {
  Disc3,
  Gamepad2,
  Hash,
  Headphones,
  Mic,
  MonitorUp,
  Play,
  SkipForward,
  Volume2,
} from "lucide-react";
import { BrandMark } from "./BrandMark";

export function AppPreviewMockup() {
  return (
    <div className="relative rounded-2xl bg-[#101014] hairline-box shadow-[0_30px_90px_rgba(0,0,0,0.75)] overflow-hidden">
      {/* Barra superior estilo janela desktop */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#09090B] border-b border-white/[0.06]">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-[#27272A]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#27272A]" />
          <span className="w-2.5 h-2.5 rounded-full bg-[#27272A]" />
          <span className="ml-2 font-mono text-[11px] text-[#71717A]">
            Cafofo Desktop — QG da Madrugada
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] text-[#A1A1AA]">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/25 text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            14 ms • GRU
          </span>
        </div>
      </div>

      {/* Corpo da interface */}
      <div className="grid grid-cols-1 md:grid-cols-12 min-h-[370px] bg-[#09090B]">
        {/* Rail + Canais */}
        <div className="hidden md:flex md:col-span-3 border-r border-white/[0.06] bg-[#101014]/70">
          <div className="w-12 border-r border-white/[0.06] py-3 flex flex-col items-center gap-2.5">
            <BrandMark size="sm" />
            <div className="w-8 h-8 rounded-xl bg-[#16161C] hairline-box flex items-center justify-center font-mono text-[11px] text-[#FAFAFA]">
              QG
            </div>
            <div className="w-8 h-8 rounded-xl bg-[#16161C]/60 hairline-box flex items-center justify-center font-mono text-[11px] text-[#71717A]">
              CS
            </div>
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
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
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

          {/* Cards de participantes */}
          <div className="grid grid-cols-2 gap-2.5 flex-1">
            <div className="rounded-xl p-3 bg-gradient-to-br from-[#450A0A]/80 via-[#101014] to-[#09090B] border border-[#B91C1C]/45 flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="px-1.5 py-0.5 rounded bg-black/50 font-mono text-[10px] text-[#FAFAFA]">
                  Predo
                </span>
                <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
              </div>
              <div className="my-4 flex flex-col items-center gap-1.5">
                <div className="w-12 h-12 rounded-2xl bg-[#16161C] border-2 border-[#EF4444] flex items-center justify-center font-mono text-sm font-semibold">
                  PR
                </div>
                <span className="px-2 py-0.5 rounded-full bg-[#B91C1C]/80 font-mono text-[9px] tracking-wider uppercase">
                  DONO DO CAFOFO
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-[#A1A1AA] font-mono">
                <Gamepad2 className="w-3 h-3 text-[#EF4444]" />
                <span className="truncate">Counter-Strike 2</span>
              </div>
            </div>

            <div className="rounded-xl p-3 bg-gradient-to-br from-[#3B0764]/65 via-[#101014] to-[#09090B] hairline-box flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span className="px-1.5 py-0.5 rounded bg-black/50 font-mono text-[10px] text-[#FAFAFA]">
                  Guii
                </span>
                <span className="font-mono text-[9px] text-[#A1A1AA]">TELA</span>
              </div>
              <div className="my-4 flex flex-col items-center gap-1.5">
                <div className="w-12 h-12 rounded-2xl bg-[#16161C] border border-purple-400/60 flex items-center justify-center font-mono text-sm font-semibold">
                  GU
                </div>
                <span className="px-2 py-0.5 rounded-full bg-purple-600/60 font-mono text-[9px] tracking-wider uppercase">
                  STREAMER 60FPS
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-[#A1A1AA] font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                <span className="truncate">Transmitindo janela</span>
              </div>
            </div>
          </div>

          {/* Barra inferior de áudio RNNoise */}
          <div className="rounded-xl bg-[#101014] hairline-box px-3 py-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-mono text-[10px] text-[#A1A1AA]">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span>RNNOISE NATIVO • 64kbps</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="p-1.5 rounded-lg bg-[#16161C] hairline-box text-[#FAFAFA]">
                <Mic className="w-3.5 h-3.5" />
              </span>
              <span className="p-1.5 rounded-lg bg-[#16161C] hairline-box text-[#FAFAFA]">
                <Headphones className="w-3.5 h-3.5" />
              </span>
              <span className="px-2.5 py-1.5 rounded-lg bg-[#B91C1C] text-[10px] font-medium text-[#FAFAFA]">
                Tela
              </span>
            </div>
          </div>
        </div>

        {/* Painel Direito: Bot de Música */}
        <div className="md:col-span-3 border-t md:border-t-0 md:border-l border-white/[0.06] bg-[#101014]/70 p-3.5 flex flex-col justify-between gap-3">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#EF4444] flex items-center gap-1.5">
                <Disc3 className="w-3.5 h-3.5 animate-spin" style={{ animationDuration: "6s" }} />
                Bot de Música
              </span>
              <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                SYNC
              </span>
            </div>

            <div className="rounded-xl bg-[#09090B] hairline-box p-3 space-y-2.5">
              <div className="space-y-0.5">
                <p className="text-xs font-medium text-[#FAFAFA] truncate">
                  Midnight Drive (Lo-Fi Mix)
                </p>
                <p className="text-[10px] font-mono text-[#71717A]">
                  Pedido por Guii • Sala toda ouvindo
                </p>
              </div>
              <div className="space-y-1">
                <div className="h-1 w-full rounded-full bg-[#1E1E26] overflow-hidden">
                  <div className="h-full w-2/3 rounded-full bg-[#B91C1C]" />
                </div>
                <div className="flex justify-between font-mono text-[9px] text-[#71717A]">
                  <span>02:14</span>
                  <span>03:40</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 pt-0.5">
                <span className="flex-1 py-1.5 rounded-lg bg-[#B91C1C] flex items-center justify-center">
                  <Play className="w-3 h-3 fill-white text-white" />
                </span>
                <span className="p-1.5 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA]">
                  <SkipForward className="w-3 h-3" />
                </span>
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
    </div>
  );
}
