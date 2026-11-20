import type { CafofoSupabaseClient } from "../supabase/client";
import type {
  AvatarFrameStyle,
  ProfileCardTheme,
  ProfileRow,
  ProfileUpdate,
} from "../supabase/types";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
export const BANNER_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const ENTRY_SOUND_MAX_BYTES = 500 * 1024; // 500 KB (512_000 bytes)
export const ENTRY_SOUND_MAX_DURATION_SEC = 3.0;

export const ALLOWED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const ALLOWED_AUDIO_MIMES = [
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/mp4",
] as const;

export type ProfileMediaBucket = "avatars" | "banners" | "entrance-sounds";

export interface ProfileIdentityEditableFields {
  display_name: string;
  bio: string | null;
  custom_status_text: string | null;
  custom_status_emoji: string | null;
  banner_color: string | null;
  banner_gradient: string | null;
  card_bg_color: string | null;
  card_accent_color: string | null;
  card_text_color: string | null;
  card_border_color: string | null;
  custom_badge_text: string | null;
  custom_badge_color: string | null;
  avatar_frame: AvatarFrameStyle;
  card_theme: ProfileCardTheme;
  entry_sound_volume: number;
}

const VALID_AVATAR_FRAMES: ReadonlyArray<AvatarFrameStyle> = [
  "none",
  "crimson-pulse",
  "cyber-cut",
  "double-neon",
];

export const VALID_CARD_THEMES: ReadonlyArray<ProfileCardTheme> = [
  "default",
  "obsidian-glass",
  "liquid-water",
  "crimson-fire",
  "cyber-hologram",
  "neon-grid",
];

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function validateHexColor(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!HEX_COLOR_RE.test(trimmed)) {
    throw new Error(`Cor hexadecimal inválida: "${trimmed}"`);
  }
  return trimmed;
}

export function validateImageFile(
  file: File,
  maxBytes: number,
  label: string,
): void {
  if (!ALLOWED_IMAGE_MIMES.includes(file.type as (typeof ALLOWED_IMAGE_MIMES)[number])) {
    throw new Error(
      `${label}: formato não suportado (${file.type || "desconhecido"}). Use PNG, JPEG, WEBP ou GIF.`,
    );
  }
  if (file.size > maxBytes) {
    const mb = (maxBytes / (1024 * 1024)).toFixed(1);
    throw new Error(`${label}: tamanho excede o limite de ${mb} MB.`);
  }
}

export async function validateEntranceSoundFile(file: File): Promise<number> {
  if (!ALLOWED_AUDIO_MIMES.includes(file.type as (typeof ALLOWED_AUDIO_MIMES)[number])) {
    throw new Error(
      `Som de entrada: formato não suportado (${file.type || "desconhecido"}). Use MP3, WAV, OGG, WEBM ou M4A.`,
    );
  }
  if (file.size > ENTRY_SOUND_MAX_BYTES) {
    throw new Error(
      "Som de entrada: arquivo excede o limite máximo de 500 KB.",
    );
  }

  const duration = await measureAudioDurationSeconds(file);
  if (duration > ENTRY_SOUND_MAX_DURATION_SEC + 0.05) {
    throw new Error(
      `Som de entrada: duração de ${duration.toFixed(1)}s excede o máximo de ${ENTRY_SOUND_MAX_DURATION_SEC}s.`,
    );
  }
  return duration;
}

