import { useCallback, useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isTauriRuntime } from "./tauri";

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "installing"
  | "error";

export interface AppUpdaterState {
  supported: boolean;
  status: AppUpdateStatus;
  availableVersion: string | null;
  releaseNotes: string | null;
  progress: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  dismissed: boolean;
  checkForUpdates: (options?: { silent?: boolean }) => Promise<void>;
  installAndRelaunch: () => Promise<void>;
  dismiss: () => void;
}

export function useAppUpdater(): AppUpdaterState {
  const supported = isTauriRuntime();
  const [status, setStatus] = useState<AppUpdateStatus>("idle");
  const [availableVersion, setAvailableVersion] = useState<string | null>(null);
  const [releaseNotes, setReleaseNotes] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const updateRef = useRef<Update | null>(null);
  const checkingRef = useRef(false);
  const installingRef = useRef(false);

  const checkForUpdates = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (!supported || checkingRef.current || installingRef.current) return;

      checkingRef.current = true;
      setError(null);
      if (!silent) {
        setStatus("checking");
      }

      try {
        const update = await check();
        if (update) {
          updateRef.current = update;
          setAvailableVersion(update.version);
          setReleaseNotes(update.body?.trim() || null);
          setDismissed(false);
          setStatus("available");
        } else {
          updateRef.current = null;
          setAvailableVersion(null);
          setReleaseNotes(null);
          setStatus(silent ? "idle" : "up-to-date");
        }
      } catch (err) {
        if (silent) {
          // Falha silenciosa na inicialização (ex: offline ou endpoint ainda sem release)
          setStatus("idle");
        } else {
          const message =
            err instanceof Error
              ? err.message
              : "Não foi possível verificar atualizações.";
          setError(message);
          setStatus("error");
        }
      } finally {
        checkingRef.current = false;
      }
    },
    [supported],
  );

  const installAndRelaunch = useCallback(async () => {
    const update = updateRef.current;
    if (!supported || !update || installingRef.current) return;

    installingRef.current = true;
    setError(null);
    setStatus("downloading");
    setProgress(0);
    setDownloadedBytes(0);
    setTotalBytes(null);

    let received = 0;
    let total: number | null = null;

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setTotalBytes(total);
          setDownloadedBytes(0);
          setProgress(total ? 0 : null);
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          setDownloadedBytes(received);
          if (total && total > 0) {
            setProgress(Math.min(100, Math.round((received / total) * 100)));
          }
        } else if (event.event === "Finished") {
          setProgress(100);
          setStatus("installing");
        }
      });

      setStatus("installing");
      await relaunch();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Falha ao baixar ou instalar atualização.";
      setError(message);
      setStatus("available");
    } finally {
      installingRef.current = false;
    }
  }, [supported]);

  const dismiss = useCallback(() => {
    if (installingRef.current) return;
    setDismissed(true);
  }, []);

  useEffect(() => {
    if (!supported) return;
    void checkForUpdates({ silent: true });
  }, [supported, checkForUpdates]);

  return {
    supported,
    status,
    availableVersion,
    releaseNotes,
    progress,
    downloadedBytes,
    totalBytes,
    error,
    dismissed,
    checkForUpdates,
    installAndRelaunch,
    dismiss,
  };
}
