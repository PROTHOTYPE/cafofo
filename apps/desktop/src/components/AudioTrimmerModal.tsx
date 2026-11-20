import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Slider from "@radix-ui/react-slider";
import { Check, Music, Play, Scissors, Square, X } from "lucide-react";
import { Modal } from "./Modal";

const WAVEFORM_BARS = 128;
const OUTPUT_SAMPLE_RATE = 24_000;
const FADE_SEC = 0.015;

interface AudioTrimmerModalProps {
  file: File | null;
  maxDurationSec?: number;
  onCancel: () => void;
  onConfirm: (trimmedFile: File) => void | Promise<void>;
}

function formatSeconds(sec: number): string {
  const safe = Math.max(0, sec);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  return `${mins}:${rem < 10 ? "0" : ""}${rem.toFixed(1)}`;
}

function computeWaveformPeaks(buffer: AudioBuffer, bars: number): number[] {
  const channel = buffer.getChannelData(0);
  const total = channel.length;
  if (total === 0) return Array(bars).fill(0.1);
  const blockSize = Math.max(1, Math.floor(total / bars));
  const peaks: number[] = [];
  let maxPeak = 0.001;

  for (let i = 0; i < bars; i++) {
    const start = i * blockSize;
    const end = Math.min(total, start + blockSize);
    let peak = 0;
    const step = Math.max(1, Math.floor((end - start) / 120));
    for (let j = start; j < end; j += step) {
      const abs = Math.abs(channel[j] ?? 0);
      if (abs > peak) peak = abs;
    }
    peaks.push(peak);
    if (peak > maxPeak) maxPeak = peak;
  }

  return peaks.map((p) => Math.max(0.08, p / maxPeak));
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

async function encodeAudioSliceToWav(
  sourceBuffer: AudioBuffer,
  startSec: number,
  durationSec: number,
  originalName: string,
): Promise<File> {
  const clampedStart = Math.max(
    0,
    Math.min(sourceBuffer.duration, startSec),
  );
  const clampedDur = Math.max(
    0.25,
    Math.min(durationSec, sourceBuffer.duration - clampedStart),
  );
  const frameCount = Math.max(1, Math.floor(clampedDur * OUTPUT_SAMPLE_RATE));

  const OfflineCtx =
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;

  let monoSamples: Float32Array;
  if (OfflineCtx) {
    const offline = new OfflineCtx(1, frameCount, OUTPUT_SAMPLE_RATE);
    const src = offline.createBufferSource();
    src.buffer = sourceBuffer;
    src.connect(offline.destination);
    src.start(0, clampedStart, clampedDur);
    const rendered = await offline.startRendering();
    monoSamples = rendered.getChannelData(0);
  } else {
    // Direct linear resample fallback
    const srcRate = sourceBuffer.sampleRate;
    const srcStart = Math.floor(clampedStart * srcRate);
    const ch0 = sourceBuffer.getChannelData(0);
    monoSamples = new Float32Array(frameCount);
    const ratio = srcRate / OUTPUT_SAMPLE_RATE;
    for (let i = 0; i < frameCount; i++) {
      const idx = Math.min(ch0.length - 1, srcStart + Math.floor(i * ratio));
      monoSamples[i] = ch0[idx] ?? 0;
    }
  }

  // Apply gentle 15ms fade-in/out to prevent clicks at slice boundaries
  const fadeSamples = Math.min(
    Math.floor(frameCount / 4),
    Math.floor(FADE_SEC * OUTPUT_SAMPLE_RATE),
  );
  const processed = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let gain = 1;
    if (fadeSamples > 0 && i < fadeSamples) {
      gain = i / fadeSamples;
    } else if (fadeSamples > 0 && i > frameCount - 1 - fadeSamples) {
      gain = (frameCount - 1 - i) / fadeSamples;
    }
    processed[i] = Math.max(-1, Math.min(1, (monoSamples[i] ?? 0) * gain));
  }

  // Encode 16-bit mono PCM WAV (3s @ 24kHz = ~144 KB, well under 500 KB limit)
  const dataBytes = frameCount * 2;
  const wavBuf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(wavBuf);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, 1, true); // NumChannels = 1 (Mono)
  view.setUint32(24, OUTPUT_SAMPLE_RATE, true);
  view.setUint32(28, OUTPUT_SAMPLE_RATE * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i++) {
    const s = processed[i] ?? 0;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  const baseName = originalName.replace(/\.[^.]+$/, "") || "entry-sound";
  return new File([wavBuf], `${baseName}-trim.wav`, { type: "audio/wav" });
}

