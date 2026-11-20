-- Cafofo Security Hardening Migration (0005_security_hardening)
-- Enforces strict RLS on profiles/servers/server_members/channels/messages,
-- hardens Storage bucket limits and folder ownership, fixes function search_path/grants,
-- and adds covering FK indexes.

-- ---------------------------------------------------------------------------
-- 1. Function search_path & ownership helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create or replace function public.is_server_owner(p_server_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.servers s
        where s.id = p_server_id
          and s.owner_id = p_user_id
    ) or exists (
        select 1
        from public.server_members sm
        where sm.server_id = p_server_id
          and sm.user_id = p_user_id
          and sm.role = 'owner'
    );
$$;

create or replace function public.protect_server_owner_id()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.owner_id is distinct from old.owner_id and old.owner_id is distinct from auth.uid() then
        raise exception 'Only the server owner can transfer server ownership';
    end if;
    return new;
end;
$$;

drop trigger if exists trg_servers_protect_owner on public.servers;
create trigger trg_servers_protect_owner
    before update on public.servers
    for each row execute function public.protect_server_owner_id();

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.add_owner_as_server_member() from public, anon, authenticated;
revoke all on function public.protect_server_owner_id() from public, anon, authenticated;

revoke all on function public.is_server_member(uuid, uuid) from public, anon;
grant execute on function public.is_server_member(uuid, uuid) to authenticated, service_role;

revoke all on function public.is_server_admin(uuid, uuid) from public, anon;
grant execute on function public.is_server_admin(uuid, uuid) to authenticated, service_role;

revoke all on function public.is_server_owner(uuid, uuid) from public, anon;
grant execute on function public.is_server_owner(uuid, uuid) to authenticated, service_role;

revoke all on function public.join_server_by_invite(text) from public, anon;
grant execute on function public.join_server_by_invite(text) to authenticated, service_role;

