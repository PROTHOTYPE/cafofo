-- Cafofo Realtime Messages Sync Fix (0006_realtime_messages_fix)
-- Ensures public.messages is included in supabase_realtime publication
-- and uses REPLICA IDENTITY FULL so INSERT/UPDATE/DELETE pass Realtime RLS filters.

do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (
           select 1
           from pg_publication_tables
           where pubname = 'supabase_realtime'
             and schemaname = 'public'
             and tablename = 'messages'
       )
    then
        alter publication supabase_realtime add table public.messages;
    end if;
end $$;

alter table public.messages replica identity full;
