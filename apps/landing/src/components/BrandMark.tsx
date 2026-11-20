import { AudioWaveform } from "lucide-react";

interface BrandMarkProps {
  size?: "sm" | "md" | "lg";
}

/**
 * Ícone base do Cafofo.
 * Quando a ilustração oficial ficar pronta, basta substituir o conteúdo
 * deste componente por um <img> ou <svg>.
 */
export function BrandMark({ size = "md" }: BrandMarkProps) {
  const boxSize =
    size === "sm"
      ? "w-8 h-8 rounded-xl"
      : size === "lg"
        ? "w-12 h-12 rounded-2xl"
        : "w-9 h-9 rounded-xl";

  const iconSize =
    size === "sm" ? "w-4 h-4" : size === "lg" ? "w-6 h-6" : "w-5 h-5";

  return (
    <div
      className={`${boxSize} bg-[#B91C1C] flex items-center justify-center shadow-crimson-glow border border-[#F87171]/30 shrink-0`}
    >
      <AudioWaveform className={`${iconSize} text-[#FAFAFA]`} strokeWidth={1.85} />
    </div>
  );
}
