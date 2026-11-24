-- Public Repository Security Hardening Migration
-- 1. Isolates internal RLS helper SECURITY DEFINER functions in `app_private` schema with caller uid guard
-- 2. Converts `public.is_*` wrappers to SECURITY INVOKER (eliminates RPC exposure & cross-user membership enumeration)
-- 3. Enforces strict room-membership RLS on `public.room_music_state` (prevents cross-server/DM music tampering)
-- 4. Removes `image/svg+xml` and wildcard `image/*` from public `attachments` Storage bucket
-- 5. Enforces HTTPS-only media URLs on `public.profiles`

create schema if not exists app_private;
revoke all on schema app_private from public, anon;
grant usage on schema app_private to authenticated, service_role;

create or replace function app_private.is_server_member(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select (
        (select auth.uid()) is null
        or p_user_id = (select auth.uid())
    ) and exists (
        select 1
        from public.server_members sm
        where sm.server_id = p_server_id
          and sm.user_id = p_user_id
    );
$$;

create or replace function app_private.is_server_admin(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select (
        (select auth.uid()) is null
        or p_user_id = (select auth.uid())
    ) and (
        exists (
            select 1
            from public.servers s
            where s.id = p_server_id
              and s.owner_id = p_user_id
        )
        or exists (
            select 1
            from public.server_members sm
            where sm.server_id = p_server_id
              and sm.user_id = p_user_id
              and sm.role in ('owner', 'admin')
        )
    );
$$;

create or replace function app_private.is_server_owner(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select (
        (select auth.uid()) is null
        or p_user_id = (select auth.uid())
    ) and (
        exists (
            select 1
            from public.servers s
            where s.id = p_server_id
              and s.owner_id = p_user_id
        )
        or exists (
            select 1
            from public.server_members sm
            where sm.server_id = p_server_id
              and sm.user_id = p_user_id
              and sm.role = 'owner'
        )
    );
$$;

create or replace function app_private.is_dm_participant(p_dm_channel_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select (
        (select auth.uid()) is null
        or p_user_id = (select auth.uid())
    ) and exists (
        select 1
        from public.direct_channels dc
        where dc.id = p_dm_channel_id
          and (dc.user_a = p_user_id or dc.user_b = p_user_id)
    );
$$;

create or replace function app_private.can_access_voice_room(p_room_id text)
returns boolean
language sql
stable
security definer
set search_path = public, app_private
as $$
    select case
        when (select auth.uid()) is null then false
        when p_room_id ~* '^dm:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            app_private.is_dm_participant(substring(p_room_id from 4)::uuid, (select auth.uid()))
        when p_room_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
            exists (
                select 1
                from public.channels c
                where c.id = p_room_id::uuid
                  and c.type = 'voice'
                  and app_private.is_server_member(c.server_id, (select auth.uid()))
            )
        else false
    end;
$$;

revoke all on all functions in schema app_private from public, anon;
grant execute on all functions in schema app_private to authenticated, service_role;

-- Convert public wrappers to SECURITY INVOKER so existing RLS policies continue working
-- without exposing privileged SECURITY DEFINER helpers in the public schema
create or replace function public.is_server_member(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, app_private
as $$
    select app_private.is_server_member(p_server_id, p_user_id);
$$;

create or replace function public.is_server_admin(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, app_private
as $$
    select app_private.is_server_admin(p_server_id, p_user_id);
$$;

create or replace function public.is_server_owner(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, app_private
as $$
    select app_private.is_server_owner(p_server_id, p_user_id);
$$;

create or replace function public.is_dm_participant(p_dm_channel_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, app_private
as $$
    select app_private.is_dm_participant(p_dm_channel_id, p_user_id);
$$;

-- Strict per-room RLS on `public.room_music_state`
drop policy if exists "room_music_state_select_authenticated" on public.room_music_state;
drop policy if exists "room_music_state_insert_authenticated" on public.room_music_state;
drop policy if exists "room_music_state_update_authenticated" on public.room_music_state;
drop policy if exists "room_music_state_select_room_members" on public.room_music_state;
drop policy if exists "room_music_state_insert_room_members" on public.room_music_state;
drop policy if exists "room_music_state_update_room_members" on public.room_music_state;
drop policy if exists "room_music_state_delete_room_members" on public.room_music_state;

create policy "room_music_state_select_room_members"
    on public.room_music_state for select
    to authenticated
    using (app_private.can_access_voice_room(room_id));

create policy "room_music_state_insert_room_members"
    on public.room_music_state for insert
    to authenticated
    with check (
        app_private.can_access_voice_room(room_id)
        and (updated_by is null or updated_by = (select auth.uid()))
    );

create policy "room_music_state_update_room_members"
    on public.room_music_state for update
    to authenticated
    using (app_private.can_access_voice_room(room_id))
    with check (
        app_private.can_access_voice_room(room_id)
        and (updated_by is null or updated_by = (select auth.uid()))
    );

create policy "room_music_state_delete_room_members"
    on public.room_music_state for delete
    to authenticated
    using (app_private.can_access_voice_room(room_id));

-- Remove `image/svg+xml` and wildcard `image/*` from `attachments` bucket
update storage.buckets
set allowed_mime_types = array[
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/gif',
    'image/avif',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'application/pdf',
    'text/plain'
]
where id = 'attachments';

-- Enforce HTTPS-only media URLs on `public.profiles` (prevents javascript:, data:, and SSRF URLs)
do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conname = 'profiles_https_media_urls_check'
          and conrelid = 'public.profiles'::regclass
    ) then
        alter table public.profiles
            add constraint profiles_https_media_urls_check
            check (
                (avatar_url is null or avatar_url ~* '^https://')
                and (banner_url is null or banner_url ~* '^https://')
                and (entry_sound_url is null or entry_sound_url ~* '^https://')
            );
    end if;
end $$;
