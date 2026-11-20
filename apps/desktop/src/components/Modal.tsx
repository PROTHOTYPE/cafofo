import { useEffect, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  contentClassName?: string;
  overlayZIndexClass?: string;
  ariaLabel?: string;
}

/**
 * Container de Modal centralizado de forma determinística via Flexbox (`fixed inset-0 flex items-center justify-center`).
 * Nunca depende de `left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2`, evitando que animações CSS `transform`
 * desloquem o modal para fora da viewport. Fecha com `Escape`, clique no backdrop ou evento `cafofo:reset-layout`.
 */
export function Modal({
  open,
  onOpenChange,
  children,
  contentClassName = "w-[92vw] max-w-md rounded-2xl bg-[#101014] hairline-box p-6 shadow-2xl",
  overlayZIndexClass = "z-[70]",
  ariaLabel,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
      }
    };
    const handleResetLayout = () => {
      onOpenChange(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("cafofo:reset-layout", handleResetLayout);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("cafofo:reset-layout", handleResetLayout);
    };
  }, [open, onOpenChange]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          onClick={() => onOpenChange(false)}
          className={`fixed inset-0 ${overlayZIndexClass} flex items-center justify-center p-3 sm:p-4 bg-black/70 backdrop-blur-sm overflow-y-auto`}
        >
          <Dialog.Content
            aria-label={ariaLabel}
            onClick={(e) => e.stopPropagation()}
            onEscapeKeyDown={() => onOpenChange(false)}
            onPointerDownOutside={() => onOpenChange(false)}
            className={`relative my-auto max-h-[90dvh] max-w-[95vw] focus:outline-none animate-modal-in ${contentClassName}`}
          >
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
