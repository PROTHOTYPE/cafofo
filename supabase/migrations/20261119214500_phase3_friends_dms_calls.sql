-- Cafofo Phase 3 Migration: Friendships, Direct Channels, Direct Messages & 1:1 Calls

-- ---------------------------------------------------------------------------
-- 1. Table `public.friendships`
-- ---------------------------------------------------------------------------

create table if not exists public.friendships (
    id uuid primary key default gen_random_uuid(),
    requester_id uuid not null references public.profiles(id) on delete cascade,
    addressee_id uuid not null references public.profiles(id) on delete cascade,
    pair_low uuid generated always as (least(requester_id, addressee_id)) stored,
    pair_high uuid generated always as (greatest(requester_id, addressee_id)) stored,
    status text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint friendships_no_self check (requester_id <> addressee_id),
    constraint friendships_unique_pair unique (pair_low, pair_high)
);

create index if not exists idx_friendships_requester on public.friendships (requester_id);
create index if not exists idx_friendships_addressee on public.friendships (addressee_id);
create index if not exists idx_friendships_status on public.friendships (status);

drop trigger if exists trg_friendships_updated_at on public.friendships;
create trigger trg_friendships_updated_at
    before update on public.friendships
    for each row execute function public.set_updated_at();

create or replace function public.protect_friendship_participants()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.requester_id is distinct from old.requester_id
       or new.addressee_id is distinct from old.addressee_id then
        raise exception 'Cannot change friendship participants';
    end if;
    return new;
end;
$$;

revoke all on function public.protect_friendship_participants() from public, anon, authenticated;

drop trigger if exists trg_friendships_protect_participants on public.friendships;
create trigger trg_friendships_protect_participants
    before update on public.friendships
    for each row execute function public.protect_friendship_participants();

-- ---------------------------------------------------------------------------
-- 2. Table `public.direct_channels`
-- ---------------------------------------------------------------------------

create table if not exists public.direct_channels (
    id uuid primary key default gen_random_uuid(),
    user_a uuid not null references public.profiles(id) on delete cascade,
    user_b uuid not null references public.profiles(id) on delete cascade,
    last_message_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint direct_channels_ordered_pair check (user_a < user_b),
    constraint direct_channels_unique_pair unique (user_a, user_b)
);

create index if not exists idx_direct_channels_user_a on public.direct_channels (user_a);
create index if not exists idx_direct_channels_user_b on public.direct_channels (user_b);
create index if not exists idx_direct_channels_last_message_at on public.direct_channels (last_message_at desc);

-- ---------------------------------------------------------------------------
-- 3. Table `public.direct_messages`
-- ---------------------------------------------------------------------------

