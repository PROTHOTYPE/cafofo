import type { RealtimeChannel } from "@supabase/supabase-js";
import { create } from "zustand";
import type { Json } from "../supabase/types";
import { getSupabaseClientOrThrow, useAuthStore } from "./useAuthStore";
import { useVoiceStore } from "./useVoiceStore";

const MUSIC_VOLUME_STORAGE_KEY = "cafofo:music-volume:v1";
const MAX_QUEUE_LEN = 50;

export type MusicPlaybackStatus =
  | "idle"
  | "buffering"
  | "playing"
  | "paused"
  | "autoplay_blocked"
  | "error";

export interface MusicSearchResult {
  video_id: string;
  title: string;
  author: string;
  duration_sec: number;
  thumbnail_url: string;
  url: string;
}

export interface MusicTrack {
  track_uid: string;
  video_id: string;
  title: string;
  author: string;
  duration_sec: number;
  thumbnail_url: string;
  url: string;
  requested_by_id: string;
  requested_by_name: string;
}

export interface MusicRoomSnapshot {
  room_id: string;
  current: MusicTrack | null;
  queue: MusicTrack[];
  is_playing: boolean;
  started_at_ms: number;
  paused_offset_sec: number;
  server_now_ms: number;
  version: number;
}

interface RoomMusicRow {
  room_id: string;
  current_track: MusicTrack | null;
  queue: MusicTrack[] | null;
  is_playing: boolean;
  started_at_ms: number | string;
  paused_offset_sec: number;
  version: number | string;
}

function loadMusicVolume(): number {
  if (typeof localStorage === "undefined") return 65;
  try {
    const raw = localStorage.getItem(MUSIC_VOLUME_STORAGE_KEY);
    if (!raw) return 65;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 65;
    return Math.max(0, Math.min(200, Math.round(parsed)));
  } catch {
    return 65;
  }
}

function saveMusicVolume(vol: number): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(MUSIC_VOLUME_STORAGE_KEY, String(vol));
  } catch {
    // ignore storage quota errors
  }
}

function generateTrackUid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `trk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function resolveMusicApiBaseUrl(signalingUrl?: string): string {
  const raw = (signalingUrl ?? useVoiceStore.getState().signalingUrl ?? "").trim();
  if (!raw) return "http://127.0.0.1:3001";
  try {
    const u = new URL(raw);
    const protocol =
      u.protocol === "wss:"
        ? "https:"
        : u.protocol === "ws:"
          ? "http:"
          : u.protocol;
    return `${protocol}//${u.host}`;
  } catch {
    return raw
      .replace(/^wss:/i, "https:")
      .replace(/^ws:/i, "http:")
      .replace(/\/ws\/?$/i, "");
  }
}

let activeMusicChannel: RealtimeChannel | null = null;
let activeMusicChannelRoomId: string | null = null;

