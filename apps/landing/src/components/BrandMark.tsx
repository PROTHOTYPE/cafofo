interface BrandMarkProps {
  size?: "sm" | "md" | "lg";
}

export function BrandMark({ size = "md" }: BrandMarkProps) {
  const boxSize =
    size === "sm"
      ? "w-8 h-8 rounded-xl"
      : size === "lg"
        ? "w-12 h-12 rounded-2xl"
        : "w-9 h-9 rounded-xl";

  return (
    <img
      src="/logo-icon.png"
      alt="Cafofo"
      className={`${boxSize} object-cover shadow-crimson-glow border border-[#EF4444]/35 shrink-0`}
    />
  );
}
