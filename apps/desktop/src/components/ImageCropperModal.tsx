import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Slider from "@radix-ui/react-slider";
import { Check, Crop, Move, RotateCcw, Sparkles, X, ZoomIn } from "lucide-react";
import { Modal } from "./Modal";

interface ImageCropperModalProps {
  file: File | null;
  title?: string;
  subtitle?: string;
  shape?: "rounded" | "circle";
  aspectRatio?: number;
  outputSize?: number;
  outputWidth?: number;
  outputHeight?: number;
  onCancel: () => void;
  onConfirm: (croppedFile: File) => void | Promise<void>;
}

export function ImageCropperModal({
  file,
  title = "Ajustar & Recortar Imagem",
  subtitle = "Arraste para posicionar e use o zoom para enquadrar em 1:1",
  shape = "rounded",
  aspectRatio = 1,
  outputSize = 512,
  outputWidth,
  outputHeight,
  onCancel,
  onConfirm,
}: ImageCropperModalProps) {
  const safeAspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1;
  const resolvedOutW = outputWidth ?? outputSize;
  const resolvedOutH =
    outputHeight ?? Math.max(64, Math.round(resolvedOutW / safeAspect));

  const maxVpW = safeAspect > 1.2 ? 420 : 280;
  const viewportW =
    typeof window !== "undefined"
      ? Math.max(220, Math.min(maxVpW, window.innerWidth - 72))
      : maxVpW;
  const viewportH = Math.max(96, Math.round(viewportW / safeAspect));

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragStartRef = useRef<{
    pointerX: number;
    pointerY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    if (!file) {
      setImageUrl(null);
      setNaturalSize(null);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setError(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setNaturalSize(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setError(null);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const computeBaseScale = useCallback(
    (size: { w: number; h: number }) => {
      return Math.max(viewportW / size.w, viewportH / size.h);
    },
    [viewportW, viewportH],
  );

  const clampOffset = useCallback(
    (
      nextX: number,
      nextY: number,
      targetZoom: number,
      size: { w: number; h: number } | null,
    ) => {
      if (!size) return { x: 0, y: 0 };
      const baseScale = computeBaseScale(size);
      const drawW = size.w * baseScale * targetZoom;
      const drawH = size.h * baseScale * targetZoom;
      const maxX = Math.max(0, (drawW - viewportW) / 2);
      const maxY = Math.max(0, (drawH - viewportH) / 2);
      return {
        x: Math.max(-maxX, Math.min(maxX, nextX)),
        y: Math.max(-maxY, Math.min(maxY, nextY)),
      };
    },
    [computeBaseScale, viewportW, viewportH],
  );

  const handleZoomChange = (nextZoom: number) => {
    const clampedZoom = Math.max(1, Math.min(3, nextZoom));
    setZoom(clampedZoom);
    setOffset((prev) => clampOffset(prev.x, prev.y, clampedZoom, naturalSize));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!naturalSize) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      originX: offset.x,
      originY: offset.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !dragStartRef.current || !naturalSize) return;
    const dx = e.clientX - dragStartRef.current.pointerX;
    const dy = e.clientY - dragStartRef.current.pointerY;
    setOffset(
      clampOffset(
        dragStartRef.current.originX + dx,
        dragStartRef.current.originY + dy,
        zoom,
        naturalSize,
      ),
    );
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore if pointer capture already released
      }
      setDragging(false);
      dragStartRef.current = null;
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const step = e.deltaY < 0 ? 0.1 : -0.1;
    handleZoomChange(zoom + step);
  };

  const handleApplyCrop = async () => {
    if (!file || !imgRef.current || !naturalSize) return;
    setProcessing(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = resolvedOutW;
      canvas.height = resolvedOutH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Não foi possível inicializar o canvas de recorte.");
      }

      const baseScale = computeBaseScale(naturalSize);
      const drawW = naturalSize.w * baseScale * zoom;
      const drawH = naturalSize.h * baseScale * zoom;
      const ratioX = resolvedOutW / viewportW;
      const ratioY = resolvedOutH / viewportH;

      const destW = drawW * ratioX;
      const destH = drawH * ratioY;
      const destX = (resolvedOutW - destW) / 2 + offset.x * ratioX;
      const destY = (resolvedOutH - destH) / 2 + offset.y * ratioY;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(imgRef.current, destX, destY, destW, destH);

      const exportBlob = async (mime: string, quality?: number) =>
        new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), mime, quality),
        );

      let blob = await exportBlob("image/webp", 0.92);
      let ext = "webp";
      let mime = "image/webp";
      if (!blob || blob.type !== "image/webp") {
        blob = await exportBlob("image/png");
        ext = "png";
        mime = "image/png";
      }
      if (!blob) {
        throw new Error("Falha ao exportar a imagem recortada.");
      }

      const baseName = file.name.replace(/\.[^.]+$/, "") || "cropped-image";
      const croppedFile = new File([blob], `${baseName}.${ext}`, {
        type: mime,
      });

      await onConfirm(croppedFile);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  };

  const handleUseOriginalGif = async () => {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      await onConfirm(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessing(false);
    }
  };

  const baseScale = naturalSize ? computeBaseScale(naturalSize) : 1;
  const drawW = naturalSize ? naturalSize.w * baseScale * zoom : viewportW;
  const drawH = naturalSize ? naturalSize.h * baseScale * zoom : viewportH;
  const isAnimatedGif = file?.type === "image/gif";

  return (
    <Modal
      open={Boolean(file)}
      onOpenChange={(open) => {
        if (!open && !processing) onCancel();
      }}
      overlayZIndexClass="z-[90]"
      contentClassName={`w-[94vw] ${
        safeAspect > 1.2 ? "max-w-xl" : "max-w-md"
      } rounded-2xl bg-[#101014] hairline-box shadow-2xl p-5 space-y-4 select-none`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-0.5 min-w-0">
          <Dialog.Title className="text-sm font-semibold text-[#FAFAFA] flex items-center gap-2">
            <Crop className="w-4 h-4 text-[#EF4444]" strokeWidth={1.75} />
            <span className="truncate">{title}</span>
          </Dialog.Title>
          <Dialog.Description className="text-[11px] text-[#A1A1AA]">
            {subtitle}
          </Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <button
            type="button"
            disabled={processing}
            className="p-1.5 rounded-lg bg-[#16161C] hairline-box text-[#A1A1AA] hover:text-[#FAFAFA]"
            aria-label="Fechar editor de recorte"
          >
            <X className="w-4 h-4" strokeWidth={1.5} />
          </button>
        </Dialog.Close>
      </div>

      {/* Área Interativa de Recorte 1:1 */}
      <div className="flex flex-col items-center gap-3">
        <div
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
          className={`relative overflow-hidden bg-[#09090B] hairline-box touch-none ${
            dragging ? "cursor-grabbing" : "cursor-grab"
          } ${shape === "circle" ? "rounded-full" : "rounded-2xl"}`}
          style={{
            width: `${viewportW}px`,
            height: `${viewportH}px`,
            boxShadow: "0 0 0 1px rgba(185, 28, 28, 0.35), 0 12px 32px rgba(0, 0, 0, 0.55)",
          }}
        >
          {imageUrl && (
            <img
              ref={imgRef}
              src={imageUrl}
              alt="Recorte"
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNaturalSize({
                  w: img.naturalWidth || 512,
                  h: img.naturalHeight || 512,
                });
              }}
              className="absolute top-1/2 left-1/2 max-w-none pointer-events-none select-none"
              style={{
                width: `${drawW}px`,
                height: `${drawH}px`,
                transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)`,
              }}
            />
          )}

          {/* Guias de Regra dos Terços sutis */}
          <div className="pointer-events-none absolute inset-0 grid grid-cols-3 grid-rows-3 opacity-35">
            <div className="border-r border-b border-white/20" />
            <div className="border-r border-b border-white/20" />
            <div className="border-b border-white/20" />
            <div className="border-r border-b border-white/20" />
            <div className="border-r border-b border-white/20" />
            <div className="border-b border-white/20" />
            <div className="border-r border-white/20" />
            <div className="border-r border-white/20" />
            <div />
          </div>

          <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full scoped-glass font-mono text-[10px] text-[#FAFAFA] flex items-center gap-1 opacity-90">
            <Move className="w-3 h-3 text-[#EF4444]" strokeWidth={1.5} />
            <span>Arraste para enquadrar</span>
          </div>
        </div>

        {/* Controle de Zoom */}
        <div className="w-full px-1 space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-[#A1A1AA] flex items-center gap-1.5">
              <ZoomIn className="w-3.5 h-3.5 text-[#EF4444]" strokeWidth={1.5} />
              Zoom
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[#FAFAFA]">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => {
                  setZoom(1);
                  setOffset({ x: 0, y: 0 });
                }}
                className="px-1.5 py-0.5 rounded bg-[#16161C] hover:bg-[#1E1E26] hairline-box font-mono text-[10px] text-[#A1A1AA] hover:text-[#FAFAFA] flex items-center gap-1"
              >
                <RotateCcw className="w-2.5 h-2.5" strokeWidth={1.5} />
                Reset
              </button>
            </div>
          </div>

          <Slider.Root
            className="relative flex items-center select-none touch-none w-full h-5"
            value={[Math.round(zoom * 100)]}
            min={100}
            max={300}
            step={2}
            onValueChange={(vals) => handleZoomChange((vals[0] ?? 100) / 100)}
          >
            <Slider.Track className="bg-[#09090B] relative grow rounded-full h-1.5 hairline-box">
              <Slider.Range className="absolute bg-[#B91C1C] rounded-full h-full" />
            </Slider.Track>
            <Slider.Thumb
              className="block w-4 h-4 bg-[#FAFAFA] border border-[#B91C1C] rounded-full shadow focus:outline-none"
              aria-label="Zoom da imagem"
            />
          </Slider.Root>
        </div>
      </div>

      {error && (
        <div className="p-2.5 rounded-xl bg-[#1E1E26] border border-[#F87171]/30 text-xs text-[#F87171]">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 hairline-t">
        {isAnimatedGif ? (
          <button
            type="button"
            disabled={processing}
            onClick={() => void handleUseOriginalGif()}
            className="min-h-[38px] px-3 py-1.5 rounded-xl bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[11px] text-[#FAFAFA] flex items-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5 text-[#EF4444]" strokeWidth={1.5} />
            <span>Usar GIF Animado</span>
          </button>
        ) : (
          <span className="font-mono text-[10px] text-[#71717A]">
            Saída {resolvedOutW}×{resolvedOutH}px
          </span>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            disabled={processing}
            onClick={onCancel}
            className="min-h-[38px] px-3.5 py-2 rounded-xl bg-[#16161C] hairline-box text-xs text-[#A1A1AA] hover:text-[#FAFAFA]"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={processing || !naturalSize}
            onClick={() => void handleApplyCrop()}
            className="min-h-[38px] px-4 py-2 rounded-xl btn-crimson-vivid disabled:opacity-50 text-xs font-medium text-[#FAFAFA] flex items-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5" strokeWidth={1.75} />
            <span>{processing ? "Exportando..." : "Aplicar Recorte"}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
