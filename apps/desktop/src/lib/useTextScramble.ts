import { useEffect, useState } from "react";

const SCRAMBLE_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/#*+-=";

/**
 * Micro-animação de decodificação de texto (06-animacao-status-pioneer.mp4)
 * Usada quando uma transmissão ao vivo inicia ou muda de status.
 */
export function useTextScramble(targetText: string, active = true, durationMs = 520): string {
  const [display, setDisplay] = useState(targetText);

  useEffect(() => {
    if (!active || !targetText) {
      setDisplay(targetText);
      return;
    }

    const totalFrames = Math.max(8, Math.floor(durationMs / 28));
    let frame = 0;

    const timer = setInterval(() => {
      frame += 1;
      const progress = frame / totalFrames;
      const revealedCount = Math.floor(progress * targetText.length);

      let next = "";
      for (let i = 0; i < targetText.length; i += 1) {
        const ch = targetText[i];
        if (ch === " ") {
          next += " ";
        } else if (i < revealedCount) {
          next += ch;
        } else {
          const randomIndex = Math.floor(Math.random() * SCRAMBLE_GLYPHS.length);
          next += SCRAMBLE_GLYPHS[randomIndex];
        }
      }

      setDisplay(next);

      if (frame >= totalFrames) {
        setDisplay(targetText);
        clearInterval(timer);
      }
    }, 28);

    return () => clearInterval(timer);
  }, [targetText, active, durationMs]);

  return display;
}
