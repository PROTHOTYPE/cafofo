-- Cafofo Phase 2 Migration: Server Icons Storage Bucket, Profile Card Themes & Realtime Servers Sync

-- ---------------------------------------------------------------------------
-- 1. Profile Card Themes (`card_theme` on `public.profiles`)
-- ---------------------------------------------------------------------------

alter table public.profiles
    add column if not exists card_theme text not null default 'default';

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'profiles_card_theme_check'
          and conrelid = 'public.profiles'::regclass
    ) then
        alter table public.profiles
            add constraint profiles_card_theme_check
            check (
                card_theme in (
                    'default',
                    'obsidian-glass',
                    'liquid-water',
                    'crimson-fire',
                    'cyber-hologram',
                    'neon-grid'
                )
            );
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Realtime publication for `public.servers` + REPLICA IDENTITY FULL
-- ---------------------------------------------------------------------------

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (
            select 1
            from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = 'servers'
        ) then
            alter publication supabase_realtime add table public.servers;
        end if;
    end if;
end $$;

alter table public.servers replica identity full;
alter table public.profiles replica identity full;
alter table public.channels replica identity full;

-- ---------------------------------------------------------------------------
-- 3. Storage bucket `server-icons` (up to 2 MB, PNG/JPEG/WEBP/GIF)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'server-icons',
    'server-icons',
    true,
    2097152,
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "cafofo_server_icons_public_read" on storage.objects;
create policy "cafofo_server_icons_public_read"
    on storage.objects for select
    to public
    using (bucket_id = 'server-icons');

drop policy if exists "cafofo_server_icons_insert_admin" on storage.objects;
create policy "cafofo_server_icons_insert_admin"
    on storage.objects for insert
    to authenticated
    with check (
        bucket_id = 'server-icons'
        and case
            when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then public.is_server_admin(((storage.foldername(name))[1])::uuid, (select auth.uid()))
            else false
        end
    );

drop policy if exists "cafofo_server_icons_update_admin" on storage.objects;
create policy "cafofo_server_icons_update_admin"
    on storage.objects for update
    to authenticated
    using (
        bucket_id = 'server-icons'
        and case
            when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then public.is_server_admin(((storage.foldername(name))[1])::uuid, (select auth.uid()))
            else false
        end
    )
    with check (
        bucket_id = 'server-icons'
        and case
            when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then public.is_server_admin(((storage.foldername(name))[1])::uuid, (select auth.uid()))
            else false
        end
    );

drop policy if exists "cafofo_server_icons_delete_admin" on storage.objects;
create policy "cafofo_server_icons_delete_admin"
    on storage.objects for delete
    to authenticated
    using (
        bucket_id = 'server-icons'
        and case
            when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then public.is_server_admin(((storage.foldername(name))[1])::uuid, (select auth.uid()))
            else false
        end
    );
