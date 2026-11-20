type EnvRecord = Record<string, string | undefined>;

/**
 * Reads an environment variable from Vite's `import.meta.env` when available,
 * falling back to Node's `process.env` outside Vite bundles.
 */
export function readEnvVar(key: string): string | undefined {
  const metaEnv = (import.meta as ImportMeta & { env?: EnvRecord }).env;
  const procEnv =
    typeof globalThis !== "undefined" &&
    "process" in globalThis &&
    typeof (globalThis as { process?: { env?: EnvRecord } }).process?.env ===
      "object"
      ? (globalThis as { process?: { env?: EnvRecord } }).process?.env
      : undefined;

  return metaEnv?.[key] ?? procEnv?.[key];
}
