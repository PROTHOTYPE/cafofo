-- Cafofo Initial Schema (Phase 1: Foundation & Contracts)
-- Tables: profiles, servers, server_members, channels, messages, game_catalog

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

do $$
begin
    if not exists (select 1 from pg_type where typname = 'channel_type') then
        create type public.channel_type as enum ('text', 'voice');
    end if;

    if not exists (select 1 from pg_type where typname = 'member_role') then
        create type public.member_role as enum ('owner', 'admin', 'member');
    end if;

    if not exists (select 1 from pg_type where typname = 'presence_status') then
        create type public.presence_status as enum ('online', 'idle', 'dnd', 'offline');
    end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    username text unique not null,
    display_name text not null,
    avatar_url text,
    bio text,
    status public.presence_status not null default 'offline',
    custom_status text,

    -- Profile card customization, colors, banner and entry sound
    banner_url text,
    banner_color text default '#1E1F22',
    card_bg_color text default '#111214',
    card_accent_color text default '#5865F2',
    card_text_color text default '#F2F3F5',
    card_border_color text,
    entry_sound_url text,
    entry_sound_volume numeric(3, 2) not null default 0.75
        check (entry_sound_volume >= 0 and entry_sound_volume <= 1),

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.servers (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    description text,
    icon_url text,
    banner_url text,
    invite_code text unique not null default encode(gen_random_bytes(6), 'hex'),
    owner_id uuid not null references public.profiles(id) on delete cascade,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.server_members (
    server_id uuid not null references public.servers(id) on delete cascade,
    user_id uuid not null references public.profiles(id) on delete cascade,
    role public.member_role not null default 'member',
    nickname text,
    joined_at timestamptz not null default now(),
    primary key (server_id, user_id)
);

create table if not exists public.channels (
    id uuid primary key default gen_random_uuid(),
    server_id uuid not null references public.servers(id) on delete cascade,
    name text not null,
    topic text,
    type public.channel_type not null default 'text',
    position integer not null default 0,
    bitrate integer default 64000,
    user_limit integer default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.messages (
    id uuid primary key default gen_random_uuid(),
    channel_id uuid not null references public.channels(id) on delete cascade,
    author_id uuid not null references public.profiles(id) on delete cascade,
    content text not null,
    reply_to_id uuid references public.messages(id) on delete set null,
    attachments jsonb not null default '[]'::jsonb,
    edited_at timestamptz,
    created_at timestamptz not null default now()
);

create table if not exists public.game_catalog (
    id uuid primary key default gen_random_uuid(),
    slug text unique not null,
    name text not null,
    executables text[] not null default '{}',
    icon_url text,
    cover_url text,
    verified boolean not null default false,
    created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index if not exists idx_server_members_user_id
    on public.server_members (user_id);

create index if not exists idx_channels_server_id_position
    on public.channels (server_id, position);

create index if not exists idx_messages_channel_id_created_at
    on public.messages (channel_id, created_at desc);

create index if not exists idx_game_catalog_executables
    on public.game_catalog using gin (executables);

-- ---------------------------------------------------------------------------
-- Helper Functions & Triggers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
    before update on public.profiles
    for each row execute function public.set_updated_at();

drop trigger if exists trg_servers_updated_at on public.servers;
create trigger trg_servers_updated_at
    before update on public.servers
    for each row execute function public.set_updated_at();

drop trigger if exists trg_channels_updated_at on public.channels;
create trigger trg_channels_updated_at
    before update on public.channels
    for each row execute function public.set_updated_at();

create or replace function public.add_owner_as_server_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.server_members (server_id, user_id, role)
    values (new.id, new.owner_id, 'owner')
    on conflict (server_id, user_id) do nothing;
    return new;
end;
$$;

drop trigger if exists trg_servers_add_owner on public.servers;
create trigger trg_servers_add_owner
    after insert on public.servers
    for each row execute function public.add_owner_as_server_member();

create or replace function public.is_server_member(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.server_members sm
        where sm.server_id = p_server_id
          and sm.user_id = p_user_id
    );
$$;

create or replace function public.is_server_admin(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.server_members sm
        where sm.server_id = p_server_id
          and sm.user_id = p_user_id
          and sm.role in ('owner', 'admin')
    );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security (RLS)
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.servers enable row level security;
alter table public.server_members enable row level security;
alter table public.channels enable row level security;
alter table public.messages enable row level security;
alter table public.game_catalog enable row level security;

-- profiles
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
    on public.profiles for select
    to authenticated
    using (true);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
    on public.profiles for insert
    to authenticated
    with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
    on public.profiles for update
    to authenticated
    using (auth.uid() = id)
    with check (auth.uid() = id);

-- servers
drop policy if exists "servers_select_members" on public.servers;
create policy "servers_select_members"
    on public.servers for select
    to authenticated
    using (
        owner_id = auth.uid()
        or public.is_server_member(id, auth.uid())
    );

drop policy if exists "servers_insert_owner" on public.servers;
create policy "servers_insert_owner"
    on public.servers for insert
    to authenticated
    with check (auth.uid() = owner_id);

drop policy if exists "servers_update_owner" on public.servers;
create policy "servers_update_owner"
    on public.servers for update
    to authenticated
    using (auth.uid() = owner_id)
    with check (auth.uid() = owner_id);

drop policy if exists "servers_delete_owner" on public.servers;
create policy "servers_delete_owner"
    on public.servers for delete
    to authenticated
    using (auth.uid() = owner_id);

-- server_members
drop policy if exists "server_members_select_members" on public.server_members;
create policy "server_members_select_members"
    on public.server_members for select
    to authenticated
    using (public.is_server_member(server_id, auth.uid()));

drop policy if exists "server_members_insert_self_or_admin" on public.server_members;
create policy "server_members_insert_self_or_admin"
    on public.server_members for insert
    to authenticated
    with check (
        auth.uid() = user_id
        or public.is_server_admin(server_id, auth.uid())
    );

drop policy if exists "server_members_update_self_or_admin" on public.server_members;
create policy "server_members_update_self_or_admin"
    on public.server_members for update
    to authenticated
    using (
        auth.uid() = user_id
        or public.is_server_admin(server_id, auth.uid())
    )
    with check (
        auth.uid() = user_id
        or public.is_server_admin(server_id, auth.uid())
    );

drop policy if exists "server_members_delete_self_or_admin" on public.server_members;
create policy "server_members_delete_self_or_admin"
    on public.server_members for delete
    to authenticated
    using (
        auth.uid() = user_id
        or public.is_server_admin(server_id, auth.uid())
    );

-- channels
drop policy if exists "channels_select_members" on public.channels;
create policy "channels_select_members"
    on public.channels for select
    to authenticated
    using (public.is_server_member(server_id, auth.uid()));

drop policy if exists "channels_insert_admin" on public.channels;
create policy "channels_insert_admin"
    on public.channels for insert
    to authenticated
    with check (public.is_server_admin(server_id, auth.uid()));

drop policy if exists "channels_update_admin" on public.channels;
create policy "channels_update_admin"
    on public.channels for update
    to authenticated
    using (public.is_server_admin(server_id, auth.uid()))
    with check (public.is_server_admin(server_id, auth.uid()));

drop policy if exists "channels_delete_admin" on public.channels;
create policy "channels_delete_admin"
    on public.channels for delete
    to authenticated
    using (public.is_server_admin(server_id, auth.uid()));

-- messages
drop policy if exists "messages_select_members" on public.messages;
create policy "messages_select_members"
    on public.messages for select
    to authenticated
    using (
        exists (
            select 1
            from public.channels c
            where c.id = channel_id
              and public.is_server_member(c.server_id, auth.uid())
        )
    );

drop policy if exists "messages_insert_member_author" on public.messages;
create policy "messages_insert_member_author"
    on public.messages for insert
    to authenticated
    with check (
        auth.uid() = author_id
        and exists (
            select 1
            from public.channels c
            where c.id = channel_id
              and public.is_server_member(c.server_id, auth.uid())
        )
    );

drop policy if exists "messages_update_author" on public.messages;
create policy "messages_update_author"
    on public.messages for update
    to authenticated
    using (auth.uid() = author_id)
    with check (auth.uid() = author_id);

drop policy if exists "messages_delete_author_or_admin" on public.messages;
create policy "messages_delete_author_or_admin"
    on public.messages for delete
    to authenticated
    using (
        auth.uid() = author_id
        or exists (
            select 1
            from public.channels c
            where c.id = channel_id
              and public.is_server_admin(c.server_id, auth.uid())
        )
    );

-- game_catalog (read-only for authenticated clients; managed via service_role)
drop policy if exists "game_catalog_select_authenticated" on public.game_catalog;
create policy "game_catalog_select_authenticated"
    on public.game_catalog for select
    to authenticated
    using (true);
