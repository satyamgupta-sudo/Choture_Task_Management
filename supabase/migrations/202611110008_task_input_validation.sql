-- Mirror task form validations at the database boundary so direct RPC callers
-- cannot create oversized instructions or assignments with already-expired due dates.
create or replace function private.validate_new_task_input()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if length(trim(coalesce(new.title, ''))) not between 1 and 120 then
    raise exception 'Task title must be 1 to 120 characters';
  end if;
  if length(coalesce(new.description, '')) > 2000 then
    raise exception 'Task instructions must be 2000 characters or fewer';
  end if;
  if new.due_at is not null and new.due_at <= statement_timestamp() then
    raise exception 'Task deadline must be in the future';
  end if;
  return new;
end
$$;

revoke all on function private.validate_new_task_input() from public, anon, authenticated;

drop trigger if exists validate_new_task_input on public.tasks;
create trigger validate_new_task_input
before insert on public.tasks
for each row execute function private.validate_new_task_input();
