import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        obsidian: {
          base: "#09090B",
          sidebar: "#101014",
          stage: "#16161C",
          elevated: "#1E1E26",
        },
        crimson: {
          DEFAULT: "#B91C1C",
          hover: "#991B1B",
          live: "#7F1D1D",
          border: "#EF4444",
          soft: "#F87171",
        },
      },
      fontFamily: {
        sans: ["Inter", "Geist", "system-ui", "-apple-system", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderColor: {
        hairline: "rgba(255, 255, 255, 0.07)",
      },
      boxShadow: {
        "crimson-glow": "0 0 40px -8px rgba(185, 28, 28, 0.35)",
        "sticker": "0 4px 14px rgba(0, 0, 0, 0.65), 0 0 0 2px rgba(255, 255, 255, 0.92)",
      },
    },
  },
  plugins: [],
};

export default config;
