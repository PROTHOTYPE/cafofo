import { useEffect, useState, type FormEvent } from "react";
import * as Slider from "@radix-ui/react-slider";
import {
  useMusicStore,
  useVoiceStore,
  type MusicSearchResult,
} from "@cafofo/core-logic";
import {
  Disc3,
  ListMusic,
  Loader2,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  SkipForward,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { UNLOCK_MUSIC_AUDIO_EVENT } from "./MusicAudioEngine";

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "--:--";
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
  }
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

export function MusicBotPanel() {
  const activeVoiceChannelId = useVoiceStore((s) => s.activeVoiceChannelId);
  const activeVoiceChannelName = useVoiceStore((s) => s.activeVoiceChannelName);

  const current = useMusicStore((s) => s.current);
  const queue = useMusicStore((s) => s.queue);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const volume = useMusicStore((s) => s.volume);
  const playbackStatus = useMusicStore((s) => s.playbackStatus);
  const actualPositionSec = useMusicStore((s) => s.actualPositionSec);
  const actualDurationSec = useMusicStore((s) => s.actualDurationSec);
  const searchResults = useMusicStore((s) => s.searchResults);
  const searching = useMusicStore((s) => s.searching);
  const loadingAction = useMusicStore((s) => s.loadingAction);
  const error = useMusicStore((s) => s.error);

  const searchYouTube = useMusicStore((s) => s.searchYouTube);
  const clearSearch = useMusicStore((s) => s.clearSearch);
  const enqueueTrack = useMusicStore((s) => s.enqueueTrack);
  const togglePlayPause = useMusicStore((s) => s.togglePlayPause);
  const skipTrack = useMusicStore((s) => s.skipTrack);
  const seekTo = useMusicStore((s) => s.seekTo);
  const removeFromQueue = useMusicStore((s) => s.removeFromQueue);
  const clearQueue = useMusicStore((s) => s.clearQueue);
  const setVolume = useMusicStore((s) => s.setVolume);
  const retryPlayback = useMusicStore((s) => s.retryPlayback);
  const getEstimatedPositionSec = useMusicStore(
    (s) => s.getEstimatedPositionSec,
  );

  const [query, setQuery] = useState("");
  const [draggingSeekSec, setDraggingSeekSec] = useState<number | null>(null);
  const [fallbackElapsedSec, setFallbackElapsedSec] = useState(0);

  useEffect(() => {
    if (!current) {
      setFallbackElapsedSec(0);
      setDraggingSeekSec(null);
      return;
    }
    setFallbackElapsedSec(getEstimatedPositionSec());
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setFallbackElapsedSec(getEstimatedPositionSec());
    }, 1000);
    return () => clearInterval(id);
  }, [current, isPlaying, getEstimatedPositionSec]);

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    try {
      const results = await searchYouTube(query);
      const looksLikeUrl = /youtube\.com|youtu\.be/i.test(query);
      if (looksLikeUrl && results.length === 1 && activeVoiceChannelId) {
        await enqueueTrack(results[0]);
        setQuery("");
        clearSearch();
      }
    } catch {
      // error state handled by store
    }
  };

  const handleAddResult = async (item: MusicSearchResult) => {
    try {
      await enqueueTrack(item);
      setQuery("");
      clearSearch();
    } catch {
      // error handled by store
    }
  };

  const totalDurationSec =
    actualDurationSec > 0 ? actualDurationSec : (current?.duration_sec ?? 0);
  const displayedPositionSec =
    draggingSeekSec !== null
      ? draggingSeekSec
      : playbackStatus === "playing" || actualPositionSec > 0
        ? actualPositionSec
        : fallbackElapsedSec;
  const clampedPositionSec =
    totalDurationSec > 0
      ? Math.min(totalDurationSec, Math.max(0, displayedPositionSec))
      : Math.max(0, displayedPositionSec);

  return (
    <div className="p-2.5 xl:p-3 bg-[#09090B] hairline-t space-y-2.5 select-none">
      {/* Cabeçalho do Bot de Música */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-[#FAFAFA] min-w-0">
          <Disc3
            className={`w-3.5 h-3.5 text-[#EF4444] shrink-0 ${
              playbackStatus === "playing" && current ? "animate-spin" : ""
            }`}
            style={{ animationDuration: "3.5s" }}
            strokeWidth={1.75}
          />
          <span className="truncate">Bot de Música</span>
        </div>
        {activeVoiceChannelName ? (
          <span className="px-1.5 py-0.5 rounded bg-[#16161C] hairline-box font-mono text-[9px] text-[#A1A1AA] truncate max-w-[100px]">
            {activeVoiceChannelName}
          </span>
        ) : (
          <span className="font-mono text-[9px] text-[#71717A]">SEM CALL</span>
        )}
      </div>

      {!activeVoiceChannelId ? (
        <div className="p-2.5 rounded-xl bg-[#101014] hairline-box text-[11px] text-[#71717A] flex items-center gap-2">
          <Music
            className="w-3.5 h-3.5 text-[#71717A] shrink-0"
            strokeWidth={1.5}
          />
          <span>
            Entre em uma sala de voz para tocar músicas do YouTube em grupo.
          </span>
        </div>
      ) : (
        <>
          {/* Busca por nome ou link do YouTube */}
          <form onSubmit={handleSearch} className="flex items-center gap-1.5">
            <div className="relative flex-1 min-w-0">
              <Search
                className="w-3 h-3 text-[#71717A] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                strokeWidth={1.5}
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar ou colar link YouTube..."
                className="w-full pl-7 pr-6 py-1.5 rounded-lg bg-[#101014] hairline-box text-[11px] text-[#FAFAFA] placeholder:text-[#71717A] focus:outline-none focus:border-[#B91C1C]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    clearSearch();
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[#71717A] hover:text-[#FAFAFA]"
                  aria-label="Limpar busca"
                >
                  <X className="w-3 h-3" strokeWidth={1.5} />
                </button>
              )}
            </div>
            <button
              type="submit"
              disabled={searching || !query.trim()}
              className="min-h-[30px] px-2.5 py-1 rounded-lg btn-crimson-vivid disabled:opacity-40 text-[11px] font-medium text-white flex items-center justify-center shrink-0"
              title="Buscar no YouTube"
            >
              {searching ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
              ) : (
                <Search className="w-3.5 h-3.5" strokeWidth={1.75} />
              )}
            </button>
          </form>

          {playbackStatus === "autoplay_blocked" && current && (
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new Event(UNLOCK_MUSIC_AUDIO_EVENT))
              }
              className="w-full py-1.5 px-2.5 rounded-lg btn-crimson-vivid text-[11px] font-medium text-white flex items-center justify-center gap-1.5"
            >
              <Volume2 className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span>Clique para Ativar Áudio da Música</span>
            </button>
          )}

          {error && (
            <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#1E1E26] border border-[#F87171]/30">
              <p className="text-[10px] font-mono text-[#F87171] leading-snug min-w-0">
                {error}
              </p>
              {current && (
                <button
                  type="button"
                  onClick={() => retryPlayback()}
                  className="px-2 py-1 rounded bg-[#16161C] hover:bg-[#09090B] hairline-box text-[10px] font-mono text-[#FAFAFA] flex items-center gap-1 shrink-0"
                  title="Tentar carregar o áudio novamente"
                >
                  <RefreshCw className="w-2.5 h-2.5 text-[#EF4444]" strokeWidth={1.75} />
                  <span>Tentar</span>
                </button>
              )}
            </div>
          )}

          {/* Resultados da Busca YouTube */}
          {searchResults.length > 0 && (
            <div className="space-y-1 max-h-40 overflow-y-auto pr-0.5 animate-cyber-slide">
              <div className="flex items-center justify-between text-[9px] font-mono uppercase tracking-wider text-[#71717A]">
                <span>Resultados YouTube</span>
                <button
                  type="button"
                  onClick={clearSearch}
                  className="hover:text-[#FAFAFA]"
                >
                  Fechar
                </button>
              </div>
              {searchResults.map((item) => (
                <div
                  key={item.video_id}
                  className="p-1.5 rounded-lg bg-[#101014] hover:bg-[#16161C] hairline-box flex items-center gap-2 transition-colors"
                >
                  <img
                    src={item.thumbnail_url}
                    alt=""
                    className="w-9 h-7 rounded object-cover bg-black shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-medium text-[#FAFAFA] truncate">
                      {item.title}
                    </div>
                    <div className="text-[9px] font-mono text-[#71717A] truncate">
                      {item.author} • {formatDuration(item.duration_sec)}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={loadingAction}
                    onClick={() => void handleAddResult(item)}
                    className="p-1.5 rounded-md bg-[#B91C1C] hover:bg-[#991B1B] text-white shrink-0"
                    title="Adicionar à fila"
                    aria-label="Adicionar à fila"
                  >
                    <Plus className="w-3 h-3" strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Card "Tocando Agora" */}
          {current && (
            <div className="p-2.5 rounded-xl bg-[#101014] animated-gradient-border space-y-2 animate-cyber-slide">
              <div className="flex items-center gap-2">
                <img
                  src={current.thumbnail_url}
                  alt={current.title}
                  className="w-10 h-10 rounded-lg object-cover bg-black shrink-0 hairline-box"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-[#FAFAFA] truncate">
                    {current.title}
                  </div>
                  <div className="text-[10px] text-[#A1A1AA] truncate">
                    {current.author}
                  </div>
                  <div className="flex items-center gap-1.5 text-[9px] font-mono text-[#71717A] truncate">
                    <span className="truncate">
                      Por {current.requested_by_name}
                    </span>
                    {playbackStatus === "buffering" && (
                      <span className="inline-flex items-center gap-1 text-amber-400 shrink-0">
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        CARREGANDO
                      </span>
                    )}
                    {playbackStatus === "playing" && (
                      <span className="inline-flex items-center gap-1 text-emerald-400 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        TOCANDO
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Barra de Progresso Interativa (clicar ou arrastar para avançar/voltar a música) */}
              <div className="space-y-1">
                <Slider.Root
                  className="relative flex items-center select-none touch-none w-full h-4 cursor-pointer group"
                  value={[clampedPositionSec]}
                  min={0}
                  max={Math.max(1, totalDurationSec)}
                  step={1}
                  disabled={totalDurationSec <= 0}
                  onValueChange={(vals) => {
                    const next = vals[0];
                    if (typeof next === "number") {
                      setDraggingSeekSec(next);
                    }
                  }}
                  onValueCommit={(vals) => {
                    const next = vals[0];
                    setDraggingSeekSec(null);
                    if (typeof next === "number" && totalDurationSec > 0) {
                      void seekTo(next);
                    }
                  }}
                >
                  <Slider.Track className="bg-[#16161C] relative grow rounded-full h-1.5 overflow-hidden">
                    <Slider.Range className="absolute bg-gradient-to-r from-[#B91C1C] to-[#EF4444] rounded-full h-full" />
                  </Slider.Track>
                  <Slider.Thumb
                    className="block w-3 h-3 bg-[#FAFAFA] border border-[#EF4444] rounded-full shadow focus:outline-none opacity-90 group-hover:scale-110 transition-transform"
                    aria-label="Posição da música"
                  />
                </Slider.Root>
                <div className="flex items-center justify-between font-mono text-[9px] text-[#71717A]">
                  <span>{formatDuration(clampedPositionSec)}</span>
                  <span>{formatDuration(totalDurationSec)}</span>
                </div>
              </div>

              {/* Controles Play / Pause / Passar / Parar + Volume */}
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={loadingAction}
                    onClick={() => void togglePlayPause()}
                    className="min-h-[30px] px-2 py-1 rounded-lg btn-crimson-vivid text-white text-[11px] font-medium flex items-center gap-1"
                    title={isPlaying ? "Pausar" : "Continuar"}
                  >
                    {isPlaying ? (
                      <Pause
                        className="w-3 h-3 fill-current"
                        strokeWidth={1.75}
                      />
                    ) : (
                      <Play
                        className="w-3 h-3 fill-current"
                        strokeWidth={1.75}
                      />
                    )}
                    <span>{isPlaying ? "Pausar" : "Tocar"}</span>
                  </button>

                  <button
                    type="button"
                    disabled={loadingAction}
                    onClick={() => void skipTrack()}
                    className="min-h-[30px] p-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#FAFAFA]"
                    title="Passar para a próxima música"
                    aria-label="Passar para a próxima música"
                  >
                    <SkipForward className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </button>

                  <button
                    type="button"
                    disabled={loadingAction}
                    onClick={() => void clearQueue()}
                    className="min-h-[30px] p-1.5 rounded-lg bg-[#16161C] hover:bg-[#1E1E26] hairline-box text-[#F87171]"
                    title="Parar e limpar fila"
                    aria-label="Parar e limpar fila"
                  >
                    <Square className="w-3 h-3 fill-current" strokeWidth={1.5} />
                  </button>
                </div>

                {/* Volume Dedicado do Bot (0%-200%) */}
                <div className="flex items-center gap-1.5 flex-1 min-w-[84px] max-w-[116px]">
                  <Volume2
                    className="w-3.5 h-3.5 text-[#A1A1AA] shrink-0"
                    strokeWidth={1.5}
                  />
                  <Slider.Root
                    className="relative flex items-center select-none touch-none flex-1 h-4"
                    value={[volume]}
                    min={0}
                    max={200}
                    step={2}
                    onValueChange={(vals) => setVolume(vals[0] ?? 65)}
                  >
                    <Slider.Track className="bg-[#16161C] relative grow rounded-full h-1">
                      <Slider.Range className="absolute bg-[#EF4444] rounded-full h-full" />
                    </Slider.Track>
                    <Slider.Thumb
                      className="block w-3 h-3 bg-[#FAFAFA] border border-[#EF4444] rounded-full focus:outline-none"
                      aria-label="Volume do Bot de Música"
                    />
                  </Slider.Root>
                  <span className="font-mono text-[9px] text-[#A1A1AA] w-7 text-right shrink-0">
                    {volume}%
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Fila de Reprodução */}
          {queue.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[9px] font-mono uppercase tracking-wider text-[#71717A]">
                <span className="flex items-center gap-1">
                  <ListMusic
                    className="w-3 h-3 text-[#EF4444]"
                    strokeWidth={1.5}
                  />
                  Próximas na fila ({queue.length})
                </span>
              </div>
              <div className="space-y-1 max-h-28 overflow-y-auto pr-0.5">
                {queue.map((track, idx) => (
                  <div
                    key={track.track_uid}
                    className="px-2 py-1 rounded-lg bg-[#101014] hairline-box flex items-center gap-2 text-[11px]"
                  >
                    <span className="font-mono text-[9px] text-[#71717A] w-3 shrink-0">
                      {idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[#FAFAFA] truncate leading-tight">
                        {track.title}
                      </div>
                      <div className="text-[9px] font-mono text-[#71717A] truncate">
                        {track.requested_by_name} •{" "}
                        {formatDuration(track.duration_sec)}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={loadingAction}
                      onClick={() => void removeFromQueue(track.track_uid)}
                      className="p-1 rounded hover:bg-[#1E1E26] text-[#71717A] hover:text-[#F87171] shrink-0"
                      title="Remover da fila"
                      aria-label="Remover da fila"
                    >
                      <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