async function measureAudioDurationSeconds(file: File): Promise<number> {
  if (typeof AudioContext !== "undefined") {
    const ctx = new AudioContext();
    try {
      const buf = await file.arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      return decoded.duration;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  if (typeof Audio !== "undefined" && typeof URL !== "undefined") {
    const objectUrl = URL.createObjectURL(file);
    try {
      return await new Promise<number>((resolve, reject) => {
        const audio = new Audio();
        audio.preload = "metadata";
        audio.onloadedmetadata = () => resolve(audio.duration);
        audio.onerror = () =>
          reject(new Error("Não foi possível decodificar a duração do áudio."));
        audio.src = objectUrl;
      });
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  throw new Error("Ambiente sem suporte para validar duração do áudio.");
}

export async function updateProfileIdentity(
  supabase: CafofoSupabaseClient,
  userId: string,
  fields: Partial<ProfileIdentityEditableFields>,
): Promise<ProfileRow> {
  const payload: ProfileUpdate = {};

  if (fields.display_name !== undefined) {
    const trimmed = fields.display_name.trim();
    if (!trimmed) {
      throw new Error("O nome de exibição não pode ficar vazio.");
    }
    payload.display_name = trimmed;
  }

  if (fields.bio !== undefined) {
    payload.bio = fields.bio?.trim() || null;
  }
  if (fields.custom_status_text !== undefined) {
    const text = fields.custom_status_text?.trim() || null;
    payload.custom_status_text = text;
    payload.custom_status = text;
  }
  if (fields.custom_status_emoji !== undefined) {
    payload.custom_status_emoji = fields.custom_status_emoji?.trim() || null;
  }
  if (fields.banner_color !== undefined) {
    payload.banner_color = validateHexColor(fields.banner_color);
  }
  if (fields.banner_gradient !== undefined) {
    payload.banner_gradient = fields.banner_gradient?.trim() || null;
  }
  if (fields.card_bg_color !== undefined) {
    payload.card_bg_color = validateHexColor(fields.card_bg_color);
  }
  if (fields.card_accent_color !== undefined) {
    payload.card_accent_color = validateHexColor(fields.card_accent_color);
  }
  if (fields.card_text_color !== undefined) {
    payload.card_text_color = validateHexColor(fields.card_text_color);
  }
  if (fields.card_border_color !== undefined) {
    payload.card_border_color = validateHexColor(fields.card_border_color);
  }
  if (fields.custom_badge_text !== undefined) {
    const trimmed = fields.custom_badge_text?.trim() || null;
    if (trimmed && trimmed.length > 24) {
      throw new Error("O texto do sticker deve ter no máximo 24 caracteres.");
    }
    payload.custom_badge_text = trimmed;
  }
  if (fields.custom_badge_color !== undefined) {
    payload.custom_badge_color = validateHexColor(fields.custom_badge_color);
  }
  if (fields.avatar_frame !== undefined) {
    if (!VALID_AVATAR_FRAMES.includes(fields.avatar_frame)) {
      throw new Error(`Moldura de avatar inválida: "${fields.avatar_frame}"`);
    }
    payload.avatar_frame = fields.avatar_frame;
  }
  if (fields.card_theme !== undefined) {
    if (!VALID_CARD_THEMES.includes(fields.card_theme)) {
      throw new Error(`Modelo de cartão inválido: "${fields.card_theme}"`);
    }
    payload.card_theme = fields.card_theme;
  }
  if (fields.entry_sound_volume !== undefined) {
    payload.entry_sound_volume = Math.max(
      0,
      Math.min(1, Number(fields.entry_sound_volume)),
    );
  }

  const { data, error } = await supabase
    .from("profiles")
    .update(payload)
    .eq("id", userId)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Erro ao atualizar perfil: ${error.message}`);
  }
  return data;
}

export async function uploadProfileMedia(
  supabase: CafofoSupabaseClient,
  userId: string,
  bucket: ProfileMediaBucket,
  file: File,
): Promise<ProfileRow> {
  if (bucket === "avatars") {
    validateImageFile(file, AVATAR_MAX_BYTES, "Avatar");
  } else if (bucket === "banners") {
    validateImageFile(file, BANNER_MAX_BYTES, "Banner");
  } else {
    await validateEntranceSoundFile(file);
  }

  const ext = inferExtension(file);
  const filePath = `${userId}/${bucket}-${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(filePath, file, {
      contentType: file.type,
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Erro ao enviar arquivo para ${bucket}: ${uploadError.message}`);
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(bucket).getPublicUrl(filePath);

  const columnPatch: ProfileUpdate =
    bucket === "avatars"
      ? { avatar_url: publicUrl }
      : bucket === "banners"
        ? { banner_url: publicUrl }
        : { entry_sound_url: publicUrl };

  const { data, error: updateError } = await supabase
    .from("profiles")
    .update(columnPatch)
    .eq("id", userId)
    .select("*")
    .single();

  if (updateError) {
    throw new Error(`Erro ao salvar URL no perfil: ${updateError.message}`);
  }

  return data;
}

function inferExtension(file: File): string {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) {
    return fromName;
  }
  switch (file.type) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    case "audio/mp4":
      return "m4a";
    default:
      return "bin";
  }
}
