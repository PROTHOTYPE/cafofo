import {
  createClient,
  type SupabaseClient,
  type SupabaseClientOptions,
} from "@supabase/supabase-js";
import { readEnvVar } from "../env";
import type { Database } from "./types";

export type CafofoSupabaseClient = SupabaseClient<Database>;

export interface CreateSupabaseClientConfig {
  url: string;
  publishableKey: string;
  options?: SupabaseClientOptions<"public">;
}

/**
 * Reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from Vite's
 * `import.meta.env` (or `process.env` when running outside Vite).
 */
export function readSupabaseEnvConfig(): {
  url: string;
  publishableKey: string;
} {
  const url = readEnvVar("VITE_SUPABASE_URL") ?? "";
  const publishableKey = readEnvVar("VITE_SUPABASE_PUBLISHABLE_KEY") ?? "";

  return { url, publishableKey };
}

/**
 * Creates a typed Supabase client configured for the Cafofo schema.
 */
export function createCafofoSupabaseClient(
  config: CreateSupabaseClientConfig,
): CafofoSupabaseClient {
  if (!config.url) {
    throw new Error("Supabase URL is required (VITE_SUPABASE_URL)");
  }
  if (!config.publishableKey) {
    throw new Error(
      "Supabase publishable key is required (VITE_SUPABASE_PUBLISHABLE_KEY)",
    );
  }

  return createClient<Database>(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      ...config.options?.auth,
    },
    ...config.options,
  });
}

/**
 * Convenience factory using `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
 */
export function createCafofoSupabaseFromEnv(
  options?: SupabaseClientOptions<"public">,
): CafofoSupabaseClient {
  const { url, publishableKey } = readSupabaseEnvConfig();
  return createCafofoSupabaseClient({ url, publishableKey, options });
}