export function AudioTrimmerModal({
  file,
  maxDurationSec = 3.0,
  onCancel,
  onConfirm,
}: AudioTrimmerModalProps) {
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [decoding, setDecoding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [startSec, setStartSec] = useState(0);
  const [clipDuration, setClipDuration] = useState(maxDurationSec);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState<number | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const draggingRef = useRef<{
    active: boolean;
    offsetSec: number;
  }>({ active: false, offsetSec: 0 });

  const stopPreview = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.onended = null;
        sourceRef.current.stop();
        sourceRef.current.disconnect();
      } catch {
        // ignore
      }
      sourceRef.current = null;
    }
    setIsPlaying(false);
    setPlayheadSec(null);
  }, []);

  useEffect(() => {
    return () => {
      stopPreview();
      if (playCtxRef.current) {
        void playCtxRef.current.close().catch(() => {});
        playCtxRef.current = null;
      }
    };
  }, [stopPreview]);

  useEffect(() => {
    stopPreview();
    if (!file) {
      setAudioBuffer(null);
      setPeaks([]);
      setError(null);
      setDecoding(false);
      return;
    }

    let cancelled = false;
    setDecoding(true);
    setError(null);
    setAudioBuffer(null);

    const decode = async () => {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) {
        throw new Error("Seu navegador não suporta decodificação Web Audio.");
      }
      const ctx = new Ctx();
      try {
        const arrayBuf = await file.arrayBuffer();
        const decoded = await ctx.decodeAudioData(arrayBuf);
        if (cancelled) return;
        const effectiveClip = Math.min(maxDurationSec, decoded.duration);
        setAudioBuffer(decoded);
        setPeaks(computeWaveformPeaks(decoded, WAVEFORM_BARS));
        setStartSec(0);
        setClipDuration(Number(effectiveClip.toFixed(2)));
      } finally {
        await ctx.close().catch(() => {});
      }
    };

    void decode()
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? `Não foi possível ler o áudio: ${err.message}`
              : "Não foi possível decodificar o arquivo de áudio.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setDecoding(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file, maxDurationSec, stopPreview]);

  const totalDuration = audioBuffer?.duration ?? 0;
  const maxStart = Math.max(0, totalDuration - clipDuration);

  // Draw waveform on high-DPI canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0 || totalDuration <= 0) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = canvas.clientWidth || 440;
    const height = canvas.clientHeight || 96;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const startRatio = startSec / totalDuration;
    const endRatio = Math.min(1, (startSec + clipDuration) / totalDuration);

    // Subtle highlighted backdrop behind selected slice
    const selX = startRatio * width;
    const selW = Math.max(6, (endRatio - startRatio) * width);
    ctx.fillStyle = "rgba(185, 28, 28, 0.16)";
    ctx.fillRect(selX, 0, selW, height);

    const barSlot = width / peaks.length;
    const barW = Math.max(1.5, barSlot * 0.62);
    const midY = height / 2;

    for (let i = 0; i < peaks.length; i++) {
      const ratio = (i + 0.5) / peaks.length;
      const inWindow = ratio >= startRatio && ratio <= endRatio;
      const amp = (peaks[i] ?? 0.1) * (height * 0.82);
      const x = i * barSlot + (barSlot - barW) / 2;
      const y = midY - amp / 2;

      ctx.fillStyle = inWindow ? "#EF4444" : "rgba(161, 161, 170, 0.28)";
      ctx.beginPath();
      ctx.roundRect(x, y, barW, Math.max(3, amp), 2);
      ctx.fill();
    }

    // Selection window edges
    ctx.strokeStyle = "#EF4444";
    ctx.lineWidth = 2;
    ctx.strokeRect(selX + 1, 1, Math.max(4, selW - 2), height - 2);

    // Live playhead needle
    if (playheadSec !== null && totalDuration > 0) {
      const px = Math.min(width - 1, Math.max(0, (playheadSec / totalDuration) * width));
      ctx.strokeStyle = "#FAFAFA";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 2);
      ctx.lineTo(px, height - 2);
      ctx.stroke();
    }
  }, [peaks, startSec, clipDuration, totalDuration, playheadSec]);

  const handleTogglePlay = async () => {
    if (isPlaying) {
      stopPreview();
      return;
    }
    if (!audioBuffer) return;

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;

    if (!playCtxRef.current || playCtxRef.current.state === "closed") {
      playCtxRef.current = new Ctx();
    }
    const ctx = playCtxRef.current;
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }

    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ctx.destination);

    const playStartCtxTime = ctx.currentTime;
    const sliceStart = startSec;
    const sliceDur = Math.min(clipDuration, Math.max(0.1, totalDuration - startSec));

    src.onended = () => {
      stopPreview();
    };
    sourceRef.current = src;
    setIsPlaying(true);
    setPlayheadSec(sliceStart);
    src.start(0, sliceStart, sliceDur);

    const tick = () => {
      if (!sourceRef.current || !playCtxRef.current) return;
      const elapsed = playCtxRef.current.currentTime - playStartCtxTime;
      if (elapsed >= sliceDur) {
        stopPreview();
        return;
      }
      setPlayheadSec(sliceStart + elapsed);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const clientXToSeconds = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || totalDuration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return pct * totalDuration;
  };

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!audioBuffer || totalDuration <= 0) return;
    stopPreview();
    e.currentTarget.setPointerCapture(e.pointerId);
    const secAtPointer = clientXToSeconds(e.clientX);
    const inSelection =
      secAtPointer >= startSec && secAtPointer <= startSec + clipDuration;

    if (inSelection) {
      draggingRef.current = {
        active: true,
        offsetSec: secAtPointer - startSec,
      };
    } else {
      const centeredStart = Math.max(
        0,
        Math.min(maxStart, secAtPointer - clipDuration / 2),
      );
      setStartSec(centeredStart);
      draggingRef.current = {
        active: true,
        offsetSec: secAtPointer - centeredStart,
      };
    }
  };

  const handleTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current.active || totalDuration <= 0) return;
    const secAtPointer = clientXToSeconds(e.clientX);
    const nextStart = Math.max(
      0,
      Math.min(maxStart, secAtPointer - draggingRef.current.offsetSec),
    );
    setStartSec(nextStart);
  };

  const handleTrackPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current.active) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      draggingRef.current.active = false;
    }
  };

  const handleConfirmTrim = async () => {
    if (!file || !audioBuffer) return;
    stopPreview();
    setExporting(true);
    setError(null);
    try {
      const wavFile = await encodeAudioSliceToWav(
        audioBuffer,
        startSec,
        clipDuration,
        file.name,
      );
      await onConfirm(wavFile);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const estimatedKb = Math.round((clipDuration * OUTPUT_SAMPLE_RATE * 2 + 44) / 1024);

  return (
    <Modal
      open={Boolean(file)}
      onOpenChange={(open) => {
        if (!open && !exporting) {
          stopPreview();
          onCancel();
        }
      }}
      overlayZIndexClass="z-[90]"
      contentClassName="w-[94vw] max-w-lg rounded-2xl bg-[#101014] hairline-box shadow-2xl p-5 space-y-4 select-none"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <Dialog.Title className="text-sm font-semibold text-[#FAFAFA] flex items-center gap-2">
            <Scissors className="w-4 h-4 text-[#EF4444]" strokeWidth={1.75} />
            <span>Recortar Som de Entrada (máx {maxDurationSec}s)</span>
          </Dialog.Title>
          <Dialog.Description className="text-[11px] text-[#A1A1AA] truncate">
            {file?.name ?? "Selecione o trecho desejado na onda sonora"}
          </Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <button
            type="button"
            disabled={exporting}
            className="p-1.5 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
            aria-label="Fechar tesoura de áudio"
          >
            <X className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </Dialog.Close>
      </div>

      {decoding ? (
        <div className="h-32 rounded-xl bg-[#09090B] hairline-box flex flex-col items-center justify-center gap-2 text-xs font-mono text-[#A1A1AA]">
          <Music className="w-5 h-5 text-[#EF4444] animate-pulse" strokeWidth={1.5} />
          <span>DECODIFICANDO ONDA SONORA...</span>
        </div>
      ) : audioBuffer ? (
        <div className="space-y-3.5">
          {/* Waveform interativo estilo Tesoura / Stories */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[10px] font-mono text-[#A1A1AA]">
              <span>INÍCIO {formatSeconds(startSec)}</span>
              <span className="text-[#EF4444] font-semibold">
                TRECHO {clipDuration.toFixed(1)}s (~{estimatedKb} KB WAV)
              </span>
              <span>FIM {formatSeconds(Math.min(totalDuration, startSec + clipDuration))}</span>
            </div>

            <div
              ref={trackRef}
              onPointerDown={handleTrackPointerDown}
              onPointerMove={handleTrackPointerMove}
              onPointerUp={handleTrackPointerUp}
              onPointerCancel={handleTrackPointerUp}
              className="relative h-24 w-full rounded-xl bg-[#09090B] hairline-box overflow-hidden cursor-ew-resize touch-none"
              title="Arraste a janela carmesim para escolher o trecho de até 3 segundos"
            >
              <canvas
                ref={canvasRef}
                className="w-full h-full block pointer-events-none"
              />
            </div>

            <p className="text-[11px] text-[#71717A] text-center">
              Arraste o bloco carmesim na onda sonora para escolher o exato trecho de entrada.
            </p>
          </div>

          {/* Sliders de ajuste fino (Posição & Duração) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3 rounded-xl bg-[#09090B]/70 hairline-box text-[11px]">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[#A1A1AA]">Posição Inicial</span>
                <span className="font-mono text-[#FAFAFA]">
                  {formatSeconds(startSec)} / {formatSeconds(totalDuration)}
                </span>
              </div>
              <Slider.Root
                className="relative flex items-center select-none touch-none w-full h-4"
                value={[Math.round(startSec * 20)]}
                min={0}
                max={Math.max(1, Math.round(maxStart * 20))}
                step={1}
                disabled={maxStart <= 0.05}
                onValueChange={(vals) => {
                  stopPreview();
                  setStartSec((vals[0] ?? 0) / 20);
                }}
              >
                <Slider.Track className="bg-[#16161C] relative grow rounded-full h-1.5 hairline-box">
                  <Slider.Range className="absolute bg-[#B91C1C] rounded-full h-full" />
                </Slider.Track>
                <Slider.Thumb
                  className="block w-3.5 h-3.5 bg-[#FAFAFA] border border-[#B91C1C] rounded-full focus:outline-none"
                  aria-label="Posição inicial do trecho"
                />
              </Slider.Root>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[#A1A1AA]">Duração do Recorte</span>
                <span className="font-mono text-[#FAFAFA]">
                  {clipDuration.toFixed(1)}s
                </span>
              </div>
              <Slider.Root
                className="relative flex items-center select-none touch-none w-full h-4"
                value={[Math.round(clipDuration * 10)]}
                min={Math.min(5, Math.max(2, Math.round(totalDuration * 10)))}
                max={Math.max(
                  5,
                  Math.round(Math.min(maxDurationSec, totalDuration) * 10),
                )}
                step={1}
                onValueChange={(vals) => {
                  stopPreview();
                  const nextDur = (vals[0] ?? 30) / 10;
                  setClipDuration(nextDur);
                  setStartSec((prev) =>
                    Math.max(0, Math.min(Math.max(0, totalDuration - nextDur), prev)),
                  );
                }}
              >
                <Slider.Track className="bg-[#16161C] relative grow rounded-full h-1.5 hairline-box">
                  <Slider.Range className="absolute bg-[#EF4444] rounded-full h-full" />
                </Slider.Track>
                <Slider.Thumb
                  className="block w-3.5 h-3.5 bg-[#FAFAFA] border border-[#EF4444] rounded-full focus:outline-none"
                  aria-label="Duração do trecho"
                />
              </Slider.Root>
            </div>
          </div>
        </div>
      ) : null}

      {error && (
        <div className="p-2.5 rounded-xl bg-[#1E1E26] border border-[#F87171]/30 text-xs text-[#F87171]">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-2 hairline-t">
        <button
          type="button"
          disabled={!audioBuffer || decoding || exporting}
          onClick={() => void handleTogglePlay()}
          className={`min-h-[38px] px-3.5 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition-colors disabled:opacity-40 ${
            isPlaying
              ? "btn-non-destructive-active"
              : "bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#FAFAFA]"
          }`}
        >
          {isPlaying ? (
            <>
              <Square className="w-3 h-3 fill-current" strokeWidth={1.5} />
              <span>Parar Preview</span>
            </>
          ) : (
            <>
              <Play className="w-3 h-3 fill-current text-[#EF4444]" strokeWidth={1.5} />
              <span>Ouvir Recorte</span>
            </>
          )}
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={exporting}
            onClick={() => {
              stopPreview();
              onCancel();
            }}
            className="min-h-[38px] px-3.5 py-2 rounded-xl bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA]"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={!audioBuffer || decoding || exporting}
            onClick={() => void handleConfirmTrim()}
            className="min-h-[38px] px-4 py-2 rounded-xl btn-crimson-vivid disabled:opacity-50 text-xs font-medium text-[#FAFAFA] flex items-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5" strokeWidth={1.75} />
            <span>{exporting ? "Cortando..." : "Recortar e Salvar"}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
