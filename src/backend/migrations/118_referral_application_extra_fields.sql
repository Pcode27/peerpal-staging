-- Phase 58: add professional_body, reg_number, message to referral applications
-- These fields are collected by TherapistJoinScreen but were never persisted.
ALTER TABLE therapist_referral_applications
  ADD COLUMN IF NOT EXISTS professional_body VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS reg_number        VARCHAR(50)  NULL,
  ADD COLUMN IF NOT EXISTS message           TEXT         NULL;
