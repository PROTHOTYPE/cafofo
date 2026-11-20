-- Cafofo Server Roles & Tags + Chat Media Storage Migration (0007_server_roles_and_tags.sql)
-- 1. Creates public.server_roles (id, server_id, name, color, position, permissions)
-- 2. Adds role_id to public.server_members referencing public.server_roles
-- 3. Enables Realtime (supabase_realtime + REPLICA IDENTITY FULL) on server_roles & server_members
-- 4. Configures 'attachments' Storage bucket for images (image/*) and short videos (video/mp4, video/webm) up to 25MB

-- ---------------------------------------------------------------------------
-- 1. Table public.server_roles
-- ---------------------------------------------------------------------------

create table if not exists public.server_roles (
    id uuid primary key default gen_random_uuid(),
    server_id uuid not null references public.servers(id) on delete cascade,
    name text not null check (char_length(trim(name)) between 1 and 32),
    color text not null default '#B91C1C',
    position integer not null default 0,
    permissions jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_server_roles_server_position
    on public.server_roles (server_id, position asc, created_at asc);

drop trigger if exists trg_server_roles_updated_at on public.server_roles;
create trigger trg_server_roles_updated_at
    before update on public.server_roles
    for each row execute function public.set_updated_at();

alter table public.server_roles enable row level security;

grant select, insert, update, delete on public.server_roles to authenticated, service_role;

drop policy if exists "server_roles_select_members" on public.server_roles;
create policy "server_roles_select_members"
    on public.server_roles for select
    to authenticated
    using (public.is_server_member(server_id, (select auth.uid())));

drop policy if exists "server_roles_insert_admin" on public.server_roles;
create policy "server_roles_insert_admin"
    on public.server_roles for insert
    to authenticated
    with check (public.is_server_admin(server_id, (select auth.uid())));

drop policy if exists "server_roles_update_admin" on public.server_roles;
create policy "server_roles_update_admin"
    on public.server_roles for update
    to authenticated
    using (public.is_server_admin(server_id, (select auth.uid())))
    with check (public.is_server_admin(server_id, (select auth.uid())));

drop policy if exists "server_roles_delete_admin" on public.server_roles;
create policy "server_roles_delete_admin"
    on public.server_roles for delete
    to authenticated
    using (public.is_server_admin(server_id, (select auth.uid())));

-- ---------------------------------------------------------------------------
-- 2. Add role_id to public.server_members & update RLS policy
-- ---------------------------------------------------------------------------

alter table public.server_members
    add column if not exists role_id uuid references public.server_roles(id) on delete set null;

create index if not exists idx_server_members_role_id
    on public.server_members (role_id);

drop policy if exists "server_members_update_admin_only" on public.server_members;
create policy "server_members_update_admin_only"
    on public.server_members for update
    to authenticated
    using (
        public.is_server_admin(server_id, (select auth.uid()))
        and (role <> 'owner' or public.is_server_owner(server_id, (select auth.uid())))
    )
    with check (
        public.is_server_admin(server_id, (select auth.uid()))
        and (
            role <> 'owner'
            or (user_id = (select auth.uid()) and public.is_server_owner(server_id, (select auth.uid())))
        )
        and (
            role_id is null
            or exists (
                select 1
                from public.server_roles sr
                where sr.id = role_id
                  and sr.server_id = server_members.server_id
            )
        )
    );

-- Seed default starter roles for existing servers without roles and on new server creation
create or replace function public.seed_default_server_roles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.server_roles (server_id, name, color, position, permissions)
    values
        (new.id, 'ADMIN', '#EF4444', 0, '{"admin": true, "manage_channels": true, "kick_members": true}'::jsonb),
        (new.id, 'MOD', '#F59E0B', 1, '{"moderate_chat": true, "move_voice": true}'::jsonb),
        (new.id, 'STREAMER', '#A855F7', 2, '{"stream_hd": true}'::jsonb),
        (new.id, 'MEMBRO', '#71717A', 3, '{}'::jsonb);
    return new;
end;
$$;

revoke all on function public.seed_default_server_roles() from public, anon, authenticated;

drop trigger if exists trg_servers_seed_default_roles on public.servers;
create trigger trg_servers_seed_default_roles
    after insert on public.servers
    for each row execute function public.seed_default_server_roles();

insert into public.server_roles (server_id, name, color, position, permissions)
select s.id, preset.name, preset.color, preset.position, preset.permissions
from public.servers s
cross join (
    values
        ('ADMIN', '#EF4444', 0, '{"admin": true, "manage_channels": true, "kick_members": true}'::jsonb),
        ('MOD', '#F59E0B', 1, '{"moderate_chat": true, "move_voice": true}'::jsonb),
        ('STREAMER', '#A855F7', 2, '{"stream_hd": true}'::jsonb),
        ('MEMBRO', '#71717A', 3, '{}'::jsonb)
) as preset(name, color, position, permissions)
where not exists (
    select 1
    from public.server_roles sr
    where sr.server_id = s.id
);

-- ---------------------------------------------------------------------------
-- 3. Realtime publication for server_roles & server_members
-- ---------------------------------------------------------------------------

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (
            select 1
            from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = 'server_roles'
        ) then
            alter publication supabase_realtime add table public.server_roles;
        end if;

        if not exists (
            select 1
            from pg_publication_tables
            where pubname = 'supabase_realtime'
              and schemaname = 'public'
              and tablename = 'server_members'
        ) then
            alter publication supabase_realtime add table public.server_members;
        end if;
    end if;
end $$;

alter table public.server_roles replica identity full;
alter table public.server_members replica identity full;

-- ---------------------------------------------------------------------------
-- 4. Storage bucket 'attachments' (images & short videos up to 25MB)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'attachments',
    'attachments',
    true,
    26214400,
    array[
        'image/*',
        'image/png',
        'image/jpeg',
        'image/jpg',
        'image/webp',
        'image/gif',
        'image/avif',
        'image/svg+xml',
        'video/mp4',
        'video/webm',
        'video/quicktime',
        'audio/mpeg',
        'audio/wav',
        'audio/ogg',
        'application/pdf',
        'text/plain'
    ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "cafofo_attachments_insert" on storage.objects;
create policy "cafofo_attachments_insert"
    on storage.objects for insert
    to authenticated
    with check (
        bucket_id = 'attachments'
        and (select auth.uid())::text = (storage.foldername(name))[1]
    );

drop policy if exists "cafofo_attachments_update" on storage.objects;
create policy "cafofo_attachments_update"
    on storage.objects for update
    to authenticated
    using (
        bucket_id = 'attachments'
        and (select auth.uid())::text = (storage.foldername(name))[1]
    )
    with check (
        bucket_id = 'attachments'
        and (select auth.uid())::text = (storage.foldername(name))[1]
    );

drop policy if exists "cafofo_attachments_delete" on storage.objects;
create policy "cafofo_attachments_delete"
    on storage.objects for delete
    to authenticated
    using (
        bucket_id = 'attachments'
        and (select auth.uid())::text = (storage.foldername(name))[1]
    );
