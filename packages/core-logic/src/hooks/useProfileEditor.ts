import { useCallback, useEffect, useState } from "react";
import type { ProfileMediaBucket, ProfileIdentityEditableFields } from "../services/profileService";
import { useAuthStore } from "../stores/useAuthStore";
import type { ProfileRow } from "../supabase/types";

function profileToDraft(profile: ProfileRow | null): ProfileIdentityEditableFields {
  return {
    display_name: profile?.display_name ?? "",
    bio: profile?.bio ?? "",
    custom_status_text: profile?.custom_status_text ?? profile?.custom_status ?? "",
    custom_status_emoji: profile?.custom_status_emoji ?? "",
    banner_color: profile?.banner_color ?? "#7F1D1D",
    banner_gradient: profile?.banner_gradient ?? null,
    card_bg_color: profile?.card_bg_color ?? "#101014",
    card_accent_color: profile?.card_accent_color ?? "#B91C1C",
    card_text_color: profile?.card_text_color ?? "#FAFAFA",
    card_border_color: profile?.card_border_color ?? "#27272A",
    custom_badge_text: profile?.custom_badge_text ?? "",
    custom_badge_color: profile?.custom_badge_color ?? "#B91C1C",
    avatar_frame: profile?.avatar_frame ?? "none",
    card_theme: profile?.card_theme ?? "default",
    entry_sound_volume: profile?.entry_sound_volume ?? 0.75,
  };
}

/**
 * Stateful editor hook for "Identidade Cafofo" profile fields and validated
 * media uploads (`avatars`, `banners`, `entrance-sounds`).
 */
export function useProfileEditor() {
  const profile = useAuthStore((s) => s.profile);
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const uploadMedia = useAuthStore((s) => s.uploadProfileMedia);

  const [draft, setDraft] = useState<ProfileIdentityEditableFields>(() =>
    profileToDraft(profile),
  );
  const [saving, setSaving] = useState(false);
  const [uploadingBucket, setUploadingBucket] =
    useState<ProfileMediaBucket | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(profileToDraft(profile));
  }, [profile]);

  const setField = useCallback(
    <K extends keyof ProfileIdentityEditableFields>(
      key: K,
      value: ProfileIdentityEditableFields[K],
    ) => {
      setError(null);
      setDraft((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const reset = useCallback(() => {
    setError(null);
    setDraft(profileToDraft(profile));
  }, [profile]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateProfile(draft);
      setDraft(profileToDraft(updated));
      return updated;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [draft, updateProfile]);

  const handleUpload = useCallback(
    async (bucket: ProfileMediaBucket, file: File) => {
      setUploadingBucket(bucket);
      setError(null);
      try {
        return await uploadMedia(bucket, file);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err;
      } finally {
        setUploadingBucket(null);
      }
    },
    [uploadMedia],
  );

  return {
    profile,
    draft,
    saving,
    uploadingBucket,
    error,
    setField,
    reset,
    save,
    uploadAvatar: (file: File) => handleUpload("avatars", file),
    uploadBanner: (file: File) => handleUpload("banners", file),
    uploadEntrySound: (file: File) => handleUpload("entrance-sounds", file),
  };
}
