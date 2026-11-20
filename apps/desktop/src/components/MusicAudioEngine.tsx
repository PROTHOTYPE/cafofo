import { useEffect, useRef } from "react";
import { useMusicStore, useVoiceStore } from "@cafofo/core-logic";

export const UNLOCK_MUSIC_AUDIO_EVENT = "cafofo:unlock-music-audio";

export function MusicAudioEngine() {
  const boundRoomId = useMusicStore((s) => s.boundRoomId);
  const current = useMusicStore((s) => s.current);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const seekNonce = useMusicStore((s) => s.seekNonce);
  const retryNonce = useMusicStore((s) => s.retryNonce);
  const volume = useMusicStore((s) => s.volume);
  const getStreamUrl = useMusicStore((s) => s.getStreamUrl);
  const getEstimatedPositionSec = useMusicStore(
    (s) => s.getEstimatedPositionSec,
  );
  const setPlaybackMetrics = useMusicStore((s) => s.setPlaybackMetrics);
  const skipTrack = useMusicStore((s) => s.skipTrack);
  const deafened = useVoiceStore((s) => s.deafened);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const loadedTrackKeyRef = useRef<string | null>(null);
  const pendingSeekAppliedRef = useRef(false);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ensureAudioElement = (): HTMLAudioElement => {
    if (!audioRef.current) {
      const el = new Audio();
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      audioRef.current = el;
    }
    return audioRef.current;
  };

  // Só ativa GainNode (Web Audio) quando o usuário explicitamente pede ganho > 100%,
  // evitando que um AudioContext suspenso silencie o <audio> nativo em 0%-100%.
  const maybeAttachBoostGraph = (el: HTMLAudioElement, targetGain: number) => {
    if (gainNodeRef.current && audioCtxRef.current) {
      if (audioCtxRef.current.state === "suspended") {
        void audioCtxRef.current.resume().catch(() => {});
      }
      try {
        gainNodeRef.current.gain.setTargetAtTime(
          targetGain,
          audioCtxRef.current.currentTime,
          0.02,
        );
      } catch {
        gainNodeRef.current.gain.value = targetGain;
      }
      el.volume = 1;
      el.muted = deafened || targetGain === 0;
      return true;
    }

    if (targetGain > 1.01 && typeof window !== "undefined") {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (Ctx) {
        try {
          const ctx = new Ctx();
          // Apenas acopla se o AudioContext já pôde rodar (gesto do usuário ativo)
          if (ctx.state === "running") {
            const source = ctx.createMediaElementSource(el);
            const gain = ctx.createGain();
            gain.gain.value = targetGain;
            source.connect(gain);
            gain.connect(ctx.destination);
            audioCtxRef.current = ctx;
            gainNodeRef.current = gain;
            el.volume = 1;
            el.muted = deafened;
            return true;
          }
          void ctx.close().catch(() => {});
        } catch {
          // Mantém volume nativo 0-100%
        }
      }
    }

    el.volume = Math.max(0, Math.min(1, targetGain));
    el.muted = deafened || targetGain === 0;
    return false;
  };

  // Aplica volume (0%-100% nativo, >100%-200% com GainNode) e estado deafen ao vivo
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const target = deafened ? 0 : Math.max(0, Math.min(2, volume / 100));
    maybeAttachBoostGraph(el, target);
  }, [volume, deafened, current?.track_uid, isPlaying]);

  // Desbloqueio síncrono de áudio ao clicar/teclar ou ao apertar "Ativar Som"
  useEffect(() => {
    const tryPlayNow = () => {
      if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
        void audioCtxRef.current.resume().catch(() => {});
      }
      const el = audioRef.current;
      const state = useMusicStore.getState();
      if (
        el &&
        el.src &&
        state.boundRoomId &&
        state.current &&
        state.isPlaying &&
        (el.paused || state.playbackStatus === "autoplay_blocked")
      ) {
        const targetPos = state.getEstimatedPositionSec();
        if (
          Number.isFinite(el.duration) &&
          el.duration > 1 &&
          Math.abs(el.currentTime - targetPos) > 2
        ) {
          try {
            el.currentTime = Math.min(el.duration - 0.5, Math.max(0, targetPos));
          } catch {
            // ignore seek before ready
          }
        }
        void el
          .play()
          .then(() => {
            useMusicStore.getState().setPlaybackMetrics({
              status: "playing",
              error: null,
            });
          })
          .catch(() => {});
      }
    };

    window.addEventListener(UNLOCK_MUSIC_AUDIO_EVENT, tryPlayNow);
    window.addEventListener("pointerdown", tryPlayNow, { passive: true });
    window.addEventListener("keydown", tryPlayNow, { passive: true });
    return () => {
      window.removeEventListener(UNLOCK_MUSIC_AUDIO_EVENT, tryPlayNow);
      window.removeEventListener("pointerdown", tryPlayNow);
      window.removeEventListener("keydown", tryPlayNow);
    };
  }, []);

  // Carrega a faixa apenas quando mudar sala, track_uid ou retryNonce (NUNCA ao adicionar item na fila)
  useEffect(() => {
    const el = ensureAudioElement();
    const targetVol = deafened ? 0 : Math.max(0, Math.min(2, volume / 100));
    maybeAttachBoostGraph(el, targetVol);

    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    if (!boundRoomId || !current) {
      loadedTrackKeyRef.current = null;
      pendingSeekAppliedRef.current = false;
      el.pause();
      el.onloadedmetadata = null;
      el.oncanplay = null;
      el.onplaying = null;
      el.onwaiting = null;
      el.ontimeupdate = null;
      el.onended = null;
      el.onerror = null;
      if (el.src) {
        el.removeAttribute("src");
        el.load();
      }
      setPlaybackMetrics({ status: "idle", positionSec: 0, durationSec: 0 });
      return;
    }

    const trackKey = `${boundRoomId}:${current.track_uid}:${retryNonce}`;
    if (loadedTrackKeyRef.current === trackKey) {
      return;
    }

    loadedTrackKeyRef.current = trackKey;
    pendingSeekAppliedRef.current = false;
    retryCountRef.current = 0;

    const loadAndPlay = () => {
      const streamUrl = getStreamUrl(current.video_id);
      setPlaybackMetrics({
        status: useMusicStore.getState().isPlaying ? "buffering" : "paused",
        error: null,
      });

      const applyInitialSeek = () => {
        if (pendingSeekAppliedRef.current) return;
        if (!Number.isFinite(el.duration) || el.duration <= 0) return;
        pendingSeekAppliedRef.current = true;
        const est = getEstimatedPositionSec();
        setPlaybackMetrics({ durationSec: el.duration });
        if (est >= 1 && est < el.duration - 1) {
          try {
            el.currentTime = est;
          } catch {
            // ignore seek error
          }
        }
      };

      el.onloadedmetadata = () => {
        applyInitialSeek();
      };

      el.oncanplay = () => {
        applyInitialSeek();
        if (useMusicStore.getState().isPlaying && el.paused) {
          void el.play().catch((err) => {
            if (err && (err as { name?: string }).name === "NotAllowedError") {
              setPlaybackMetrics({
                status: "autoplay_blocked",
                error: null,
              });
            }
          });
        }
      };

      el.onplaying = () => {
        retryCountRef.current = 0;
        setPlaybackMetrics({
          status: "playing",
          positionSec: el.currentTime,
          durationSec: Number.isFinite(el.duration) ? el.duration : undefined,
          error: null,
        });
      };

      el.onwaiting = () => {
        if (useMusicStore.getState().isPlaying) {
          setPlaybackMetrics({ status: "buffering" });
        }
      };

      el.ontimeupdate = () => {
        if (!el.paused) {
          setPlaybackMetrics({
            positionSec: el.currentTime,
            durationSec: Number.isFinite(el.duration) ? el.duration : undefined,
          });
        }
      };

      el.onerror = () => {
        const latest = useMusicStore.getState();
        if (
          latest.boundRoomId !== boundRoomId ||
          latest.current?.track_uid !== current.track_uid
        ) {
          return;
        }
        if (retryCountRef.current < 2) {
          retryCountRef.current += 1;
          setPlaybackMetrics({
            status: "buffering",
            error: null,
          });
          retryTimerRef.current = setTimeout(() => {
            el.src = `${streamUrl}?r=${retryCountRef.current}`;
            el.load();
            if (useMusicStore.getState().isPlaying) {
              void el.play().catch(() => {});
            }
          }, 2500);
        } else {
          setPlaybackMetrics({
            status: "error",
            error:
              "Não foi possível carregar o áudio desta faixa. Clique em Tentar novamente ou pule para a próxima.",
          });
        }
      };

      el.onended = () => {
        const latest = useMusicStore.getState();
        if (
          latest.boundRoomId === boundRoomId &&
          latest.current?.track_uid === current.track_uid &&
          latest.isPlaying
        ) {
          const jitter = 250 + Math.floor(Math.random() * 550);
          setTimeout(() => {
            const check = useMusicStore.getState();
            if (
              check.boundRoomId === boundRoomId &&
              check.current?.track_uid === current.track_uid &&
              check.isPlaying
            ) {
              void skipTrack();
            }
          }, jitter);
        }
      };

      el.src = streamUrl;
      el.load();

      if (useMusicStore.getState().isPlaying) {
        void el.play().catch((err) => {
          if (err && (err as { name?: string }).name === "NotAllowedError") {
            setPlaybackMetrics({
              status: "autoplay_blocked",
              error: null,
            });
          }
        });
      }
    };

    loadAndPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundRoomId, current?.track_uid, retryNonce]);

  // Play / Pause sem recarregar o arquivo de áudio
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !boundRoomId || !current || !el.src) return;

    if (!isPlaying) {
      el.pause();
      setPlaybackMetrics({ status: "paused" });
      return;
    }

    if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
      void audioCtxRef.current.resume().catch(() => {});
    }

    const est = getEstimatedPositionSec();
    if (
      Number.isFinite(el.duration) &&
      el.duration > 1 &&
      Math.abs(el.currentTime - est) > 2.5
    ) {
      try {
        el.currentTime = Math.min(el.duration - 0.5, Math.max(0, est));
      } catch {
        // ignore seek error before metadata
      }
    }

    if (el.paused) {
      void el.play().catch((err) => {
        if (err && (err as { name?: string }).name === "NotAllowedError") {
          setPlaybackMetrics({
            status: "autoplay_blocked",
            error: null,
          });
        }
      });
    }
  }, [
    boundRoomId,
    current,
    isPlaying,
    getEstimatedPositionSec,
    setPlaybackMetrics,
  ]);

  // Seek instantâneo (quando alguém arrasta/clica na barra de progresso)
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !boundRoomId || !current || seekNonce === 0) return;
    if (!Number.isFinite(el.duration) || el.duration <= 0) return;

    const target = getEstimatedPositionSec();
    const clamped = Math.min(el.duration - 0.5, Math.max(0, target));
    if (Math.abs(el.currentTime - clamped) > 0.75) {
      try {
        el.currentTime = clamped;
        setPlaybackMetrics({ positionSec: clamped });
      } catch {
        // ignore
      }
    }
  }, [seekNonce, boundRoomId, current, getEstimatedPositionSec, setPlaybackMetrics]);

  // Limpeza ao desmontar
  useEffect(() => {
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
      }
      if (audioCtxRef.current) {
        void audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, []);

  return null;
}
