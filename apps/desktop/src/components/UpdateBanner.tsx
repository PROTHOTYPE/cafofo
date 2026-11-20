import { Download, Loader2, RefreshCw, X } from "lucide-react";
import type { AppUpdaterState } from "../lib/updater";

interface UpdateBannerProps {
  updater: AppUpdaterState;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateBanner({ updater }: UpdateBannerProps) {
  const {
    supported,
    status,
    availableVersion,
    releaseNotes,
    progress,
    downloadedBytes,
    totalBytes,
    error,
    dismissed,
    installAndRelaunch,
    dismiss,
  } = updater;

  const isBusy = status === "downloading" || status === "installing";
  const shouldShow =
    supported &&
    Boolean(availableVersion) &&
    !dismissed &&
    (status === "available" || isBusy);

  if (!shouldShow || !availableVersion) {
    return null;
  }

  const pct = progress ?? 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[85] w-[min(368px,calc(100vw-2rem))] rounded-2xl scoped-glass border border-[#B91C1C]/45 shadow-[0_18px_48px_rgba(0,0,0,0.65),0_0_24px_rgba(185,28,28,0.18)] p-4 text-[#FAFAFA] animate-cyber-slide"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-[#B91C1C]/20 border border-[#B91C1C]/50 flex items-center justify-center shrink-0">
            {isBusy ? (
              <Loader2 className="w-4 h-4 text-[#EF4444] animate-spin" />
            ) : (
              <Download className="w-4 h-4 text-[#EF4444]" strokeWidth={1.75} />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono uppercase tracking-wider text-[#EF4444] font-semibold">
                Atualização Pronta
              </span>
              <span className="px-1.5 py-0.5 rounded-md bg-[#16161C] border border-[#27272A] font-mono text-[10px] text-[#FAFAFA]">
                v{availableVersion}
              </span>
            </div>
            <p className="text-xs text-[#A1A1AA] truncate mt-0.5">
              {status === "installing"
                ? "Aplicando pacote e reiniciando..."
                : status === "downloading"
                  ? "Baixando instalador assinado..."
                  : "Nova versão do Cafofo disponível."}
            </p>
          </div>
        </div>

        {!isBusy && (
          <button
            type="button"
            onClick={dismiss}
            className="p-1 rounded-lg bg-[#16161C]/80 hover:bg-[#1E1E26] border border-[#27272A] text-[#A1A1AA] hover:text-[#FAFAFA] transition-colors shrink-0"
            title="Lembrar depois"
          >
            <X className="w-3.5 h-3.5" strokeWidth={1.75} />
          </button>
        )}
      </div>

      {releaseNotes && !isBusy && (
        <p className="mt-2.5 text-[11px] text-[#A1A1AA] line-clamp-2 leading-relaxed bg-[#09090B]/60 border border-[#27272A]/80 rounded-xl px-2.5 py-2 font-mono">
          {releaseNotes}
        </p>
      )}

      {isBusy && (
        <div className="mt-3 space-y-1.5">
          <div className="h-1.5 w-full rounded-full bg-[#1E1E26] overflow-hidden border border-[#27272A]/80">
            <div
              className={`h-full rounded-full bg-[#B91C1C] transition-all duration-200 ${
                progress === null ? "w-2/3 animate-pulse" : ""
              }`}
              style={progress !== null ? { width: `${pct}%` } : undefined}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-[#A1A1AA]">
            <span>
              {totalBytes
                ? `${formatMegabytes(downloadedBytes)} / ${formatMegabytes(totalBytes)}`
                : formatMegabytes(downloadedBytes)}
            </span>
            <span>{progress !== null ? `${pct}%` : "..."}</span>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2.5 text-[11px] text-[#F87171] bg-[#1E1E26]/90 border border-[#F87171]/30 rounded-xl px-2.5 py-1.5">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={isBusy}
          onClick={() => void installAndRelaunch()}
          className="w-full min-h-[36px] px-3.5 py-2 rounded-xl btn-crimson-vivid disabled:opacity-60 text-xs font-medium text-[#FAFAFA] flex items-center justify-center gap-2 transition-all"
        >
          {isBusy ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>
                {status === "installing"
                  ? "Reiniciando Cafofo..."
                  : "Baixando atualização..."}
              </span>
            </>
          ) : (
            <>
              <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span>Atualizar e Reiniciar</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