revoke all on function public.regenerate_server_invite(uuid) from public, anon;
grant execute on function public.regenerate_server_invite(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Strict Row Level Security (RLS) across all tables
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.servers enable row level security;
alter table public.server_members enable row level security;
alter table public.channels enable row level security;
alter table public.messages enable row level security;
alter table public.game_catalog enable row level security;

-- profiles: self + members/message-authors in shared servers only
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
    on public.profiles for select
    to authenticated
    using (
        id = (select auth.uid())
        or exists (
            select 1
            from public.server_members sm_self
            join public.server_members sm_other on sm_self.server_id = sm_other.server_id
            where sm_self.user_id = (select auth.uid())
              and sm_other.user_id = public.profiles.id
        )
        or exists (
            select 1
            from public.messages m
            join public.channels c on c.id = m.channel_id
            where m.author_id = public.profiles.id
              and public.is_server_member(c.server_id, (select auth.uid()))
        )
    );

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
    on public.profiles for insert
    to authenticated
    with check ((select auth.uid()) = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
    on public.profiles for update
    to authenticated
    using ((select auth.uid()) = id)
    with check ((select auth.uid()) = id);

-- servers: members select, owner insert/delete, owner or admin update (owner_id immutable for non-owners)
drop policy if exists "servers_select_members" on public.servers;
create policy "servers_select_members"
    on public.servers for select
    to authenticated
    using (
        owner_id = (select auth.uid())
        or public.is_server_member(id, (select auth.uid()))
    );

drop policy if exists "servers_insert_owner" on public.servers;
create policy "servers_insert_owner"
    on public.servers for insert
    to authenticated
    with check ((select auth.uid()) = owner_id);

drop policy if exists "servers_update_owner" on public.servers;
drop policy if exists "servers_update_admin" on public.servers;
create policy "servers_update_admin"
    on public.servers for update
    to authenticated
    using (
        owner_id = (select auth.uid())
        or public.is_server_admin(id, (select auth.uid()))
    )
    with check (
        owner_id = (select auth.uid())
        or public.is_server_admin(id, (select auth.uid()))
    );

drop policy if exists "servers_delete_owner" on public.servers;
create policy "servers_delete_owner"
    on public.servers for delete
    to authenticated
    using (
        (select auth.uid()) = owner_id
        and public.is_server_owner(id, (select auth.uid()))
    );

-- server_members: prevent self-escalation and unauthorized membership listing
drop policy if exists "server_members_select_members" on public.server_members;
create policy "server_members_select_members"
    on public.server_members for select
    to authenticated
    using (public.is_server_member(server_id, (select auth.uid())));

drop policy if exists "server_members_insert_self_or_admin" on public.server_members;
drop policy if exists "server_members_insert_admin_only" on public.server_members;
create policy "server_members_insert_admin_only"
    on public.server_members for insert
    to authenticated
    with check (
        public.is_server_admin(server_id, (select auth.uid()))
        and role <> 'owner'
    );

drop policy if exists "server_members_update_self_or_admin" on public.server_members;
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
        and role <> 'owner'
    );

drop policy if exists "server_members_delete_self_or_admin" on public.server_members;
create policy "server_members_delete_self_or_admin"
    on public.server_members for delete
    to authenticated
    using (
        (user_id = (select auth.uid()) and role <> 'owner')
        or (public.is_server_admin(server_id, (select auth.uid())) and role <> 'owner')
    );

-- channels: strictly owner or admin can create/update/delete; members can select
drop policy if exists "channels_select_members" on public.channels;
create policy "channels_select_members"
    on public.channels for select
    to authenticated
    using (public.is_server_member(server_id, (select auth.uid())));

drop policy if exists "channels_insert_admin" on public.channels;
create policy "channels_insert_admin"
    on public.channels for insert
    to authenticated
    with check (public.is_server_admin(server_id, (select auth.uid())));

drop policy if exists "channels_update_admin" on public.channels;
create policy "channels_update_admin"
    on public.channels for update
    to authenticated
    using (public.is_server_admin(server_id, (select auth.uid())))
    with check (public.is_server_admin(server_id, (select auth.uid())));

drop policy if exists "channels_delete_admin" on public.channels;
create policy "channels_delete_admin"
    on public.channels for delete
    to authenticated
    using (public.is_server_admin(server_id, (select auth.uid())));

-- messages: active server members only
drop policy if exists "messages_select_members" on public.messages;
create policy "messages_select_members"
    on public.messages for select
    to authenticated
    using (
        exists (
            select 1
            from public.channels c
            where c.id = channel_id
              and public.is_server_member(c.server_id, (select auth.uid()))
        )
    );

drop policy if exists "messages_insert_member_author" on public.messages;
create policy "messages_insert_member_author"
    on public.messages for insert
    to authenticated
    with check (
        (select auth.uid()) = author_id
        and exists (
            select 1
            from public.channels c
            where c.id = channel_id
              and public.is_server_member(c.server_id, (select auth.uid()))
        )
    );

drop policy if exists "messages_update_author" on public.messages;
create policy "messages_update_author"
    on public.messages for update
    to authenticated
    using (
        (select auth.uid()) = author_id
        and exists (
            select 1
            from public.channels c
            where c.id = channel_id
              and public.is_server_member(c.server_id, (select auth.uid()))
        )
    )
    with check (
        (select auth.uid()) = author_id
        and exists (
            select 1
            from public.channels c
            where c.id = channel_id
              and public.is_server_member(c.server_id, (select auth.uid()))
        )
    );

drop policy if exists "messages_delete_author_or_admin" on public.messages;
create policy "messages_delete_author_or_admin"
    on public.messages for delete
    to authenticated
    using (
        (
            (select auth.uid()) = author_id
            and exists (
                select 1
                from public.channels c
                where c.id = channel_id
                  and public.is_server_member(c.server_id, (select auth.uid()))
            )
        )
        or exists (
            select 1
            from public.channels c
            where c.id = channel_id
              and public.is_server_admin(c.server_id, (select auth.uid()))
        )
    );

-- ---------------------------------------------------------------------------
-- 3. Storage bucket file size limits & strict owner-folder policies
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
    ('avatars', 'avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    ('banners', 'banners', true, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    ('entrance-sounds', 'entrance-sounds', true, 524288, array['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/mp4']),
    ('attachments', 'attachments', true, 10485760, null)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "cafofo_media_public_read" on storage.objects;
create policy "cafofo_media_public_read"
    on storage.objects for select
    to public
    using (bucket_id in ('avatars', 'banners', 'entrance-sounds', 'attachments'));

drop policy if exists "cafofo_profile_media_insert" on storage.objects;
create policy "cafofo_profile_media_insert"
    on storage.objects for insert
    to authenticated
    with check (
        bucket_id in ('avatars', 'banners', 'entrance-sounds')
        and (select auth.uid())::text = (storage.foldername(name))[1]
    );

drop policy if exists "cafofo_profile_media_update" on storage.objects;
create policy "cafofo_profile_media_update"
    on storage.objects for update
    to authenticated
    using (
        bucket_id in ('avatars', 'banners', 'entrance-sounds')
        and (select auth.uid())::text = (storage.foldername(name))[1]
    )
    with check (
        bucket_id in ('avatars', 'banners', 'entrance-sounds')
        and (select auth.uid())::text = (storage.foldername(name))[1]
    );

drop policy if exists "cafofo_profile_media_delete" on storage.objects;
create policy "cafofo_profile_media_delete"
    on storage.objects for delete
    to authenticated
    using (
        bucket_id in ('avatars', 'banners', 'entrance-sounds')
        and (select auth.uid())::text = (storage.foldername(name))[1]
    );

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

-- ---------------------------------------------------------------------------
-- 4. Covering indexes for foreign keys
-- ---------------------------------------------------------------------------

create index if not exists idx_messages_author_id on public.messages (author_id);
create index if not exists idx_messages_reply_to_id on public.messages (reply_to_id);
create index if not exists idx_servers_owner_id on public.servers (owner_id);
