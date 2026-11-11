-- Keep an active user's role/profile current in the client after an admin change.
do $$
begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') then
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='profiles') then
   alter publication supabase_realtime add table public.profiles;
  end if;
 end if;
end $$;
