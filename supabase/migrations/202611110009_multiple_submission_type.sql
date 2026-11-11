-- Add the enum value in its own migration so it is committed before later
-- migrations/functions use it. Existing enum values and task records remain intact.
alter type public.submission_kind add value if not exists 'MULTIPLE';
