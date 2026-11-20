-- Cafofo Phase 3 Migration: Social/Chat Realtime, Profile Identity Fields & Storage Buckets

-- ---------------------------------------------------------------------------
-- 1. Extend `profiles` for split custom status (text + emoji)
-- ---------------------------------------------------------------------------

alter table public.profiles
    add column if not exists custom_status_text text,
    add column if not exists custom_status_emoji text;

-- Migrate legacy `custom_status` values if present
update public.profiles
set custom_status_text = custom_status
where custom_status is not null
  and custom_status_text is null;

-- ---------------------------------------------------------------------------
-- 2. Auto-create profile when a user signs up in `auth.users`
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_username text;
    v_display_name text;
begin
    v_username := coalesce(
        nullif(trim(new.raw_user_meta_data->>'username'), ''),
        split_part(coalesce(new.email, new.id::text), '@', 1) || '_' || substr(replace(new.id::text, '-', ''), 1, 6)
    );
    v_display_name := coalesce(
        nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
        v_username
    );

    insert into public.profiles (id, username, display_name, status)
    values (new.id, v_username, v_display_name, 'online')
    on conflict (id) do nothing;

    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 3. Server invite RPCs (bypass member-only SELECT RLS safely)
-- ---------------------------------------------------------------------------

create or replace function public.join_server_by_invite(p_invite_code text)
returns public.servers
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_server public.servers;
begin
    if v_user_id is null then
        raise exception 'Authentication required';
    end if;

    select *
    into v_server
    from public.servers
    where invite_code = trim(p_invite_code)
    limit 1;

    if not found then
        raise exception 'Invalid invite code';
    end if;

    insert into public.server_members (server_id, user_id, role)
    values (v_server.id, v_user_id, 'member')
    on conflict (server_id, user_id) do nothing;

    return v_server;
end;
$$;

create or replace function public.regenerate_server_invite(p_server_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_new_code text;
begin
    if v_user_id is null then
        raise exception 'Authentication required';
    end if;

    if not public.is_server_admin(p_server_id, v_user_id) then
        raise exception 'Only server owners or admins can regenerate invites';
    end if;

    v_new_code := encode(gen_random_bytes(6), 'hex');

    update public.servers
    set invite_code = v_new_code
    where id = p_server_id;

    return v_new_code;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Enable Supabase Realtime publication for chat & social tables
-- ---------------------------------------------------------------------------

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        begin
            alter publication supabase_realtime add table public.messages;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table public.channels;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table public.server_members;
        exception when duplicate_object then null;
        end;
        begin
            alter publication supabase_realtime add table public.profiles;
        exception when duplicate_object then null;
        end;
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Storage Buckets & Policies (`avatars`, `banners`, `entrance-sounds`, `attachments`)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
    ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    ('banners', 'banners', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    ('entrance-sounds', 'entrance-sounds', true, 512000, array['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4']),
    ('attachments', 'attachments', true, 10485760, null)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Public read access for media buckets
drop policy if exists "cafofo_media_public_read" on storage.objects;
create policy "cafofo_media_public_read"
    on storage.objects for select
    to public
    using (bucket_id in ('avatars', 'banners', 'entrance-sounds', 'attachments'));

-- Users can upload/update/delete files under their own `<user_id>/...` folder in profile buckets
drop policy if exists "cafofo_profile_media_insert" on storage.objects;
create policy "cafofo_profile_media_insert"
    on storage.objects for insert
    to authenticated
    with check (
        bucket_id in ('avatars', 'banners', 'entrance-sounds')
        and (storage.foldername(name))[1] = auth.uid()::text
    );

drop policy if exists "cafofo_profile_media_update" on storage.objects;
create policy "cafofo_profile_media_update"
    on storage.objects for update
    to authenticated
    using (
        bucket_id in ('avatars', 'banners', 'entrance-sounds')
        and (storage.foldername(name))[1] = auth.uid()::text
    );

drop policy if exists "cafofo_profile_media_delete" on storage.objects;
create policy "cafofo_profile_media_delete"
    on storage.objects for delete
    to authenticated
    using (
        bucket_id in ('avatars', 'banners', 'entrance-sounds')
        and (storage.foldername(name))[1] = auth.uid()::text
    );

-- Authenticated users can upload attachments under `<user_id>/...`
drop policy if exists "cafofo_attachments_insert" on storage.objects;
create policy "cafofo_attachments_insert"
    on storage.objects for insert
    to authenticated
    with check (
        bucket_id = 'attachments'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

drop policy if exists "cafofo_attachments_delete" on storage.objects;
create policy "cafofo_attachments_delete"
    on storage.objects for delete
    to authenticated
    using (
        bucket_id = 'attachments'
        and (storage.foldername(name))[1] = auth.uid()::text
    );

-- ---------------------------------------------------------------------------
-- 6. Initial `game_catalog` seed entries
-- ---------------------------------------------------------------------------

insert into public.game_catalog (slug, name, executables, verified)
values
    ('valorant', 'VALORANT', array['VALORANT-Win64-Shipping.exe', 'VALORANT.exe'], true),
    ('league-of-legends', 'League of Legends', array['League of Legends.exe'], true),
    ('counter-strike-2', 'Counter-Strike 2', array['cs2.exe'], true),
    ('minecraft', 'Minecraft', array['javaw.exe', 'Minecraft.Windows.exe'], true),
    ('elden-ring', 'ELDEN RING', array['eldenring.exe'], true),
    ('helldivers-2', 'HELLDIVERS 2', array['helldivers2.exe'], true)
on conflict (slug) do nothing;
