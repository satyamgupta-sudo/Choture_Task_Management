insert into public.departments(name) values ('Kitchen'),('Front of House'),('Bar'),('Cleaning') on conflict(name) do nothing;
-- Add team members through Supabase Auth; the trigger creates their employee profiles. Set department_id on profiles afterward.
