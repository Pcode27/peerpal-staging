ALTER TABLE therapist_referral_applications
  DROP COLUMN IF EXISTS professional_body,
  DROP COLUMN IF EXISTS reg_number,
  DROP COLUMN IF EXISTS message;
