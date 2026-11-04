-- Phase 58: therapist referral programme schema
ALTER TABLE therapist_profiles
  ADD COLUMN IF NOT EXISTS referral_code            VARCHAR(10)  UNIQUE NULL,
  ADD COLUMN IF NOT EXISTS referred_by_therapist_id UUID        NULL REFERENCES therapist_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS addendum_signed_at        TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS suspended_for_misconduct  BOOLEAN     NOT NULL DEFAULT false;

CREATE TABLE therapist_referral_applications (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_therapist_id UUID         NULL REFERENCES therapist_profiles(id) ON DELETE SET NULL,
  full_legal_name       VARCHAR(255) NOT NULL,
  email                 VARCHAR(255) NOT NULL,
  phone                 VARCHAR(30)  NULL,
  signature_name        VARCHAR(255) NOT NULL,
  agreement_signed_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ip_address            INET         NULL,
  doc_version           VARCHAR(20)  NOT NULL DEFAULT 'v1',
  status                VARCHAR(20)  NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','account_created','rejected')),
  admin_notes           TEXT         NULL,
  therapist_profile_id  UUID         NULL REFERENCES therapist_profiles(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_referral_apps_email  ON therapist_referral_applications (email);
CREATE INDEX idx_referral_apps_status ON therapist_referral_applications (status, created_at DESC);

CREATE TABLE therapist_commissions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_therapist_id UUID        NULL REFERENCES therapist_profiles(id) ON DELETE SET NULL,
  referred_therapist_id UUID        NOT NULL REFERENCES therapist_profiles(id),
  booking_id            UUID        NOT NULL REFERENCES therapist_bookings(id) UNIQUE,
  session_fee_kes       INTEGER     NOT NULL,
  commission_kes        INTEGER     NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','reversed')),
  period_ends_at        TIMESTAMPTZ NOT NULL,
  reversed_reason       VARCHAR(50) NULL
    CHECK (reversed_reason IN ('refund')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_commissions_referrer ON therapist_commissions (referrer_therapist_id, status, created_at);
CREATE INDEX idx_commissions_referred ON therapist_commissions (referred_therapist_id);

CREATE TABLE therapist_commission_payouts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_therapist_id UUID        NULL REFERENCES therapist_profiles(id) ON DELETE SET NULL,
  period_month          CHAR(7)     NOT NULL,
  total_commission_kes  INTEGER     NOT NULL,
  mpesa_number          VARCHAR(20) NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','failed')),
  idempotency_key       UUID        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  mpesa_reference       VARCHAR(100) NULL,
  initiated_at          TIMESTAMPTZ  NULL,
  completed_at          TIMESTAMPTZ  NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (referrer_therapist_id, period_month)
);
