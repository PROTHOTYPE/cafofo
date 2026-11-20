-- Cafofo Phase 5 Migration: Advanced Profile Customization ("Identidade Cafofo Plus")
-- Adds customizable sticker badge text/color, avatar frame style, and banner gradient.

alter table public.profiles
    add column if not exists custom_badge_text text,
    add column if not exists custom_badge_color text default '#B91C1C',
    add column if not exists avatar_frame text not null default 'none',
    add column if not exists banner_gradient text;

alter table public.profiles
    drop constraint if exists profiles_custom_badge_text_len;
alter table public.profiles
    add constraint profiles_custom_badge_text_len
    check (custom_badge_text is null or char_length(custom_badge_text) <= 24);

alter table public.profiles
    drop constraint if exists profiles_avatar_frame_valid;
alter table public.profiles
    add constraint profiles_avatar_frame_valid
    check (avatar_frame in ('none', 'crimson-pulse', 'cyber-cut', 'double-neon'));
