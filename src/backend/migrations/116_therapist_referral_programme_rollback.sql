DROP TABLE IF EXISTS therapist_commission_payouts;
DROP TABLE IF EXISTS therapist_commissions;
DROP TABLE IF EXISTS therapist_referral_applications;

ALTER TABLE therapist_profiles
  DROP COLUMN IF EXISTS suspended_for_misconduct,
  DROP COLUMN IF EXISTS addendum_signed_at,
  DROP COLUMN IF EXISTS referred_by_therapist_id,
  DROP COLUMN IF EXISTS referral_code;