async function musicApiFetch<T>(
  path: string,
  options?: { method?: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const token = useAuthStore.getState().session?.access_token;
  if (!token) {
    throw new Error("Faça login para usar o Bot de Música.");
  }
  const base = resolveMusicApiBaseUrl();
  const resp = await fetch(`${base}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options?.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!resp.ok) {
    let errText = `HTTP ${resp.status}`;
    try {
      const json = (await resp.json()) as { error?: string };
      if (json?.error) errText = json.error;
    } catch {
      // ignore json parse failure
    }
    throw new Error(errText);
  }
  return (await resp.json()) as T;
}

async function prepareVideoAudio(videoId: string): Promise<void> {
  const token = useAuthStore.getState().session?.access_token;
  if (!token || !videoId) return;
  const base = resolveMusicApiBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    await fetch(`${base}/api/music/prepare/${encodeURIComponent(videoId)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
  } catch {
    // Mesmo se falhar/timeout, deixa o <audio> tentar o stream direto
  } finally {
    clearTimeout(timer);
  }
}

function prewarmVideoAudio(videoId: string): void {
  void prepareVideoAudio(videoId);
}

function broadcastMusicSnapshot(snapshot: MusicRoomSnapshot): void {
  if (
    !activeMusicChannel ||
    activeMusicChannelRoomId !== snapshot.room_id ||
    activeMusicChannel.state !== "joined"
  ) {
    return;
  }
  void activeMusicChannel
    .send({
      type: "broadcast",
      event: "music_state_sync",
      payload: snapshot as unknown as Record<string, unknown>,
    })
    .catch(() => {});
}

function rowToSnapshot(row: RoomMusicRow): MusicRoomSnapshot {
  return {
    room_id: row.room_id,
    current: row.current_track ?? null,
    queue: Array.isArray(row.queue) ? row.queue : [],
    is_playing: Boolean(row.is_playing),
    started_at_ms: Number(row.started_at_ms) || 0,
    paused_offset_sec: Number(row.paused_offset_sec) || 0,
    server_now_ms: Date.now(),
    version: Number(row.version) || 1,
  };
}

function advanceExpiredTracks(snap: MusicRoomSnapshot): {
  snapshot: MusicRoomSnapshot;
  changed: boolean;
} {
  let current = snap.current;
  let queue = [...snap.queue];
  let isPlaying = snap.is_playing;
  let startedAtMs = snap.started_at_ms;
  let pausedOffsetSec = snap.paused_offset_sec;
  let version = snap.version;
  let changed = false;

  const now = Date.now();
  while (isPlaying && current && current.duration_sec > 0) {
    const elapsedSec = Math.max(0, (now - startedAtMs) / 1000);
    if (elapsedSec < current.duration_sec + 4) {
      break;
    }
    changed = true;
    const next = queue.shift() ?? null;
    if (next) {
      const overflowMs = Math.min(
        2000,
        Math.max(0, Math.round((elapsedSec - current.duration_sec) * 1000)),
      );
      current = next;
      startedAtMs = now - overflowMs;
      pausedOffsetSec = 0;
      version += 1;
    } else {
      current = null;
      isPlaying = false;
      startedAtMs = 0;
      pausedOffsetSec = 0;
      version += 1;
      break;
    }
  }

  return {
    changed,
    snapshot: {
      ...snap,
      current,
      queue,
      is_playing: isPlaying,
      started_at_ms: startedAtMs,
      paused_offset_sec: pausedOffsetSec,
      server_now_ms: now,
      version,
    },
  };
}

async function persistRoomSnapshot(snapshot: MusicRoomSnapshot): Promise<void> {
  const supabase = getSupabaseClientOrThrow();
  const userId = useAuthStore.getState().user?.id ?? null;
  const { error } = await supabase.from("room_music_state").upsert(
    {
      room_id: snapshot.room_id,
      current_track: snapshot.current as unknown as Json | null,
      queue: snapshot.queue as unknown as Json,
      is_playing: snapshot.is_playing,
      started_at_ms: Math.round(snapshot.started_at_ms),
      paused_offset_sec: snapshot.paused_offset_sec,
      version: snapshot.version,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "room_id" },
  );
  if (error) {
    throw new Error(error.message || "Falha ao salvar estado da fila de música.");
  }
}

interface MusicState {
  boundRoomId: string | null;
  current: MusicTrack | null;
  queue: MusicTrack[];
  isPlaying: boolean;
  startedAtMs: number;
  pausedOffsetSec: number;
  clockSkewMs: number;
  version: number;
  seekNonce: number;
  retryNonce: number;
  volume: number;
  playbackStatus: MusicPlaybackStatus;
  actualPositionSec: number;
  actualDurationSec: number;
  searchResults: MusicSearchResult[];
  searching: boolean;
  loadingAction: boolean;
  error: string | null;

  bindRoom: (roomId: string | null) => Promise<void>;
  applySnapshot: (snapshot: MusicRoomSnapshot, options?: { forceSeek?: boolean }) => void;
  refreshRoomState: () => Promise<void>;
  searchYouTube: (query: string) => Promise<MusicSearchResult[]>;
  clearSearch: () => void;
  enqueueTrack: (track: MusicSearchResult) => Promise<void>;
  togglePlayPause: () => Promise<void>;
  skipTrack: () => Promise<void>;
  seekTo: (targetSec: number) => Promise<void>;
  removeFromQueue: (trackUid: string) => Promise<void>;
  clearQueue: () => Promise<void>;
  setVolume: (volumePercent: number) => void;
  setPlaybackMetrics: (metrics: {
    status?: MusicPlaybackStatus;
    positionSec?: number;
    durationSec?: number;
    error?: string | null;
  }) => void;
  retryPlayback: () => void;
  getStreamUrl: (videoId: string) => string;
  getEstimatedPositionSec: () => number;
}

export const useMusicStore = create<MusicState>((set, get) => ({
  boundRoomId: null,
  current: null,
  queue: [],
  isPlaying: false,
  startedAtMs: 0,
  pausedOffsetSec: 0,
  clockSkewMs: 0,
  version: 0,
  seekNonce: 0,
  retryNonce: 0,
  volume: loadMusicVolume(),
  playbackStatus: "idle",
  actualPositionSec: 0,
  actualDurationSec: 0,
  searchResults: [],
  searching: false,
  loadingAction: false,
  error: null,

  applySnapshot: (snapshot, options) => {
    set((prev) => {
      if (prev.boundRoomId !== snapshot.room_id) return prev;
      if (snapshot.version < prev.version) return prev;
      const trackChanged =
        (prev.current?.track_uid ?? null) !== (snapshot.current?.track_uid ?? null);
      const startedChanged =
        !trackChanged &&
        snapshot.is_playing &&
        Math.abs(snapshot.started_at_ms - prev.startedAtMs) > 1500;
      const pausedSeekChanged =
        !trackChanged &&
        !snapshot.is_playing &&
        Math.abs(snapshot.paused_offset_sec - prev.pausedOffsetSec) > 1.0;

      const shouldSeek = Boolean(
        options?.forceSeek || startedChanged || pausedSeekChanged,
      );

      return {
        current: snapshot.current,
        queue: snapshot.queue,
        isPlaying: snapshot.is_playing,
        startedAtMs: snapshot.started_at_ms,
        pausedOffsetSec: snapshot.paused_offset_sec,
        clockSkewMs: 0,
        version: snapshot.version,
        seekNonce: shouldSeek ? prev.seekNonce + 1 : prev.seekNonce,
        playbackStatus: !snapshot.current
          ? "idle"
          : !snapshot.is_playing
            ? "paused"
            : trackChanged
              ? "buffering"
              : prev.playbackStatus,
        actualPositionSec: trackChanged
          ? 0
          : shouldSeek
            ? snapshot.is_playing
              ? Math.max(0, (Date.now() - snapshot.started_at_ms) / 1000)
              : snapshot.paused_offset_sec
            : prev.actualPositionSec,
        actualDurationSec: trackChanged
          ? snapshot.current?.duration_sec ?? 0
          : prev.actualDurationSec,
        error: trackChanged ? null : prev.error,
      };
    });

    if (snapshot.current?.video_id) {
      prewarmVideoAudio(snapshot.current.video_id);
    }
    if (snapshot.queue[0]?.video_id) {
      prewarmVideoAudio(snapshot.queue[0].video_id);
    }
  },

  bindRoom: async (roomId) => {
    if (get().boundRoomId === roomId) return;

    const prevCh = activeMusicChannel;
    activeMusicChannel = null;
    activeMusicChannelRoomId = null;

    if (prevCh) {
      try {
        const supabase = getSupabaseClientOrThrow();
        await supabase.removeChannel(prevCh).catch(() => {});
      } catch {
        // ignore
      }
    }

    set({
      boundRoomId: roomId,
      current: null,
      queue: [],
      isPlaying: false,
      startedAtMs: 0,
      pausedOffsetSec: 0,
      version: 0,
      seekNonce: 0,
      playbackStatus: "idle",
      actualPositionSec: 0,
      actualDurationSec: 0,
      error: null,
    });

    if (!roomId) return;

    try {
      const supabase = getSupabaseClientOrThrow();
      const ch = supabase
        .channel(`cafofo-music-room:${roomId}`, {
          config: { broadcast: { self: false, ack: false } },
        })
        .on("broadcast", { event: "music_state_sync" }, ({ payload }) => {
          const snap = payload as MusicRoomSnapshot | null;
          if (!snap || snap.room_id !== roomId) return;
          get().applySnapshot(snap);
        })
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "room_music_state",
            filter: `room_id=eq.${roomId}`,
          },
          (payload) => {
            const row = payload.new as RoomMusicRow | null;
            if (!row || row.room_id !== roomId) return;
            get().applySnapshot(rowToSnapshot(row));
          },
        );
      ch.subscribe();
      activeMusicChannel = ch;
      activeMusicChannelRoomId = roomId;
    } catch {
      // Realtime optional fallback
    }

    await get().refreshRoomState().catch(() => {});
  },

  refreshRoomState: async () => {
    const roomId = get().boundRoomId;
    if (!roomId) return;
    const supabase = getSupabaseClientOrThrow();
    const { data, error } = await supabase
      .from("room_music_state")
      .select(
        "room_id, current_track, queue, is_playing, started_at_ms, paused_offset_sec, version",
      )
      .eq("room_id", roomId)
      .maybeSingle();

    if (error || !data) return;

    const rawSnap = rowToSnapshot(data as RoomMusicRow);
    const { snapshot, changed } = advanceExpiredTracks(rawSnap);
    get().applySnapshot(snapshot);
    if (changed) {
      void persistRoomSnapshot(snapshot).catch(() => {});
      broadcastMusicSnapshot(snapshot);
    }
  },

  searchYouTube: async (query) => {
    const clean = query.trim();
    if (!clean) {
      set({ searchResults: [], error: null });
      return [];
    }
    set({ searching: true, error: null });
    try {
      const results = await musicApiFetch<MusicSearchResult[]>(
        `/api/music/search?q=${encodeURIComponent(clean)}`,
      );
      set({ searchResults: results });
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      throw err;
    } finally {
      set({ searching: false });
    }
  },

  clearSearch: () => {
    set({ searchResults: [], error: null });
  },

  enqueueTrack: async (track) => {
    const state = get();
    const roomId = state.boundRoomId;
    if (!roomId) {
      throw new Error("Entre em uma sala de voz antes de tocar música.");
    }
    const auth = useAuthStore.getState();
    const requesterId = auth.user?.id ?? "unknown";
    const requesterName =
      auth.profile?.display_name || auth.profile?.username || "Membro";

    const nextTrack: MusicTrack = {
      track_uid: generateTrackUid(),
      video_id: track.video_id,
      title: track.title.trim().slice(0, 160),
      author: track.author.trim().slice(0, 80),
      duration_sec: Math.max(0, Math.round(track.duration_sec || 0)),
      thumbnail_url: track.thumbnail_url,
      url: track.url,
      requested_by_id: requesterId,
      requested_by_name: requesterName.slice(0, 48),
    };

    const now = Date.now();
    const currentSnapshot: MusicRoomSnapshot = {
      room_id: roomId,
      current: state.current,
      queue: [...state.queue],
      is_playing: state.isPlaying,
      started_at_ms: state.startedAtMs,
      paused_offset_sec: state.pausedOffsetSec,
      server_now_ms: now,
      version: state.version,
    };

    const advanced = advanceExpiredTracks(currentSnapshot).snapshot;
    const startsImmediately = !advanced.current;
    if (!startsImmediately && advanced.queue.length >= MAX_QUEUE_LEN) {
      throw new Error(`Fila cheia (máximo de ${MAX_QUEUE_LEN} músicas).`);
    }

    set({ loadingAction: true, error: null });
    try {
      // Aguarda o áudio ficar pronto em cache no servidor ANTES de iniciar o
      // relógio (started_at_ms), garantindo que todos comecem exatamente do 0:00.
      if (startsImmediately) {
        await prepareVideoAudio(nextTrack.video_id);
      } else {
        prewarmVideoAudio(nextTrack.video_id);
      }

      const readyNow = Date.now();
      const latest = get();
      const nextSnapshot: MusicRoomSnapshot = startsImmediately
        ? {
            ...advanced,
            current: nextTrack,
            is_playing: true,
            started_at_ms: readyNow,
            paused_offset_sec: 0,
            server_now_ms: readyNow,
            version: Math.max(latest.version, advanced.version) + 1,
          }
        : {
            ...advanced,
            queue: [...advanced.queue, nextTrack],
            server_now_ms: readyNow,
            version: Math.max(latest.version, advanced.version) + 1,
          };

      get().applySnapshot(nextSnapshot, { forceSeek: startsImmediately });
      broadcastMusicSnapshot(nextSnapshot);
      await persistRoomSnapshot(nextSnapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({ error: msg });
      throw err;
    } finally {
      set({ loadingAction: false });
    }
  },

  togglePlayPause: async () => {
    const state = get();
    const roomId = state.boundRoomId;
    if (!roomId || !state.current) return;

    const now = Date.now();
    const curPos = state.getEstimatedPositionSec();
    const nextPlaying = !state.isPlaying;
    const nextSnapshot: MusicRoomSnapshot = {
      room_id: roomId,
      current: state.current,
      queue: state.queue,
      is_playing: nextPlaying,
      started_at_ms: nextPlaying
        ? Math.round(now - curPos * 1000)
        : state.startedAtMs,
      paused_offset_sec: nextPlaying ? state.pausedOffsetSec : curPos,
      server_now_ms: now,
      version: state.version + 1,
    };

    set({ loadingAction: true, error: null });
    try {
      get().applySnapshot(nextSnapshot);
      broadcastMusicSnapshot(nextSnapshot);
      await persistRoomSnapshot(nextSnapshot);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loadingAction: false });
    }
  },

  skipTrack: async () => {
    const state = get();
    const roomId = state.boundRoomId;
    if (!roomId) return;

    const nextQueue = [...state.queue];
    const nextTrack = nextQueue.shift() ?? null;

    set({ loadingAction: true, error: null });
    try {
      if (nextTrack) {
        await prepareVideoAudio(nextTrack.video_id);
      }
      const readyNow = Date.now();
      const nextSnapshot: MusicRoomSnapshot = {
        room_id: roomId,
        current: nextTrack,
        queue: nextQueue,
        is_playing: Boolean(nextTrack),
        started_at_ms: nextTrack ? readyNow : 0,
        paused_offset_sec: 0,
        server_now_ms: readyNow,
        version: get().version + 1,
      };

      get().applySnapshot(nextSnapshot, { forceSeek: true });
      broadcastMusicSnapshot(nextSnapshot);
      await persistRoomSnapshot(nextSnapshot);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loadingAction: false });
    }
  },

  seekTo: async (targetSec) => {
    const state = get();
    const roomId = state.boundRoomId;
    if (!roomId || !state.current) return;

    const maxDur = Math.max(
      state.actualDurationSec || 0,
      state.current.duration_sec || 0,
    );
    const clamped = Math.max(
      0,
      maxDur > 0 ? Math.min(maxDur - 0.5, targetSec) : targetSec,
    );
    const now = Date.now();
    const nextSnapshot: MusicRoomSnapshot = {
      room_id: roomId,
      current: state.current,
      queue: state.queue,
      is_playing: state.isPlaying,
      started_at_ms: state.isPlaying
        ? Math.round(now - clamped * 1000)
        : state.startedAtMs,
      paused_offset_sec: clamped,
      server_now_ms: now,
      version: state.version + 1,
    };

    set({ error: null });
    try {
      get().applySnapshot(nextSnapshot, { forceSeek: true });
      broadcastMusicSnapshot(nextSnapshot);
      await persistRoomSnapshot(nextSnapshot);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  removeFromQueue: async (trackUid) => {
    const state = get();
    const roomId = state.boundRoomId;
    if (!roomId) return;

    const nextQueue = state.queue.filter((t) => t.track_uid !== trackUid);
    if (nextQueue.length === state.queue.length) return;

    const now = Date.now();
    const nextSnapshot: MusicRoomSnapshot = {
      room_id: roomId,
      current: state.current,
      queue: nextQueue,
      is_playing: state.isPlaying,
      started_at_ms: state.startedAtMs,
      paused_offset_sec: state.pausedOffsetSec,
      server_now_ms: now,
      version: state.version + 1,
    };

    set({ loadingAction: true, error: null });
    try {
      get().applySnapshot(nextSnapshot);
      broadcastMusicSnapshot(nextSnapshot);
      await persistRoomSnapshot(nextSnapshot);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loadingAction: false });
    }
  },

  clearQueue: async () => {
    const state = get();
    const roomId = state.boundRoomId;
    if (!roomId) return;

    const now = Date.now();
    const nextSnapshot: MusicRoomSnapshot = {
      room_id: roomId,
      current: null,
      queue: [],
      is_playing: false,
      started_at_ms: 0,
      paused_offset_sec: 0,
      server_now_ms: now,
      version: state.version + 1,
    };

    set({ loadingAction: true, error: null });
    try {
      get().applySnapshot(nextSnapshot);
      broadcastMusicSnapshot(nextSnapshot);
      await persistRoomSnapshot(nextSnapshot);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ loadingAction: false });
    }
  },

  setVolume: (volumePercent) => {
    const clamped = Math.max(0, Math.min(200, Math.round(volumePercent)));
    saveMusicVolume(clamped);
    set({ volume: clamped });
  },

  setPlaybackMetrics: ({ status, positionSec, durationSec, error }) => {
    set((prev) => ({
      playbackStatus: status ?? prev.playbackStatus,
      actualPositionSec:
        positionSec !== undefined && Number.isFinite(positionSec)
          ? Math.max(0, positionSec)
          : prev.actualPositionSec,
      actualDurationSec:
        durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0
          ? durationSec
          : prev.actualDurationSec,
      error: error !== undefined ? error : prev.error,
    }));
  },

  retryPlayback: () => {
    set((prev) => ({
      retryNonce: prev.retryNonce + 1,
      playbackStatus: prev.current ? "buffering" : "idle",
      error: null,
    }));
  },

  getStreamUrl: (videoId) => {
    const base = resolveMusicApiBaseUrl();
    return `${base}/api/music/stream/${encodeURIComponent(videoId)}`;
  },

  getEstimatedPositionSec: () => {
    const s = get();
    if (!s.current) return 0;
    if (!s.isPlaying) return Math.max(0, s.pausedOffsetSec);
    const elapsed = Math.max(0, (Date.now() - s.startedAtMs) / 1000);
    const maxDur = s.actualDurationSec || s.current.duration_sec;
    if (maxDur > 0) {
      return Math.min(maxDur, elapsed);
    }
    return elapsed;
  },
}));

// Automatically bind/unbind music room state when user joins/switches/leaves voice channels
useVoiceStore.subscribe((voiceState, prevVoiceState) => {
  if (voiceState.activeVoiceChannelId !== prevVoiceState.activeVoiceChannelId) {
    void useMusicStore.getState().bindRoom(voiceState.activeVoiceChannelId);
  }
});
