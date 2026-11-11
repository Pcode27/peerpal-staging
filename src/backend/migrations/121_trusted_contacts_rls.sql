-- Enable RLS on trusted_contacts (added in migration 115, missed RLS gate).
-- Backend uses service role key (bypasses RLS); no policies needed.
ALTER TABLE public.trusted_contacts ENABLE ROW LEVEL SECURITY;
