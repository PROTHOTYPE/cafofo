import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AudioWaveform, Copy, Minus, Square, X } from "lucide-react";
import { isTauriRuntime } from "../lib/tauri";

interface WindowTitlebarProps {
  inVoiceCall?: boolean;
}

export function WindowTitlebar({ inVoiceCall = false }: WindowTitlebarProps) {
  const isDesktop = isTauriRuntime();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;

    const syncMaximized = async () => {
      try {
        setMaximized(await win.isMaximized());
      } catch {
        // Ignora caso a janela ainda esteja inicializando
      }
    };

    void syncMaximized();
    void win
      .onResized(() => {
        void syncMaximized();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      unlisten?.();
    };
  }, [isDesktop]);

  if (!isDesktop) {
    return null;
  }

  const handleMinimize = () => {
    void getCurrentWindow().minimize();
  };

  const handleToggleMaximize = () => {
    void getCurrentWindow().toggleMaximize();
  };

  const handleCloseToTray = () => {
    void getCurrentWindow().close();
  };

  return (
    <div
      data-tauri-drag-region
      onDoubleClick={handleToggleMaximize}
      className="h-8 w-full shrink-0 bg-[#09090B] border-b border-white/[0.06] flex items-center justify-between pl-3 select-none z-[70]"
    >
      {/* Marca integrada */}
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 pointer-events-none"
      >
        <div className="w-4 h-4 rounded-[5px] bg-[#B91C1C] flex items-center justify-center shadow-[0_0_10px_rgba(185,28,28,0.45)]">
          <AudioWaveform className="w-2.5 h-2.5 text-[#FAFAFA]" strokeWidth={2.2} />
        </div>
        <span className="font-mono text-[11px] font-semibold tracking-[0.14em] text-[#D4D4D8]">
          CAFOFO
        </span>
        {inVoiceCall && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/25 font-mono text-[9px] text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            EM CALL
          </span>
        )}
      </div>

      {/* Controles nativos integrados */}
      <div className="flex items-center h-full">
        <button
          type="button"
          onClick={handleMinimize}
          aria-label="Minimizar janela"
          title="Minimizar"
          className="h-full w-11 flex items-center justify-center text-[#A1A1AA] hover:text-[#FAFAFA] hover:bg-white/[0.06] transition-colors"
        >
          <Minus className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>

        <button
          type="button"
          onClick={handleToggleMaximize}
          aria-label={maximized ? "Restaurar janela" : "Maximizar janela"}
          title={maximized ? "Restaurar" : "Maximizar"}
          className="h-full w-11 flex items-center justify-center text-[#A1A1AA] hover:text-[#FAFAFA] hover:bg-white/[0.06] transition-colors"
        >
          {maximized ? (
            <Copy className="w-3 h-3" strokeWidth={1.75} />
          ) : (
            <Square className="w-3 h-3" strokeWidth={1.75} />
          )}
        </button>

        <button
          type="button"
          onClick={handleCloseToTray}
          aria-label="Minimizar para a bandeja do sistema"
          title="Minimizar para a bandeja (mantém a call ativa)"
          className="h-full w-11 flex items-center justify-center text-[#A1A1AA] hover:text-[#FAFAFA] hover:bg-[#B91C1C] transition-colors"
        >
          <X className="w-3.5 h-3.5" strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
