import { useEffect } from "react";
import {
  useFriendsStore,
  usePresenceStore,
  useVoiceStore,
} from "@cafofo/core-logic";
import { Phone, PhoneIncoming, PhoneOff } from "lucide-react";
import { playIncomingCallRingtone } from "../lib/soundEffects";

interface IncomingCallOverlayProps {
  onAcceptedDm?: (dmChannelId: string) => void;
}

export function IncomingCallOverlay({
  onAcceptedDm,
}: IncomingCallOverlayProps) {
  const incomingCall = useFriendsStore((s) => s.incomingCall);
  const outgoingCall = useFriendsStore((s) => s.outgoingCall);
  const acceptIncomingCall = useFriendsStore((s) => s.acceptIncomingCall);
  const declineIncomingCall = useFriendsStore((s) => s.declineIncomingCall);
  const cancelOutgoingCall = useFriendsStore((s) => s.cancelOutgoingCall);

  const localStatus = usePresenceStore((s) => s.localStatus);
  const deafened = useVoiceStore((s) => s.deafened);

  const incomingCallId = incomingCall?.callId ?? null;

  useEffect(() => {
    if (!incomingCallId) return;
    if (localStatus === "dnd" || deafened) return;

    playIncomingCallRingtone();
    const interval = setInterval(() => {
      const currStatus = usePresenceStore.getState().localStatus;
      const currDeafened = useVoiceStore.getState().deafened;
      if (currStatus !== "dnd" && !currDeafened) {
        playIncomingCallRingtone();
      }
    }, 2600);

    return () => clearInterval(interval);
  }, [incomingCallId, localStatus, deafened]);

  if (!incomingCall && !outgoingCall) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[88] flex flex-col items-center gap-2.5 w-[min(370px,calc(100vw-24px))] pointer-events-none">
      {incomingCall && (
        <div className="pointer-events-auto w-full scoped-glass animated-gradient-border rounded-2xl p-4 shadow-[0_18px_48px_rgba(0,0,0,0.75)] animate-cyber-slide space-y-3">
          <div className="flex items-center gap-3">
            <div className="relative shrink-0">
              <div
                className="w-12 h-12 rounded-2xl bg-[#16161C] border border-white/15 flex items-center justify-center text-sm font-bold overflow-hidden animate-radar-pulse-crimson"
                style={{ color: incomingCall.callerAccentColor }}
              >
                {incomingCall.callerAvatarUrl ? (
                  <img
                    src={incomingCall.callerAvatarUrl}
                    alt={incomingCall.callerName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  incomingCall.callerName.slice(0, 2).toUpperCase()
                )}
              </div>
              <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 border-2 border-[#101014] flex items-center justify-center">
                <PhoneIncoming className="w-2.5 h-2.5 text-white" strokeWidth={2.2} />
              </span>
            </div>

            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                <span>CHAMADA PRIVADA 1:1</span>
              </div>
              <div className="text-sm font-semibold text-[#FAFAFA] truncate">
                {incomingCall.callerName}
              </div>
              <div className="text-[11px] text-[#A1A1AA]">
                Está ligando para você agora...
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void declineIncomingCall()}
              className="min-h-[40px] px-3 py-2 rounded-xl btn-non-destructive-active text-xs font-medium flex items-center justify-center gap-1.5 hover:opacity-90 transition-opacity"
            >
              <PhoneOff className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span>Recusar</span>
            </button>
            <button
              type="button"
              onClick={async () => {
                const dmId = await acceptIncomingCall();
                if (dmId && onAcceptedDm) {
                  onAcceptedDm(dmId);
                }
              }}
              className="min-h-[40px] px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shadow-[0_0_20px_rgba(16,185,129,0.4)] transition-all"
            >
              <Phone className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span>Atender</span>
            </button>
          </div>
        </div>
      )}

      {outgoingCall && (
        <div className="pointer-events-auto w-full scoped-glass rounded-2xl px-4 py-3 border border-[#B91C1C]/50 shadow-[0_14px_36px_rgba(0,0,0,0.65)] animate-cyber-slide flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-[#16161C] hairline-box flex items-center justify-center text-xs font-bold text-[#EF4444] overflow-hidden shrink-0 animate-pulse">
              {outgoingCall.calleeAvatarUrl ? (
                <img
                  src={outgoingCall.calleeAvatarUrl}
                  alt={outgoingCall.calleeName}
                  className="w-full h-full object-cover"
                />
              ) : (
                outgoingCall.calleeName.slice(0, 2).toUpperCase()
              )}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#FAFAFA] truncate">
                {outgoingCall.calleeName}
              </div>
              <div className="font-mono text-[10px] text-[#A1A1AA]">
                {outgoingCall.status === "ringing"
                  ? "CHAMANDO EM 1:1..."
                  : outgoingCall.status === "declined"
                    ? "CHAMADA RECUSADA"
                    : "SEM RESPOSTA"}
              </div>
            </div>
          </div>

          {outgoingCall.status === "ringing" && (
            <button
              type="button"
              onClick={() => void cancelOutgoingCall()}
              className="min-h-[34px] px-3 py-1.5 rounded-xl btn-non-destructive-active text-xs font-medium flex items-center gap-1.5 shrink-0"
            >
              <PhoneOff className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span>Cancelar</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
