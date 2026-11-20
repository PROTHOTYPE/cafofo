import type { Session, User } from "@supabase/supabase-js";
import { create } from "zustand";
import {
  updateProfileIdentity,
  uploadProfileMedia,
  type ProfileIdentityEditableFields,
  type ProfileMediaBucket,
} from "../services/profileService";
import {
  createCafofoSupabaseFromEnv,
  type CafofoSupabaseClient,
} from "../supabase/client";
import type { PresenceStatus, ProfileRow } from "../supabase/types";

interface AuthState {
  supabase: CafofoSupabaseClient | null;
  session: Session | null;
  user: User | null;
  profile: ProfileRow | null;
  initialized: boolean;
  loading: boolean;
  error: string | null;

  initialize: (client?: CafofoSupabaseClient) => Promise<() => void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (params: {
    email: string;
    password: string;
    username: string;
    displayName: string;
  }) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<ProfileRow | null>;
  updateStatus: (status: PresenceStatus) => Promise<void>;
  updateProfile: (
    fields: Partial<ProfileIdentityEditableFields>,
  ) => Promise<ProfileRow>;
  uploadProfileMedia: (
    bucket: ProfileMediaBucket,
    file: File,
  ) => Promise<ProfileRow>;
}

export function getSupabaseClientOrThrow(): CafofoSupabaseClient {
  const client = useAuthStore.getState().supabase;
  if (!client) {
    throw new Error("Supabase client not initialized. Call useAuthStore.initialize() first.");
  }
  return client;
}

const PREFERRED_STATUS_STORAGE_KEY = "cafofo:preferred-status:v1";

type LocalProfileUpdatedListener = (profile: ProfileRow) => void;
const localProfileUpdatedListeners = new Set<LocalProfileUpdatedListener>();

export function onLocalProfileUpdated(
  listener: LocalProfileUpdatedListener,
): () => void {
  localProfileUpdatedListeners.add(listener);
  return () => {
    localProfileUpdatedListeners.delete(listener);
  };
}

function emitLocalProfileUpdated(profile: ProfileRow): void {
  for (const listener of localProfileUpdatedListeners) {
    try {
      listener(profile);
    } catch {
      // ignore listener errors
    }
  }
}

export function loadPreferredPresenceStatus(): PresenceStatus | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(PREFERRED_STATUS_STORAGE_KEY);
    if (raw === "online" || raw === "idle" || raw === "dnd" || raw === "offline") {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

export function savePreferredPresenceStatus(status: PresenceStatus): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PREFERRED_STATUS_STORAGE_KEY, status);
  } catch {
    // ignore storage errors
  }
}

function resolveInitialPresenceStatus(dbStatus?: PresenceStatus | null): PresenceStatus {
  const saved = loadPreferredPresenceStatus();
  if (saved) return saved;
  if (dbStatus === "idle" || dbStatus === "dnd" || dbStatus === "online") {
    return dbStatus;
  }
  return "online";
}

