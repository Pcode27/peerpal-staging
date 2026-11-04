# Phase 58 — Therapist Referral Programme

> Verified therapists recruit prospects by sharing a referral link. The prospect signs the Therapist Agreement on a public page and submits their details. Admin reviews, creates the account, and sends the invite. Once onboarded and verified, the new therapist goes to their Referrals tab, reads and signs the Referral Addendum, and their referral code is generated. They can then share their own link to recruit others. Commission (5% of session fee from PeerPal's 20%) accrues for 12 months from the referred therapist's go-live date.
>
> Build order: 58.1 schema → 58.2 public signing page → 58.3 backend endpoints → 58.4 admin subtab → 58.5 therapist portal tab → 58.6 commission engine → 58.7 payout job

---

## 58.1 Schema — Migration (`116_therapist_referral_programme.sql`)

**Columns on `therapist_profiles`:**
- `referral_code VARCHAR(10) UNIQUE NULL` — set when therapist signs Addendum in portal
- `referred_by_therapist_id UUID NULL REFERENCES therapist_profiles(id) ON DELETE SET NULL` — set when admin creates account from an application with a referrer
- `addendum_signed_at TIMESTAMPTZ NULL` — set when therapist signs Addendum in Referrals tab
- `suspended_for_misconduct BOOLEAN NOT NULL DEFAULT false` — separate from `suspended`; blocks future commission accrual when true

**New table: `therapist_referral_applications`**
```sql
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
```

**New table: `therapist_commissions`** — one row per eligible paid session
```sql
CREATE TABLE therapist_commissions (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_therapist_id UUID        NOT NULL REFERENCES therapist_profiles(id),
  referred_therapist_id UUID        NOT NULL REFERENCES therapist_profiles(id),
  booking_id            UUID        NOT NULL REFERENCES therapist_bookings(id) UNIQUE,
  session_fee_kes       INTEGER     NOT NULL,
  commission_kes        INTEGER     NOT NULL,  -- ROUND(session_fee_kes * 0.05)
  status                VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','reversed')),
  period_ends_at        TIMESTAMPTZ NOT NULL,  -- referred therapist's credentials_verified_at + 12 months
  reversed_reason       VARCHAR(50) NULL,      -- 'refund' only; misconduct blocks future rows, never reverses existing
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**New table: `therapist_commission_payouts`** — monthly rollup per referrer
> `therapist_payouts` cannot be reused — its `booking_id` is `NOT NULL UNIQUE`, incompatible with monthly aggregation.
```sql
CREATE TABLE therapist_commission_payouts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_therapist_id UUID        NOT NULL REFERENCES therapist_profiles(id),
  period_month          CHAR(7)     NOT NULL,  -- 'YYYY-MM' in EAT
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
```

**Utility update: `src/backend/utils/referralCode.js`**
- Add `generateTherapistReferralCode(db)` — same logic as existing `generateReferralCode` but checks `therapist_profiles.referral_code` for collisions, not `users.referral_code`
- Do NOT modify `generateReferralCode` (Phase 46 member referrals — Seka's code)

**Rollback:** `116_therapist_referral_programme_rollback.sql`

---

## 58.2 Public Signing Page

**Route:** `/join` in the therapist portal (`src/therapist/src/`) — public, no auth.
Add before the auth guard in `src/therapist/src/App.jsx`. Works with or without `?ref=XXXXXX`.

Shows the **Therapist Agreement only** (`docs/therapist-agreement.md`). The Referral Addendum is not shown here — it is signed by the therapist after onboarding in the Referrals tab.

**Step 1 — Read the Therapist Agreement**
- Render `docs/therapist-agreement.md` as formatted content
- If `?ref=XXXXXX` present: resolve the code silently on mount (`GET /api/therapy/referral-code/:code`); show a "You were referred by [display name]" banner on success; invalid code shows "This referral link is not valid" banner but the page still works
- Required checkbox: "I have read and understood the Therapist Agreement"

**Step 2 — Your details**
- Full legal name (required)
- Email (required)
- Phone / M-Pesa number (required)
- Professional body + registration number (optional)
- Brief message to PeerPal (optional, max 500 chars)

**Step 3 — Sign and submit**
- Field: "Type your full legal name as your electronic signature" — must match Step 2 name exactly (case-insensitive trim); inline error if mismatch
- Checkbox: "I confirm this is my electronic signature and I agree to the Therapist Agreement"
- Legal notice (small text): "Submitted [date] · constitutes a legally binding electronic signature under the Electronic Transactions Act 2007 (Kenya)"
- On submit: `POST /api/therapy/referral-applications`
- **Success:** "Application received. We'll contact you at [email] within 2 business days."
- **Duplicate email:** "An application with this email already exists — contact support@peer-pal.com"

---

## 58.3 Backend Endpoints

### Public (no auth)

**`GET /api/therapy/referral-code/:code`**
- Resolve code → return `{ valid: true, referrer_name: tp.display_name }` or `{ valid: false }`
- Used by the `/join` page on mount to show the referrer banner

**`POST /api/therapy/referral-applications`**
- Validate: full_legal_name, email, phone, signature_name required
- Signature name must match full_legal_name (case-insensitive trim); 400 if mismatch
- If `ref_code` present: resolve `referrer_therapist_id`; 400 `INVALID_REF` if not found
- Duplicate email check: 409 `DUPLICATE` if `status IN ('pending','account_created')` for same email
- Insert row; `ip_address = req.ip`
- Notify admin fire-and-forget
- Return `201 { received: true }`

### Authenticated therapist

**`POST /api/therapy/sign-addendum`** (therapist auth)
- Guard: therapist must be verified (`is_verified = true`); 403 if not
- Guard: not already signed (`addendum_signed_at IS NULL`); 409 `ALREADY_SIGNED` if already done
- In a transaction:
  - Generate referral code with `generateTherapistReferralCode(tx)`
  - `UPDATE therapist_profiles SET addendum_signed_at = NOW(), referral_code = $code WHERE id = $therapist_id`
- Return `{ referral_code, addendum_signed_at }`

**`GET /api/therapy/my-referrals`** (therapist auth)
- Return referred therapists: `SELECT id, display_name, is_verified, credentials_verified_at FROM therapist_profiles WHERE referred_by_therapist_id = $me ORDER BY created_at DESC`

**`GET /api/therapy/my-commissions`** (therapist auth)
- Return commission rows with booking date: JOIN `therapist_bookings` for session date and referred therapist name
- Summary totals: total earned, pending, paid

### Admin

**`GET /api/admin/referral-applications`** (admin auth)
- All applications `created_at DESC`; JOIN `therapist_profiles` for referrer display name
- Support `?status=pending` filter

**`PATCH /api/admin/referral-applications/:id`** (admin auth)
- Accept: `status`, `admin_notes`, `therapist_profile_id`
- When `therapist_profile_id` is set: also update `therapist_profiles SET referred_by_therapist_id = app.referrer_therapist_id` on that profile

---

## 58.4 Admin Panel — Applications Subtab

Inside `src/admin/src/tabs/TherapistsTab.jsx`:
- Add subtab toggle: "Therapists" | "Applications" (default: Therapists)
- **Applications table:** date, name, email, phone, referrer (or "Direct"), status badge, actions
- **"View" slide panel:** agreement timestamp, IP, message, admin notes (editable → PATCH on save), signature name
- **"Create Account" button:**
  - Pre-fills the Create Therapist modal with name + email from the application
  - On therapist creation success: PATCH application with `{ therapist_profile_id, status: 'account_created' }`; this also sets `referred_by_therapist_id` on the new profile via the PATCH handler above
  - The link is enforced — referrer attribution cannot be lost silently

---

## 58.5 Therapist Portal — Referrals Tab

New file: `src/therapist/src/tabs/ReferralsTab.jsx`
Add to `TABS` in `src/therapist/src/App.jsx` between Payments and Ratings.

**States:**

**A — Not yet verified**
> "Your referral link is generated once your credentials are verified and you have signed the Referral Addendum."

**B — Verified, Addendum not yet signed**
- Show full text of `docs/PeerPal_Referral_Addendum.md`
- Checkbox: "I have read and agree to the Referral Addendum"
- Button: "Sign and get my referral link" → `POST /api/therapy/sign-addendum`
- On success: transition to state C without page reload

**C — Addendum signed, referral code active**
- **My referral link:** display `https://therapist.peer-pal.com/join?ref=XXXXXX` + "Copy link" button (navigator.clipboard with fallback)
- **Referred therapists:** list from `GET /api/therapy/my-referrals` — display name, status badge (pending / verified / live), joined date, commission period end
- **Commission history:** summary (total earned / pending / paid) + rows table (session date, referred therapist, session fee KES, commission KES, status badge)
- Empty states for referred therapists and commissions when none yet

---

## 58.6 Commission Engine

**Hook location: `src/backend/jobs/escrowReleaseJob.js`**

After `UPDATE therapist_bookings SET escrow_status = 'released'`, before the notification:

```js
const { rows: ref } = await query(
  `SELECT tp.referred_by_therapist_id, tp.credentials_verified_at,
          b.session_fee_kes
   FROM therapist_profiles tp
   JOIN therapist_bookings b ON b.id = $1
   WHERE tp.id = $2
     AND tp.referred_by_therapist_id IS NOT NULL
     AND tp.suspended_for_misconduct = false
     AND tp.credentials_verified_at + INTERVAL '12 months' > NOW()`,
  [row.id, row.therapist_id]
);
if (ref.length) {
  const r = ref[0];
  const commission_kes = Math.round(r.session_fee_kes * 0.05);
  const period_ends_at = new Date(new Date(r.credentials_verified_at).getTime() + 365.25 * 24 * 3600 * 1000);
  await query(
    `INSERT INTO therapist_commissions
       (referrer_therapist_id, referred_therapist_id, booking_id,
        session_fee_kes, commission_kes, period_ends_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (booking_id) DO NOTHING`,
    [r.referred_by_therapist_id, row.therapist_id, row.id,
     r.session_fee_kes, commission_kes, period_ends_at]
  );
}
```

**Misconduct (`suspended_for_misconduct = true`):**
- The query above skips commission insertion for any future escrow releases on that therapist
- Existing `pending` commission rows are **not touched** — they pay out normally in the next monthly run
- Admin sets `suspended_for_misconduct = true` via a new `PATCH /api/admin/therapists/:id/misconduct` endpoint (or extend the existing suspend route with a `misconduct: true` body param)

**On refund (`src/backend/utils/therapyRefund.js`):**
- `UPDATE therapist_commissions SET status = 'reversed', reversed_reason = 'refund' WHERE booking_id = $1 AND status = 'pending'`
- If commission was already `paid`: log for manual admin deduction from next payout (Addendum §2.3)

---

## 58.7 Monthly Payout Job

File: `src/backend/jobs/referralPayoutJob.js`
Cron: 1st of each month, 08:00 EAT (`0 8 1 * *` with `TZ=Africa/Nairobi`)

```
1. Compute previous calendar month in EAT (YYYY-MM)
2. SELECT referrer_therapist_id, SUM(commission_kes) AS total
   FROM therapist_commissions
   WHERE status = 'pending'
     AND created_at < NOW() - INTERVAL '48 hours'
     AND TO_CHAR(created_at AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM') = previous_month
   GROUP BY referrer_therapist_id
3. For each referrer with total > 0:
   a. Fetch mpesa_number from therapist_profiles
   b. INSERT INTO therapist_commission_payouts
        (referrer_therapist_id, period_month, total_commission_kes, mpesa_number)
      ON CONFLICT (referrer_therapist_id, period_month) DO NOTHING
      RETURNING id
   c. UPDATE therapist_commissions SET status = 'paid'
      WHERE referrer_therapist_id = $1 AND status = 'pending'
        AND TO_CHAR(created_at AT TIME ZONE 'Africa/Nairobi', 'YYYY-MM') = previous_month
   d. Initiate Daraja B2C payout using same pattern as therapistPayout.js
```

Wire into `src/backend/server.js` cron scheduler alongside existing jobs.

---

## 58.8 Verification Checklist

- [ ] `/join` loads without auth, with and without `?ref=`
- [ ] Valid `?ref=` shows referrer name banner
- [ ] Invalid `?ref=` shows warning banner; page still usable
- [ ] Duplicate email returns clear error
- [ ] Submission appears in admin Applications subtab
- [ ] "Create Account" pre-fills form; application updates to `account_created`; `referred_by_therapist_id` set on new profile
- [ ] Unverified therapist sees state A in Referrals tab
- [ ] Verified therapist sees Addendum (state B); signs it; referral code appears (state C) without reload
- [ ] Referral link copy button works on mobile
- [ ] Referred therapist appears in referrer's tab once verified
- [ ] Paid session (escrow release) → commission row inserted
- [ ] `suspended_for_misconduct = true` → no new commission rows; existing pending rows still pay out
- [ ] Refunded session → commission row reversed
- [ ] Monthly payout job aggregates correct month in EAT; inserts payout; marks commissions paid