create table if not exists public.direct_messages (
    id uuid primary key default gen_random_uuid(),
    dm_channel_id uuid not null references public.direct_channels(id) on delete cascade,
    author_id uuid not null references public.profiles(id) on delete cascade,
    content text not null default '',
    reply_to_id uuid references public.direct_messages(id) on delete set null,
    attachments jsonb not null default '[]'::jsonb,
    edited_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists idx_direct_messages_channel_created
    on public.direct_messages (dm_channel_id, created_at desc);
create index if not exists idx_direct_messages_author_id
    on public.direct_messages (author_id);
create index if not exists idx_direct_messages_reply_to_id
    on public.direct_messages (reply_to_id);

create or replace function public.touch_dm_last_message_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.direct_channels
    set last_message_at = greatest(last_message_at, new.created_at)
    where id = new.dm_channel_id;
    return new;
end;
$$;

revoke all on function public.touch_dm_last_message_at() from public, anon, authenticated;

drop trigger if exists trg_direct_messages_touch_channel on public.direct_messages;
create trigger trg_direct_messages_touch_channel
    after insert on public.direct_messages
    for each row execute function public.touch_dm_last_message_at();

-- ---------------------------------------------------------------------------
-- 4. Helper & RPCs (SECURITY DEFINER with strict auth checks)
-- ---------------------------------------------------------------------------

create or replace function public.is_dm_participant(p_dm_channel_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.direct_channels dc
        where dc.id = p_dm_channel_id
          and (dc.user_a = p_user_id or dc.user_b = p_user_id)
    );
$$;

revoke all on function public.is_dm_participant(uuid, uuid) from public, anon;
grant execute on function public.is_dm_participant(uuid, uuid) to authenticated, service_role;

create or replace function public.get_or_create_dm_channel(p_other_user_id uuid)
returns public.direct_channels
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_low uuid;
    v_high uuid;
    v_blocked boolean;
    v_channel public.direct_channels;
begin
    if v_user_id is null then
        raise exception 'Authentication required';
    end if;

    if p_other_user_id is null or p_other_user_id = v_user_id then
        raise exception 'Cannot create a direct channel with yourself';
    end if;

    v_low := least(v_user_id, p_other_user_id);
    v_high := greatest(v_user_id, p_other_user_id);

    select exists (
        select 1
        from public.friendships f
        where f.pair_low = v_low
          and f.pair_high = v_high
          and f.status = 'blocked'
    ) into v_blocked;

    if v_blocked then
        raise exception 'Direct messages are blocked between these users';
    end if;

    insert into public.direct_channels (user_a, user_b)
    values (v_low, v_high)
    on conflict (user_a, user_b)
    do update set last_message_at = public.direct_channels.last_message_at
    returning * into v_channel;

    return v_channel;
end;
$$;

revoke all on function public.get_or_create_dm_channel(uuid) from public, anon;
grant execute on function public.get_or_create_dm_channel(uuid) to authenticated, service_role;

create or replace function public.send_friend_request_by_username(p_username text)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_clean text := lower(trim(ltrim(coalesce(p_username, ''), '@')));
    v_target_id uuid;
    v_low uuid;
    v_high uuid;
    v_existing public.friendships;
    v_result public.friendships;
begin
    if v_user_id is null then
        raise exception 'Authentication required';
    end if;

    if v_clean = '' then
        raise exception 'Informe o @username do amigo.';
    end if;

    select id
    into v_target_id
    from public.profiles
    where lower(username) = v_clean
    limit 1;

    if v_target_id is null then
        raise exception 'Usuário "@%" não encontrado.', v_clean;
    end if;

    if v_target_id = v_user_id then
        raise exception 'Você não pode adicionar a si mesmo.';
    end if;

    v_low := least(v_user_id, v_target_id);
    v_high := greatest(v_user_id, v_target_id);

    select *
    into v_existing
    from public.friendships
    where pair_low = v_low
      and pair_high = v_high
    limit 1;

    if found then
        if v_existing.status = 'accepted' then
            raise exception 'Vocês já são amigos!';
        elsif v_existing.status = 'blocked' then
            raise exception 'Não foi possível enviar o pedido para este usuário.';
        elsif v_existing.requester_id = v_user_id then
            raise exception 'Pedido de amizade já enviado e aguardando resposta.';
        else
            -- Mutual request: accept immediately and ensure DM channel exists
            update public.friendships
            set status = 'accepted'
            where id = v_existing.id
            returning * into v_result;

            insert into public.direct_channels (user_a, user_b)
            values (v_low, v_high)
            on conflict (user_a, user_b) do nothing;

            return v_result;
        end if;
    end if;

    insert into public.friendships (requester_id, addressee_id, status)
    values (v_user_id, v_target_id, 'pending')
    returning * into v_result;

    return v_result;
end;
$$;

revoke all on function public.send_friend_request_by_username(text) from public, anon;
grant execute on function public.send_friend_request_by_username(text) to authenticated, service_role;

create or replace function public.accept_friend_request(p_friendship_id uuid)
returns public.friendships
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_row public.friendships;
begin
    if v_user_id is null then
        raise exception 'Authentication required';
    end if;

    update public.friendships
    set status = 'accepted'
    where id = p_friendship_id
      and addressee_id = v_user_id
      and status = 'pending'
    returning * into v_row;

    if not found then
        raise exception 'Pedido de amizade não encontrado ou já processado.';
    end if;

    insert into public.direct_channels (user_a, user_b)
    values (v_row.pair_low, v_row.pair_high)
    on conflict (user_a, user_b) do nothing;

    return v_row;
end;
$$;

revoke all on function public.accept_friend_request(uuid) from public, anon;
grant execute on function public.accept_friend_request(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Row Level Security (RLS) & Grants
-- ---------------------------------------------------------------------------

alter table public.friendships enable row level security;
alter table public.direct_channels enable row level security;
alter table public.direct_messages enable row level security;

grant select, insert, update, delete on public.friendships to authenticated, service_role;
grant select, insert, update, delete on public.direct_channels to authenticated, service_role;
grant select, insert, update, delete on public.direct_messages to authenticated, service_role;

-- friendships policies
drop policy if exists "friendships_select_own" on public.friendships;
create policy "friendships_select_own"
    on public.friendships for select
    to authenticated
    using (
        requester_id = (select auth.uid())
        or addressee_id = (select auth.uid())
    );

drop policy if exists "friendships_insert_requester" on public.friendships;
create policy "friendships_insert_requester"
    on public.friendships for insert
    to authenticated
    with check (
        requester_id = (select auth.uid())
        and requester_id <> addressee_id
        and status in ('pending', 'blocked')
    );

drop policy if exists "friendships_update_participants" on public.friendships;
create policy "friendships_update_participants"
    on public.friendships for update
    to authenticated
    using (
        requester_id = (select auth.uid())
        or addressee_id = (select auth.uid())
    )
    with check (
        (
            status = 'accepted'
            and addressee_id = (select auth.uid())
        )
        or (
            status = 'blocked'
            and (requester_id = (select auth.uid()) or addressee_id = (select auth.uid()))
        )
    );

drop policy if exists "friendships_delete_participants" on public.friendships;
create policy "friendships_delete_participants"
    on public.friendships for delete
    to authenticated
    using (
        requester_id = (select auth.uid())
        or addressee_id = (select auth.uid())
    );

-- direct_channels policies
drop policy if exists "direct_channels_select_participants" on public.direct_channels;
create policy "direct_channels_select_participants"
    on public.direct_channels for select
    to authenticated
    using (
        user_a = (select auth.uid())
        or user_b = (select auth.uid())
    );

drop policy if exists "direct_channels_insert_participants" on public.direct_channels;
create policy "direct_channels_insert_participants"
    on public.direct_channels for insert
    to authenticated
    with check (
        user_a = (select auth.uid())
        or user_b = (select auth.uid())
    );

drop policy if exists "direct_channels_update_participants" on public.direct_channels;
create policy "direct_channels_update_participants"
    on public.direct_channels for update
    to authenticated
    using (
        user_a = (select auth.uid())
        or user_b = (select auth.uid())
    )
    with check (
        user_a = (select auth.uid())
        or user_b = (select auth.uid())
    );

-- direct_messages policies
drop policy if exists "direct_messages_select_participants" on public.direct_messages;
create policy "direct_messages_select_participants"
    on public.direct_messages for select
    to authenticated
    using (public.is_dm_participant(dm_channel_id, (select auth.uid())));

drop policy if exists "direct_messages_insert_author" on public.direct_messages;
create policy "direct_messages_insert_author"
    on public.direct_messages for insert
    to authenticated
    with check (
        author_id = (select auth.uid())
        and public.is_dm_participant(dm_channel_id, (select auth.uid()))
    );

drop policy if exists "direct_messages_update_author" on public.direct_messages;
create policy "direct_messages_update_author"
    on public.direct_messages for update
    to authenticated
    using (
        author_id = (select auth.uid())
        and public.is_dm_participant(dm_channel_id, (select auth.uid()))
    )
    with check (
        author_id = (select auth.uid())
        and public.is_dm_participant(dm_channel_id, (select auth.uid()))
    );

drop policy if exists "direct_messages_delete_author" on public.direct_messages;
create policy "direct_messages_delete_author"
    on public.direct_messages for delete
    to authenticated
    using (
        author_id = (select auth.uid())
        and public.is_dm_participant(dm_channel_id, (select auth.uid()))
    );

-- Extend profiles SELECT policy so friends and DM peers can always view each other's profiles
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
        or exists (
            select 1
            from public.friendships f
            where (f.requester_id = (select auth.uid()) and f.addressee_id = public.profiles.id)
               or (f.addressee_id = (select auth.uid()) and f.requester_id = public.profiles.id)
        )
        or exists (
            select 1
            from public.direct_channels dc
            where (dc.user_a = (select auth.uid()) and dc.user_b = public.profiles.id)
               or (dc.user_b = (select auth.uid()) and dc.user_a = public.profiles.id)
        )
    );

-- ---------------------------------------------------------------------------
-- 6. Supabase Realtime Publication & REPLICA IDENTITY FULL
-- ---------------------------------------------------------------------------

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'friendships'
        ) then
            alter publication supabase_realtime add table public.friendships;
        end if;

        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'direct_channels'
        ) then
            alter publication supabase_realtime add table public.direct_channels;
        end if;

        if not exists (
            select 1 from pg_publication_tables
            where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'direct_messages'
        ) then
            alter publication supabase_realtime add table public.direct_messages;
        end if;
    end if;
end $$;

alter table public.friendships replica identity full;
alter table public.direct_channels replica identity full;
alter table public.direct_messages replica identity full;