async function persistDbStatus(
  supabase: CafofoSupabaseClient,
  userId: string,
  status: PresenceStatus,
): Promise<void> {
  try {
    await supabase.from("profiles").update({ status }).eq("id", userId);
  } catch {
    // Non-fatal status sync failure
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  supabase: null,
  session: null,
  user: null,
  profile: null,
  initialized: false,
  loading: false,
  error: null,

  initialize: async (providedClient) => {
    set({ loading: true, error: null });
    try {
      const supabase = providedClient ?? get().supabase ?? createCafofoSupabaseFromEnv();
      set({ supabase });

      const { data, error } = await supabase.auth.getSession();
      if (error) {
        throw error;
      }

      const session = data.session;
      set({
        session,
        user: session?.user ?? null,
      });

      if (session?.access_token) {
        void supabase.realtime.setAuth(session.access_token);
      }

      if (session?.user) {
        const loadedProfile = await get().refreshProfile();
        const effectiveStatus = resolveInitialPresenceStatus(loadedProfile?.status);
        if (loadedProfile && loadedProfile.status !== effectiveStatus) {
          await persistDbStatus(supabase, session.user.id, effectiveStatus);
          set({ profile: { ...loadedProfile, status: effectiveStatus } });
        }
      }

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((event, nextSession) => {
        set({
          session: nextSession,
          user: nextSession?.user ?? null,
        });
        if (nextSession?.access_token) {
          void supabase.realtime.setAuth(nextSession.access_token);
        }
        if (nextSession?.user) {
          void get()
            .refreshProfile()
            .then((loadedProfile) => {
              if (event === "SIGNED_IN" && loadedProfile) {
                const effectiveStatus = resolveInitialPresenceStatus(
                  loadedProfile.status,
                );
                if (loadedProfile.status !== effectiveStatus) {
                  void persistDbStatus(supabase, nextSession.user.id, effectiveStatus);
                  set({ profile: { ...loadedProfile, status: effectiveStatus } });
                }
              }
            });
        } else {
          set({ profile: null });
        }
      });

      set({ initialized: true, loading: false });
      return () => {
        subscription.unsubscribe();
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message, initialized: true, loading: false });
      return () => {};
    }
  },

  signIn: async (email, password) => {
    const supabase = getSupabaseClientOrThrow();
    set({ loading: true, error: null });
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
      set({ session: data.session, user: data.user });
      if (data.user) {
        const loadedProfile = await get().refreshProfile();
        const effectiveStatus = resolveInitialPresenceStatus(loadedProfile?.status);
        if (loadedProfile && loadedProfile.status !== effectiveStatus) {
          await persistDbStatus(supabase, data.user.id, effectiveStatus);
          set({ profile: { ...loadedProfile, status: effectiveStatus } });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  signUp: async ({ email, password, username, displayName }) => {
    const supabase = getSupabaseClientOrThrow();
    set({ loading: true, error: null });
    try {
      const cleanUsername = username.trim();
      const cleanDisplay = displayName.trim() || cleanUsername;

      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            username: cleanUsername,
            display_name: cleanDisplay,
          },
        },
      });
      if (error) throw error;

      if (data.session && data.user) {
        await supabase.from("profiles").upsert({
          id: data.user.id,
          username: cleanUsername,
          display_name: cleanDisplay,
          status: "online",
        });
        set({ session: data.session, user: data.user });
        await get().refreshProfile();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  signOut: async () => {
    const supabase = getSupabaseClientOrThrow();
    set({ loading: true, error: null });
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      set({ session: null, user: null, profile: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    } finally {
      set({ loading: false });
    }
  },

  refreshProfile: async () => {
    const supabase = getSupabaseClientOrThrow();
    const user = get().user;
    if (!user) return null;

    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      set({ error: error.message });
      return null;
    }

    if (!data) {
      const fallbackName =
        (user.user_metadata?.username as string | undefined) ||
        user.email?.split("@")[0] ||
        `user_${user.id.slice(0, 6)}`;
      const { data: created, error: insertErr } = await supabase
        .from("profiles")
        .upsert({
          id: user.id,
          username: fallbackName,
          display_name:
            (user.user_metadata?.display_name as string | undefined) ||
            fallbackName,
          status: "online",
        })
        .select("*")
        .single();

      if (insertErr) {
        set({ error: insertErr.message });
        return null;
      }
      set({ profile: created });
      return created;
    }

    set({ profile: data });
    return data;
  },

  updateStatus: async (status) => {
    const supabase = getSupabaseClientOrThrow();
    const userId = get().user?.id;
    if (!userId) return;

    savePreferredPresenceStatus(status);
    set((prev) => ({
      profile: prev.profile ? { ...prev.profile, status } : prev.profile,
    }));

    const { data, error } = await supabase
      .from("profiles")
      .update({ status })
      .eq("id", userId)
      .select("*")
      .single();

    if (!error && data) {
      set({ profile: data });
      emitLocalProfileUpdated(data);
    }
  },

  updateProfile: async (fields) => {
    const supabase = getSupabaseClientOrThrow();
    const userId = get().user?.id;
    if (!userId) {
      throw new Error("Usuário não autenticado.");
    }
    const updated = await updateProfileIdentity(supabase, userId, fields);
    set({ profile: updated });
    emitLocalProfileUpdated(updated);
    return updated;
  },

  uploadProfileMedia: async (bucket, file) => {
    const supabase = getSupabaseClientOrThrow();
    const userId = get().user?.id;
    if (!userId) {
      throw new Error("Usuário não autenticado.");
    }
    const updated = await uploadProfileMedia(supabase, userId, bucket, file);
    set({ profile: updated });
    emitLocalProfileUpdated(updated);
    return updated;
  },
}));
