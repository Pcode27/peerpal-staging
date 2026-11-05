-- Phase 58: enable RLS on referral tables — deny anon access, service role bypasses RLS
ALTER TABLE therapist_referral_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE therapist_commissions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE therapist_commission_payouts    ENABLE ROW LEVEL SECURITY;
-- No permissive policies added: anon key gets no rows; backend (service role) is unaffected.
