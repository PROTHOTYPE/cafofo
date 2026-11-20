import { useSyncExternalStore } from "react";
import type { GameCatalogRow } from "@cafofo/core-logic";
import {
  extractExeIcon,
  isTauriRuntime,
  listRunningProcesses,
  type KnownGameEntry,
} from "./tauri";

const CUSTOM_GAMES_STORAGE_KEY = "cafofo:custom-games:v1";
const GAME_ICONS_STORAGE_KEY = "cafofo:game-icons:v1";

const KNOWN_COMPOUND_TITLES: Record<string, string> = {
  eldenring: "Elden Ring",
  darksouls: "Dark Souls",
  darksoulsii: "Dark Souls II",
  darksoulsiii: "Dark Souls III",
  helldivers2: "Helldivers 2",
  cyberpunk2077: "Cyberpunk 2077",
  baldursgate3: "Baldur's Gate 3",
  bg3: "Baldur's Gate 3",
  cs2: "Counter-Strike 2",
  gtav: "GTA V",
  gta5: "GTA V",
  leagueoflegends: "League of Legends",
  "valorant-win64-shipping": "Valorant",
  minecraft: "Minecraft",
  javaw: "Minecraft (Java)",
};

export function extractExeFilename(filePathOrName: string): string {
  const trimmed = filePathOrName.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

export function normalizeExeKey(exeOrPath: string): string {
  return extractExeFilename(exeOrPath).toLowerCase();
}

export function suggestFriendlyGameName(filePathOrName: string): string {
  const filename = extractExeFilename(filePathOrName);
  if (!filename) return "";
  const stem = filename.replace(/\.exe$/i, "").trim();
  if (!stem) return "";

  const lowerStem = stem.toLowerCase();
  if (KNOWN_COMPOUND_TITLES[lowerStem]) {
    return KNOWN_COMPOUND_TITLES[lowerStem];
  }

  const spaced = stem
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d+)/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!spaced) return stem;

  return spaced
    .split(" ")
    .map((word) => {
      if (!word) return "";
      if (/^[0-9]+$/.test(word)) return word;
      if (word.length <= 2 && word === word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

export function formatGameElapsedHMS(
  startedAtMs: number | null | undefined,
  nowMs: number,
): string {
  if (!startedAtMs) return "00:00:00";
  const totalSec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function loadSavedCustomGames(): KnownGameEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(CUSTOM_GAMES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is KnownGameEntry =>
          Boolean(
            item &&
              typeof item === "object" &&
              typeof (item as KnownGameEntry).game_id === "string" &&
              typeof (item as KnownGameEntry).name === "string" &&
              Array.isArray((item as KnownGameEntry).executables),
          ),
      )
      .map((item) => ({ ...item, is_custom: true }));
  } catch {
    return [];
  }
}

export function saveCustomGamesToStorage(entries: KnownGameEntry[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CUSTOM_GAMES_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore quota errors cleanly
  }
}

function loadIconMap(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(GAME_ICONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

let iconSnapshot: Record<string, string> = loadIconMap();
const iconListeners = new Set<() => void>();
const pendingExtractions = new Set<string>();

function persistAndNotifyIcons(next: Record<string, string>): void {
  iconSnapshot = next;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(GAME_ICONS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota errors cleanly
    }
  }
  for (const listener of iconListeners) {
    listener();
  }
}

export function useGameIcons(): Record<string, string> {
  return useSyncExternalStore(
    (listener) => {
      iconListeners.add(listener);
      return () => iconListeners.delete(listener);
    },
    () => iconSnapshot,
    () => iconSnapshot,
  );
}

export function cacheGameIcon(params: {
  gameId?: string | null;
  exeName?: string | null;
  iconDataUrl?: string | null;
}): void {
  const icon = params.iconDataUrl?.trim();
  if (!icon) return;

  const next = { ...iconSnapshot };
  let changed = false;

  if (params.exeName) {
    const exeKey = `exe:${normalizeExeKey(params.exeName)}`;
    if (next[exeKey] !== icon) {
      next[exeKey] = icon;
      changed = true;
    }
  }
  if (params.gameId) {
    const idKey = `id:${params.gameId}`;
    if (next[idKey] !== icon) {
      next[idKey] = icon;
      changed = true;
    }
  }

  if (changed) {
    persistAndNotifyIcons(next);
  }
}

export function resolveGameIconUrl(params: {
  icons?: Record<string, string>;
  gameId?: string | null;
  processName?: string | null;
  executables?: string[];
  gameCatalog?: GameCatalogRow[];
}): string | null {
  const map = params.icons ?? iconSnapshot;

  if (params.gameId && map[`id:${params.gameId}`]) {
    return map[`id:${params.gameId}`];
  }
  if (params.processName) {
    const exeKey = `exe:${normalizeExeKey(params.processName)}`;
    if (map[exeKey]) {
      return map[exeKey];
    }
  }
  if (params.executables) {
    for (const exe of params.executables) {
      const exeKey = `exe:${normalizeExeKey(exe)}`;
      if (map[exeKey]) {
        return map[exeKey];
      }
    }
  }
  if (params.gameCatalog && (params.gameId || params.processName)) {
    const procKey = params.processName
      ? normalizeExeKey(params.processName)
      : null;
    const match = params.gameCatalog.find(
      (g) =>
        (params.gameId && g.id === params.gameId) ||
        (procKey && g.executables.some((e) => normalizeExeKey(e) === procKey)),
    );
    if (match) {
      if (match.icon_url) return match.icon_url;
      if (map[`id:${match.id}`]) return map[`id:${match.id}`];
      for (const exe of match.executables) {
        const exeKey = `exe:${normalizeExeKey(exe)}`;
        if (map[exeKey]) return map[exeKey];
      }
    }
  }

  return null;
}

export async function ensureGameIconExtracted(params: {
  gameId?: string | null;
  processName?: string | null;
  exePath?: string | null;
}): Promise<string | null> {
  if (!isTauriRuntime()) return null;

  const existing = resolveGameIconUrl({
    gameId: params.gameId,
    processName: params.processName,
  });
  if (existing) return existing;

  const exeKey = params.processName
    ? normalizeExeKey(params.processName)
    : params.exePath
      ? normalizeExeKey(params.exePath)
      : "";
  const dedupeKey = `${params.gameId ?? ""}|${exeKey}`;
  if (pendingExtractions.has(dedupeKey)) return null;
  pendingExtractions.add(dedupeKey);

  try {
    let targetPath = params.exePath ?? null;
    if (!targetPath && exeKey) {
      const running = await listRunningProcesses().catch(() => []);
      const found = running.find(
        (p) =>
          p.executable_path &&
          (normalizeExeKey(p.name) === exeKey ||
            normalizeExeKey(p.executable_path) === exeKey),
      );
      targetPath = found?.executable_path ?? null;
    }

    if (!targetPath) return null;
    const dataUrl = await extractExeIcon(targetPath).catch(() => null);
    if (dataUrl) {
      cacheGameIcon({
        gameId: params.gameId,
        exeName: params.processName ?? extractExeFilename(targetPath),
        iconDataUrl: dataUrl,
      });
      return dataUrl;
    }
    return null;
  } finally {
    pendingExtractions.delete(dedupeKey);
  }
}
