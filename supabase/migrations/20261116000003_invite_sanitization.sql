-- Cafofo Invite Code Sanitization & Parallel Server Fix
-- Strips leading '#', whitespace, and normalizes case before matching servers.invite_code.

create or replace function public.join_server_by_invite(p_invite_code text)
returns public.servers
language plpgsql
security definer
set search_path = public
as $$
declare
    v_user_id uuid := auth.uid();
    v_clean_code text;
    v_server public.servers;
begin
    if v_user_id is null then
        raise exception 'Authentication required';
    end if;

    v_clean_code := lower(trim(regexp_replace(coalesce(p_invite_code, ''), '^#+', '')));
    if v_clean_code = '' then
        raise exception 'Invalid invite code';
    end if;

    select *
    into v_server
    from public.servers
    where lower(trim(invite_code)) = v_clean_code
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
