# Mental Health Application Blueprint — v2.1
> Status: CURRENT. Reflects production state as of 2026-10-20. Verified against codebase 2026-10-20.

---

## 1. PURPOSE

A mobile-first mental health support platform for the Kenyan market, built around anonymity, accessibility, and genuine care. Connects users to peer support, AI-assisted conversation, structured self-help tools, community groups, and professional therapists — within a low-cost, low-friction experience.

**Core Problems Being Solved:**
- Mental health support in Kenya is expensive (KSh 500–1,000/session), stigmatized, and inaccessible outside urban centres
- People in distress need immediate, anonymous, human connection — not a waiting list
- Existing apps are foreign-built and culturally misaligned
- Peer support is underutilized as a scalable care model

**Platform Priorities:**
- Anonymity by default — no real identity ever required
- Minimal cognitive load — fast access to help, especially in crisis
- Structured, analyzable data — mood, risk, escalation patterns
- AI as a companion, never a clinician
- Emergency button always visible; escalation reaches admin queue (no guaranteed response SLA)

---

## 2. CORE PRINCIPLES

1. No identity exposure — alias only, always
2. Minimal UI — every screen has one clear action
3. Data is structured — every field typed and purposeful
4. AI is assistive, not authoritative — supports, redirects, never diagnoses
5. Human escalation is always available — no dead ends
6. Safety is architectural — risk scoring, guardrails, and escalation woven into every module
7. Care is not paywalled — AI, journaling, resources, breathing, and emergency are always free
8. Credits gate peer interaction time only — not access to safety

---

## 3. TECHNOLOGY STACK

| Layer | Technology | Notes |
|---|---|---|
| AI / LLM | Groq API (`openai/gpt-oss-120b` primary, `qwen/qwen3.8-27b` fallback) | OpenAI-compatible endpoint; third-party data processor — must be disclosed in consent |
| Backend | Node.js + Express | Pino structured logging |
| Database | PostgreSQL (Supabase) | RLS enabled on all tables |
| Auth | Supabase Auth | Leaked password protection — **owner action: enable in Supabase dashboard** |
| Payments | IntaSend (M-Pesa + cards) | Replaced Paystack — KE-first, Daraja B2C for therapist payouts |
| Push Notifications | Firebase Cloud Messaging (FCM) | Android + PWA; service worker handles background |
| Voice / Video | WebRTC (peer-to-peer, anonymous) | Therapist sessions use signaling server |
| Hosting | Render (backend) + Vercel (frontends) | Docker image on Render |
| Cache / Queue | Redis (ioredis) | BullMQ job queues |
| Error tracking | Sentry | All three portals — PII scrubbed |
| Analytics | PostHog | `privacyMode: true` — prompts/responses not stored |
| Container | Docker (node:20-alpine, non-root) | docker-compose for local dev |
| CI/CD | GitHub Actions | PR gate → staging auto-deploy → manual production release |

---

## 4. USER ROLES & PERMISSIONS

### 4.1 Member
- Access all support modules (AI Chat, Peer Support, Journal, Groups, Resources, Emergency)
- Anonymous — alias only
- Can purchase and spend credits
- Can file group reports
- Can delete own data
- Cannot see other members' identities

### 4.2 Admin
- Full system dashboard access (3 portals: member app admin tab, dedicated admin portal)
- Receives emergency alerts and peer escalation alerts
- Manages therapist onboarding, bookings, disputes
- Moderates groups (view reports, issue warnings, ban users)
- Manages credit packages, promo codes, psychoeducation content
- Sees alias only — never email or real identity

### 4.3 Therapist
- Dedicated therapist portal (separate app at port 5176 / subdomain)
- Onboarding: agreement acknowledgement, KCPA registration number, availability schedule
- Receives bookings from member marketplace
- Conducts video sessions via in-app WebRTC room
- Private notes drawer (Alt+N): auto-saves to localStorage (debounced 500ms); explicit "Save to session record" button posts to `/api/therapy/session-notes` → stored in `therapy_session_notes` table (plaintext — encryption at rest not yet implemented)
- Payments via Daraja B2C disbursement per completed session
- Ratings visible on profile; disputes routed to admin

---

## 5. ONBOARDING FLOW

Linear and mandatory. No module accessible until complete.

**Step 1 — Anonymous Registration**
- Email (recovery only, never displayed), password
- Date of birth (month + year) — **18+ gate enforced in backend** (`UNDERAGE` error returned; no bypass)
- Optional: referral code entry (applied after registration)

**Step 2 — Alias Generation**
- System-assigned: [Adjective] + [Animal] + [Number] (e.g. CalmHeron42)
- Not user-chosen — anonymity protection

**Step 3 — Role Selection**
- Member only (self-registration). Admin + therapist accounts created manually.

**Step 4 — Data Consent Agreement**
- Plain-language consent: what's collected, how used, right to delete, flagged interaction retention
- Third-party AI disclosure: conversations are processed by Groq API (third-party LLM provider) — **currently missing from consent UI; must be added before launch**
- Community standards agreement for group participation
- `consent_version` stored on user record

**Step 5 — AI Persona Creation (Mandatory, Immutable)**
- Persona name, tone, response style, formality, alias-use toggle
- Preview snippet before confirmation
- Written to AI_Personas — read-only thereafter

**Step 6 — First Mood Check-In**

**Step 7 — Signup Credit Bonus**
- 2 free credits (signup_bonus_credited flag gates one-time grant)

**Step 8 — Free Trial Activation**
- 2 immediate trial credits + 2/day drip for 7 days (14 cap total)
- Trial AI sessions capped at 10 during trial period
- Copy: "2 credits to start, then 2 more each morning this week"

**Step 9 — Dashboard**

---

## 6. CREDIT SYSTEM

### 6.1 What Credits Are
In-app currency gating peer interaction time. AI chat, journaling, resources, breathing, and emergency are always free.

### 6.2 Credit Packages (KSh)

| Package | Price | Credits | AI Conversations |
|---|---|---|---|
| Standard | KSh 150 | 10 | 4 |
| Plus | KSh 300 | 25 | 10 |
| Premium | KSh 500 | 50 | 20 |

AI conversations are bundled with credit purchases — they are not sold separately.

### 6.3 Credit Rates

| Channel | Rate | Notes |
|---|---|---|
| Text chat (peer) | 1 credit / session | Duration tracked but not billed per-minute |
| Voice call (peer) | 2 credits / session | |
| Therapist session | Fixed per booking (set by therapist) | 20% platform fee retained; 80% disbursed to therapist via Daraja B2C |

**Peer earnings:** Peer supporter earns 25% of requester's credit spend per session.

### 6.4 Credit Billing Rules
- Zero balance blocks session start; shows top-up prompt
- Text: soft warning at 1 credit remaining
- Voice: 2-minute grace buffer on last credit; in-call audio prompt
- Purchased credits never expire
- Trial credits expire 7 days after claim; tracked separately in ledger
- Referral reward credits: 3 credits per qualified referral

### 6.5 Payment Flow (IntaSend)
1. User taps "Buy Credits"
2. Selects package
3. IntaSend STK push sent to phone (M-Pesa) or card checkout
4. IntaSend sends webhook to backend
5. Backend verifies signature; atomic `UPDATE ... AND status='pending' RETURNING` claim
6. Credits table updated; CreditTransaction written; user notified
7. On failure: row stays pending; logs `RECONCILIATION NEEDED`

---

## 7. FRONTEND MODULES

### 7.1 Dashboard
- Top bar: alias, credit balance, notification bell
- Daily streak counter
- Six action tiles: Peer Help | AI Chat | Therapist | Journal | Groups | Emergency
- Re-engagement banners: step-aware copy based on `reengagement_step`
- Bottom nav: Home | Resources | Breathing | Profile

### 7.2 Mood Check-In
- 5-level selector (Very Low → Great) + optional note + tag multi-select
- Feeds risk score recalculation job
- Very Low mood: soft prompt → AI Chat / Peer Help / Emergency / Not Now
- Streak incremented on first check-in of calendar day

### 7.3 Peer Support
- Text or voice request; 90s broadcast to active members
- Neither party sees the other's alias
- Credits deducted in real-time
- Post-session: anonymous 1–5 star feedback

### 7.4 AI Chat
- **1 free conversation per rolling 7-day window** (tracked via `free_ai_used_at`)
- After free session used: draws from `ai_conversations_cap` purchased via credit bundles
- Trial users: 10 AI sessions total (tracked via `trial_ai_sessions_used`)
- Persona-driven; safety system prompt immutable
- Risk classifier runs before LLM; critical → emergency screen pushed

### 7.5 Therapist Marketplace
- Browse licensed therapists by category, price, availability
- Book a slot → in-app video session (WebRTC)
- Pre-session consent screen
- Post-session: rating + dispute flow
- Therapist paid via Daraja B2C per completed session

### 7.6 Journaling
- Free text, linked to mood entry, risk-flagged on save
- Paginated history with search + filter

### 7.7 Groups
- 8 condition categories (anxiety, depression, OCD, ADHD, grief, loneliness, stress, general)
- **Not open chat** — structured interaction only: admin-posted prompts (1 response per member), polls (multi-choice with vote tracking), announcements (no replies), emoji reactions
- Community agreement gate on join
- Member responses are risk-classified on post
- Report → admin moderation queue; admin can warn, ban

### 7.8 Emergency
- Always visible, always full-colour
- Triggers Emergency_Log + immediate admin push
- Pre-loaded: Befrienders Kenya 0800 723 253

### 7.9 Profile
- Alias, streak, credit balance, trial status
- Notification preferences (including night alerts opt-in)
- Safety plan editor
- Data deletion flow (24hr grace period)

### 7.10 Psychoeducation / Resource Library
- Articles by category; admin-managed
- Free, no auth required for browsing

### 7.11 Breathing & Grounding Exercises
- Static frontend; free

### 7.11a Calm Space
- Triggered when no peer is available after routing timeout
- Offers: AI companion chat, "Let it out" (voice transcription or text venting), breathing exercises, calming sounds
- Vents can be saved to journal or discarded — not auto-stored

### 7.12 Mood Analytics / Insights
- Aggregated mood trend charts; reads Moods table

### 7.13 Safety Plan
- Personal crisis plan: warning signs, helpful things, contacts (max 3), reason to continue
- Pre-populated with Befrienders Kenya resource

### 7.14 Daily Check-In Streak
- `streak_count` + `last_checkin_at` on Users
- Milestones: 3, 7, 30 days

### 7.15 Anonymous Feedback
- Post-session (peer/AI) or general; no user_id stored

### 7.16 Admin Dashboard
- Emergency queue, escalations, referrals, group reports, risk flags
- Stats, audit log, content management, promo codes, config flags
- Permission flags per feature

### 7.17 Free Trial & Promo Codes
- Campus promo codes: admin-created, redemption-limited, credit grant
- Trial: 14-credit drip over 7 days, 10 AI session cap, expiry removes unused trial credits

### 7.18 Referral System
- Each member gets a unique referral code/link
- Referrer earns 3 credits when referee completes first peer session
- Admin tab shows referral stats

---

## 8. BACKEND SCHEMA

### 8.1 Users
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| alias | VARCHAR(50) UNIQUE NOT NULL | System-generated |
| email | VARCHAR(255) UNIQUE NOT NULL | Encrypted, recovery only |
| password_hash | VARCHAR NOT NULL | Bcrypt cost 12+ |
| role | ENUM('member','admin','therapist') DEFAULT 'member' | |
| is_active | BOOLEAN DEFAULT true | |
| risk_level | ENUM('low','medium','high','critical') DEFAULT 'low' | 24hr job |
| streak_count | INTEGER DEFAULT 0 | |
| last_checkin_at | TIMESTAMP NULL | |
| signup_bonus_credited | BOOLEAN DEFAULT false | |
| consent_version | VARCHAR(10) NOT NULL | |
| consented_at | TIMESTAMP NOT NULL | |
| persona_created | BOOLEAN DEFAULT false | |
| scheduled_deletion_at | TIMESTAMP NULL | |
| onboarding_completed_at | TIMESTAMP NULL | Re-engagement funnel |
| first_session_completed_at | TIMESTAMP NULL | Re-engagement funnel |
| last_session_at | TIMESTAMP NULL | Re-engagement funnel |
| reengagement_step | ENUM('step1_incomplete','step2_no_session','step3_lapsed','converted') DEFAULT 'step1_incomplete' | |
| last_reengagement_push_at | TIMESTAMP NULL | |
| engagement_score | SMALLINT NULL | Recency/frequency/breadth/history composite |
| engagement_segment | VARCHAR(10) NULL | e.g. 'high','medium','low','dormant' |
| trial_claimed_at | TIMESTAMP NULL | |
| trial_credits_granted | INTEGER DEFAULT 0 | Running total dripped |
| trial_ai_sessions_used | INTEGER DEFAULT 0 | Capped at 10 |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | |

### 8.2 AI_Personas
One record per user. Written once at onboarding. Read-only thereafter.

| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id UNIQUE NOT NULL | |
| persona_name | VARCHAR(20) NOT NULL | |
| tone | ENUM('warm','motivational','clinical','casual') NOT NULL | |
| response_style | ENUM('brief','elaborate') NOT NULL | |
| formality | ENUM('formal','neutral','informal') NOT NULL | |
| uses_alias | BOOLEAN DEFAULT true | |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.3 Moods
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id NOT NULL | |
| mood_level | ENUM('very_low','low','neutral','good','great') NOT NULL | |
| tags | TEXT[] NULL | |
| note | VARCHAR(200) NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.4 Sessions
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id NOT NULL | |
| type | ENUM('peer','ai','therapist') NOT NULL | |
| channel | ENUM('text','voice','video') NULL | |
| status | ENUM('active','completed','abandoned') DEFAULT 'active' | |
| credit_cost | INTEGER DEFAULT 0 | |
| peer_request_id | UUID FK → PeerRequests.id NULL | |
| booking_id | UUID FK → Bookings.id NULL | Therapist sessions |
| started_at | TIMESTAMP DEFAULT NOW() | |
| ended_at | TIMESTAMP NULL | |

### 8.5 PeerRequests
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id NOT NULL | |
| channel_preference | ENUM('text','voice') NOT NULL | |
| status | ENUM('open','locked','active','escalated','closed') DEFAULT 'open' | |
| accepted_by | UUID FK → Users.id NULL | |
| session_id | UUID FK → Sessions.id NULL | |
| escalation_job_id | VARCHAR NULL | |
| escalated_at | TIMESTAMP NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | |

### 8.6 AI_Interactions
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id NULL | Nulled on deletion |
| session_id | UUID FK → Sessions.id NOT NULL | |
| input_text | TEXT NOT NULL | |
| output_text | TEXT NOT NULL | |
| context_snapshot | JSONB NULL | |
| flagged | BOOLEAN DEFAULT false | |
| flag_reason | VARCHAR(100) NULL | |
| retention_flag | BOOLEAN DEFAULT true | |
| scheduled_deletion_at | TIMESTAMP NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.7 Credits
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id UNIQUE NOT NULL | |
| balance | INTEGER DEFAULT 0 NOT NULL | |
| ai_session_allowance | INTEGER DEFAULT 0 | Trial AI session balance |
| updated_at | TIMESTAMP DEFAULT NOW() | |

### 8.8 CreditTransactions
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id NOT NULL | |
| type | ENUM('purchase','debit','bonus','trial','referral') NOT NULL | |
| amount_credits | INTEGER NOT NULL | Positive for all rows; sign derived from type |
| amount_currency | DECIMAL(10,2) NULL | KSh; null for non-purchase rows |
| currency_code | VARCHAR(3) DEFAULT 'KES' | |
| payment_method | ENUM('mpesa','card','bonus','platform','referral','trial') NOT NULL | |
| payment_reference | VARCHAR(100) NULL | IntaSend transaction reference |
| session_id | UUID FK → Sessions.id NULL | |
| channel | ENUM('text','voice','video','purchase') NOT NULL | |
| status | ENUM('pending','confirmed','failed') DEFAULT 'pending' | |
| event_ref | VARCHAR(100) NULL | Idempotency key |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.9 Notifications
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id NOT NULL | |
| type | ENUM (see list below) NOT NULL | |
| payload | JSONB NOT NULL | |
| channel | ENUM('push','in_app') NOT NULL | |
| status | ENUM('pending','sent','failed','read') DEFAULT 'pending' | |
| event_ref | VARCHAR(100) NULL UNIQUE | Dedup key |
| created_at | TIMESTAMP DEFAULT NOW() | |
| sent_at | TIMESTAMP NULL | |
| read_at | TIMESTAMP NULL | |

**Notification types:** `peer_request_broadcast`, `peer_escalation`, `session_confirmation`, `therapist_referral_update`, `emergency_alert`, `group_message`, `group_warning`, `data_deletion_confirmed`, `credit_low`, `credit_purchase_confirmed`, `check_in_reminder`, `milestone`, `reengagement_step1`, `reengagement_step2`, `reengagement_step3`, `reengagement_purchase`, `trial_reminder`, `trial_expired`, `referral_reward`, `booking_confirmed`, `booking_reminder`, `booking_cancelled`

### 8.10 Journals
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id NOT NULL | |
| mood_id | UUID FK → Moods.id NULL | |
| mood_level | ENUM('very_low','low','neutral','good','great') NULL | Denormalized |
| tags | TEXT[] NULL | |
| content | TEXT NOT NULL | |
| risk_flagged | BOOLEAN DEFAULT false | |
| scheduled_deletion_at | TIMESTAMP NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | |

### 8.11 SafetyPlans
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id UNIQUE NOT NULL | |
| warning_signs | TEXT NULL | |
| helpful_things | TEXT NULL | |
| things_to_avoid | TEXT NULL | |
| contacts | JSONB NULL | [{name, contact_detail (encrypted)}] max 3 |
| emergency_resources | TEXT NULL | Pre-populated: Befrienders Kenya |
| reason_to_continue | TEXT NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | |

### 8.12 Groups
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| name | VARCHAR(100) NOT NULL | |
| condition_category | ENUM('anxiety','depression','ocd','adhd','grief','loneliness','stress','general_support') NOT NULL | |
| description | TEXT NULL | |
| created_by | UUID FK → Users.id NOT NULL | |
| is_active | BOOLEAN DEFAULT true | |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.13 GroupMemberships
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| group_id | UUID FK → Groups.id NOT NULL | |
| user_id | UUID FK → Users.id NOT NULL | |
| status | ENUM('active','banned','left') DEFAULT 'active' | |
| agreed_at | TIMESTAMP NOT NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| UNIQUE | (group_id, user_id) | |

### 8.14 GroupMessages
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| group_id | UUID FK → Groups.id NOT NULL | |
| user_id | UUID FK → Users.id NOT NULL | |
| content | TEXT NOT NULL | |
| is_deleted | BOOLEAN DEFAULT false | |
| deleted_by | UUID FK → Users.id NULL | |
| is_pinned | BOOLEAN DEFAULT false | |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.15 GroupReports
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| group_id | UUID FK → Groups.id NOT NULL | |
| reported_user_id | UUID FK → Users.id NOT NULL | |
| reported_by | UUID FK → Users.id NOT NULL | |
| message_id | UUID FK → GroupMessages.id NULL | |
| reason | ENUM('harmful_content','abuse','spam','other') NOT NULL | |
| details | TEXT NULL | |
| status | ENUM('pending','reviewed','actioned','dismissed') DEFAULT 'pending' | |
| admin_action | ENUM('warn','ban','dismiss') NULL | |
| admin_notes | TEXT NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| reviewed_at | TIMESTAMP NULL | |

### 8.16 GroupBans
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| group_id | UUID FK → Groups.id NOT NULL | |
| user_id | UUID FK → Users.id NOT NULL | |
| reason | TEXT NOT NULL | |
| banned_by | UUID FK → Users.id NOT NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| expires_at | TIMESTAMP NULL | Null = permanent |

### 8.17 Emergency_Logs
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id NOT NULL | |
| trigger_type | ENUM('user_initiated','ai_escalation','peer_timeout') NOT NULL | |
| status | ENUM('open','acknowledged','resolved') DEFAULT 'open' | |
| handled_by | UUID FK → Users.id NULL | |
| triggered_at | TIMESTAMP DEFAULT NOW() | |
| acknowledged_at | TIMESTAMP NULL | |
| resolved_at | TIMESTAMP NULL | |
| notes | TEXT NULL | |

### 8.18 Escalation_Logs
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id NOT NULL | |
| session_id | UUID FK → Sessions.id NOT NULL | |
| trigger_type | ENUM('keyword','risk_score','repeated_flag') NOT NULL | |
| trigger_detail | VARCHAR(200) NULL | |
| escalated_to | ENUM('admin','emergency') NOT NULL | |
| status | ENUM('open','acknowledged','resolved') DEFAULT 'open' | |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.19 TherapistReferrals (legacy intake form)
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id NOT NULL | |
| struggles | TEXT NOT NULL | |
| preferred_time | ENUM('morning','afternoon','evening') NOT NULL | |
| contact_method | ENUM('in_app','phone') NOT NULL | |
| contact_detail | TEXT NULL | Encrypted |
| specific_needs | TEXT NULL | |
| status | ENUM('pending','in_review','arranged','escalated','closed') DEFAULT 'pending' | |
| admin_notes | TEXT NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | |

### 8.20 TherapistProfiles
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id UNIQUE NOT NULL | |
| display_name | VARCHAR(100) NOT NULL | |
| bio | TEXT NULL | |
| specializations | TEXT[] NULL | |
| rate_per_session | INTEGER NOT NULL | KSh |
| kcpa_registration | VARCHAR(50) NULL | |
| agreement_acknowledged | BOOLEAN DEFAULT false | Required before onboarding_complete |
| onboarding_complete | BOOLEAN DEFAULT false | |
| is_active | BOOLEAN DEFAULT true | |
| average_rating | DECIMAL(3,2) NULL | |
| session_count | INTEGER DEFAULT 0 | |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.21 TherapistAvailability
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| therapist_id | UUID FK → Users.id NOT NULL | |
| day_of_week | SMALLINT NOT NULL | 0=Sun … 6=Sat |
| start_time | TIME NOT NULL | |
| end_time | TIME NOT NULL | |

### 8.22 Bookings
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| member_id | UUID FK → Users.id NOT NULL | |
| therapist_id | UUID FK → Users.id NOT NULL | |
| scheduled_at | TIMESTAMP NOT NULL | |
| duration_minutes | INTEGER NOT NULL | |
| status | ENUM('pending','confirmed','completed','cancelled','disputed') DEFAULT 'pending' | |
| room_token | VARCHAR NULL | WebRTC room |
| member_consent_at | TIMESTAMP NULL | |
| session_notes_saved | BOOLEAN DEFAULT false | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | |

### 8.23 TherapistRatings
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| booking_id | UUID FK → Bookings.id UNIQUE NOT NULL | |
| member_id | UUID FK → Users.id NOT NULL | |
| therapist_id | UUID FK → Users.id NOT NULL | |
| rating | SMALLINT CHECK (1–5) NOT NULL | |
| comment | VARCHAR(300) NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.24 Feedback
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| type | ENUM('peer_session','ai_chat','bug','general') NOT NULL | |
| rating | SMALLINT NULL | 1–5 |
| comment | VARCHAR(300) NULL | |
| session_id | UUID FK → Sessions.id NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |

No user_id — fully anonymous by design.

### 8.25 PsychoeducationArticles
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| title | VARCHAR(200) NOT NULL | |
| category | ENUM('anxiety','depression','ocd','adhd','grief','loneliness','stress','general_wellness','crisis_support') NOT NULL | |
| content | TEXT NOT NULL | Markdown |
| estimated_read_minutes | SMALLINT NOT NULL | |
| tags | TEXT[] NULL | |
| status | ENUM('published','draft','archived') DEFAULT 'draft' | |
| created_by | UUID FK → Users.id NOT NULL | |
| published_at | TIMESTAMP NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |
| updated_at | TIMESTAMP DEFAULT NOW() | |

### 8.26 PromoCodes
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| code | VARCHAR(50) UNIQUE NOT NULL | |
| credits_granted | INTEGER NOT NULL | |
| max_redemptions | INTEGER NULL | Null = unlimited |
| redemption_count | INTEGER DEFAULT 0 | |
| expires_at | TIMESTAMP NULL | |
| is_active | BOOLEAN DEFAULT true | |
| created_by | UUID FK → Users.id NOT NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.27 PromoCodeRedemptions
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| promo_code_id | UUID FK → PromoCodes.id NOT NULL | |
| user_id | UUID FK → Users.id NOT NULL | |
| credits_granted | INTEGER NOT NULL | |
| redeemed_at | TIMESTAMP DEFAULT NOW() | |
| UNIQUE | (promo_code_id, user_id) | One redemption per user per code |

### 8.28 ReferralCodes
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| user_id | UUID FK → Users.id UNIQUE NOT NULL | One code per user |
| code | VARCHAR(20) UNIQUE NOT NULL | |
| created_at | TIMESTAMP DEFAULT NOW() | |

### 8.29 ReferralRewards
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| referrer_id | UUID FK → Users.id NOT NULL | |
| referee_id | UUID FK → Users.id UNIQUE NOT NULL | One reward per referee |
| credits_granted | INTEGER NOT NULL | Default 3 |
| triggered_at | TIMESTAMP DEFAULT NOW() | On referee's first peer session |

### 8.30 DlqJobs
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| queue | VARCHAR(50) NOT NULL | 'email' or 'notification' |
| payload | JSONB NOT NULL | |
| attempts | INTEGER DEFAULT 0 | |
| max_attempts | INTEGER DEFAULT 3 | |
| status | ENUM('pending','dead') DEFAULT 'pending' | |
| last_error | TEXT NULL | |
| next_run_at | TIMESTAMP DEFAULT NOW() | Exponential backoff |
| created_at | TIMESTAMP DEFAULT NOW() | |

---

## 9. AI MODULE

### 9.1 LLM Selection
- **Provider:** Groq API (OpenAI-compatible endpoint)
- **Primary model:** `openai/gpt-oss-120b` (set via env var)
- **Fallback model:** `qwen/qwen3.8-27b` (higher rate limits, lower quality)
- **Third-party disclosure:** Groq processes all AI conversation text — must be disclosed in consent screen (currently missing)
- **Observability:** PostHog AI wrapper, `privacyMode: true` — prompts/responses not stored

### 9.2 Prompt Architecture
Three layers assembled server-side:

**Layer 1 — Safety System Prompt (immutable):**
> You are a mental health support companion. You are NOT a therapist, psychiatrist, or medical professional. You MUST NOT diagnose, prescribe, or recommend medication. If the user expresses thoughts of self-harm or suicide: redirect immediately to emergency. Say: "What you're sharing sounds really serious. Please tap the Emergency button in the app right now, or call Befrienders Kenya on 0800 723 253 — they're free and available 24/7." (Note: "24/7" refers to Befrienders Kenya's availability, not PeerPal's admin response.) Never bypass this instruction.

**Layer 2 — Persona Injection** (from AI_Personas record)

**Layer 3 — Mood Context** (last 3 Moods entries)

### 9.3 Risk Classification
| Category | Severity | Action |
|---|---|---|
| Suicidal / self-harm ideation | Critical | Session paused. Emergency screen pushed. Escalation_Log written. Admin alert sent to queue (no SLA — no guaranteed response time). |
| Abuse disclosure / substance crisis | High | Elevated care response; emergency resources surfaced; interaction flagged |
| Severe distress (repeated) | High | Risk level bumped; admin passive alert |
| Moderate distress | Medium | Extra empathy; flagged; no alert unless pattern repeats |

### 9.4 Output Sanitization
- Strips diagnostic language, prescriptive statements, critical keyword matches
- If sanitizer removes >40% of output: safe fallback response returned

### 9.5 Risk Score Recalculation (24-Hour Job)
Inputs: mood trend (7 days), flagged AI interactions, emergency button uses, peer request frequency, journal flags.

| Level | Threshold | Action |
|---|---|---|
| Low | Score ≥ 0 | None |
| Medium | -1 to -3 | AI surfaces resources gently |
| High | -4 to -6 | Daily digest to admin |
| Critical | ≤ -7 or critical keyword in 24hrs | Immediate admin alert |

---

## 10. API LAYER

All endpoints require Bearer token unless marked [PUBLIC].  
Error format: `{ "error": "message", "code": "ERROR_CODE" }`

### 10.1 Authentication
| Method | Endpoint | Description |
|---|---|---|
| POST | /auth/register | Register — returns token + alias |
| POST | /auth/login | Login — returns token |
| POST | /auth/logout | Invalidate token |
| POST | /auth/recover | Password reset email |

### 10.2 Onboarding
| Method | Endpoint | Description |
|---|---|---|
| POST | /onboarding/consent | Record consent |
| POST | /onboarding/persona | Create AI persona (one-time) |
| GET | /onboarding/status | Step completion status |
| PATCH | /onboarding/complete | Therapist onboarding completion gate |

### 10.3 Mood
| Method | Endpoint | Description |
|---|---|---|
| POST | /moods | Create entry; trigger streak update |
| GET | /moods/history | Paginated history |
| GET | /moods/analytics | Aggregated data |
| GET | /moods/today | Today's entry |

### 10.4 Journal
| Method | Endpoint | Description |
|---|---|---|
| POST | /journals | Create; risk classifier runs |
| GET | /journals | Paginated list |
| GET | /journals/:id | Single entry |
| PATCH | /journals/:id | Update |
| DELETE | /journals/:id | Delete single |
| DELETE | /journals | Delete all |

### 10.5 Peer Support
| Method | Endpoint | Description |
|---|---|---|
| POST | /peer/request | Create request; broadcast notification |
| GET | /peer/requests/open | Open requests (responders) |
| PATCH | /peer/request/:id/accept | Accept; lock; create session |
| PATCH | /peer/request/:id/close | End session |
| GET | /peer/session/:id | Session details |

### 10.6 AI Chat
| Method | Endpoint | Description |
|---|---|---|
| POST | /ai/session/start | Start session; assemble prompt |
| POST | /ai/session/:id/message | Send message; classify; call Groq; sanitize |
| POST | /ai/session/:id/end | End session |

### 10.7 Credits
| Method | Endpoint | Description |
|---|---|---|
| GET | /credits/balance | Current balance |
| POST | /credits/purchase | Initiate IntaSend checkout |
| POST | /credits/payment-webhook | IntaSend webhook [INTERNAL] |
| GET | /credits/transactions | Transaction history |

### 10.8 Trial & Promo
| Method | Endpoint | Description |
|---|---|---|
| POST | /trial/claim | Claim free trial credits |
| GET | /trial/status | Trial state + drip remaining |
| POST | /promo/redeem | Redeem promo code |

### 10.9 Referrals
| Method | Endpoint | Description |
|---|---|---|
| GET | /referral/code | Get own referral code + link |
| GET | /referral/stats | Referral count + credits earned |

### 10.10 Groups
| Method | Endpoint | Description |
|---|---|---|
| GET | /groups | List active groups |
| GET | /groups/:id | Group details + membership status |
| POST | /groups/:id/join | Join (agreement required) |
| POST | /groups/:id/leave | Leave |
| GET | /groups/:id/messages | Paginated messages |
| POST | /groups/:id/messages | Post message |
| POST | /groups/:id/messages/:msgId/report | Report message |

### 10.11 Notifications
| Method | Endpoint | Description |
|---|---|---|
| GET | /notifications | List notifications |
| PATCH | /notifications/:id/read | Mark read |
| PATCH | /notifications/read-all | Mark all read |
| PATCH | /notifications/preferences | Update preferences |
| POST | /notifications/fcm-token | Register FCM device token |

### 10.12 Emergency
| Method | Endpoint | Description |
|---|---|---|
| POST | /emergency/trigger | Create Emergency_Log; alert admin |

### 10.13 Therapist Marketplace
| Method | Endpoint | Description |
|---|---|---|
| GET | /therapist/list | Browse active therapists |
| GET | /therapist/:id/profile | Therapist profile + availability |
| POST | /therapist/book | Create booking |
| GET | /therapist/bookings/my | Member's bookings |
| POST | /therapy/consent | Record pre-session consent |
| GET | /therapy/session/:bookingId | Get session room token |
| POST | /therapy/session/:id/end | End therapist session |
| POST | /therapy/rate | Submit post-session rating |
| POST | /therapy/dispute | Open dispute |
| GET | /therapist/onboarding/status | Therapist onboarding state |
| PATCH | /therapist/onboarding/complete | Complete onboarding (agreement required) |
| GET | /therapist/schedule | Get own availability |
| POST | /therapist/schedule | Set availability slots |
| GET | /therapist/bookings | Therapist's booking list |
| POST | /therapy/session-notes | Save session notes |

### 10.14 Safety Plan
| Method | Endpoint | Description |
|---|---|---|
| GET | /safety-plan | Get plan (null if not created) |
| PUT | /safety-plan | Create or update (upsert) |

### 10.15 Feedback
| Method | Endpoint | Description |
|---|---|---|
| POST | /feedback | Submit anonymous feedback |

### 10.16 Resources
| Method | Endpoint | Description |
|---|---|---|
| GET | /resources | Published articles [PUBLIC optional] |
| GET | /resources/:id | Single article |

### 10.17 Profile
| Method | Endpoint | Description |
|---|---|---|
| GET | /profile | Alias, streak, persona summary |
| POST | /profile/delete-data | Initiate deletion (24hr grace) |
| PATCH | /profile/deactivate | Soft deactivate |

### 10.18 Health
| Method | Endpoint | Description |
|---|---|---|
| GET | /health | `{ status, db, redis, breakers, uptime_seconds }` [PUBLIC] |

### 10.19 Admin
| Method | Endpoint | Description |
|---|---|---|
| GET | /admin/emergency-queue | Live emergency log |
| PATCH | /admin/emergency/:id/acknowledge | Acknowledge |
| PATCH | /admin/emergency/:id/resolve | Resolve |
| GET | /admin/escalations | Peer escalation list |
| GET | /admin/referrals | Therapist referral inbox |
| PATCH | /admin/referrals/:id | Update referral status |
| GET | /admin/reports | Group report queue |
| PATCH | /admin/reports/:id/action | Action report |
| GET | /admin/risk-flags | High/critical risk users |
| POST | /admin/users/:alias/message | In-app message to user |
| GET/POST/PATCH | /admin/resources | Article management |
| GET | /admin/feedback | Aggregate feedback |
| GET | /admin/stats | Anonymized usage stats |
| GET/POST/PATCH | /admin/promo-codes | Promo code management |
| GET | /admin/promo-codes/:id/redemptions | Redemption list |
| GET | /admin/referrals-stats | Referral program stats |
| GET | /admin/therapists | Therapist list + onboarding status |
| PATCH | /admin/therapists/:id | Update therapist status |
| GET | /admin/bookings | All bookings |
| POST | /admin/bookings/:id/resolve-dispute | Resolve dispute |
| GET | /admin/audit-log | Audit trail |
| GET/PATCH | /admin/config | Feature flags |
| GET/PATCH | /admin/permission-flags | Permission flag management |

---

## 11. NOTIFICATION INFRASTRUCTURE

### 11.1 Delivery Stack
- **Push:** FCM — Android + PWA service worker (`firebase-messaging-sw.js`)
- **In-app:** Notifications table; polled on app open + WebSocket during active sessions
- **Background handler:** `sw-notifications.js` — notification rendering + click routing
- **Queue:** BullMQ (Redis); DLQ for failed jobs with exponential backoff (5m/30m/2hr → dead)
- **Circuit breakers:** opossum wrapping FCM + email; breaker state in `/health`

### 11.2 Notification Types

| Type | Trigger | Channels | Recipient |
|---|---|---|---|
| peer_request_broadcast | PeerRequest created | Push + in-app | Active members |
| peer_escalation | 90s timeout, no response | Push + in-app | Admin |
| session_confirmation | Request accepted | In-app | Requester |
| therapist_referral_update | Admin updates referral | Push + in-app | Member |
| emergency_alert | Emergency triggered | Push + in-app | Admin |
| group_message | New group message | Push + in-app | Group members |
| group_warning | Admin issues warning | In-app | User |
| data_deletion_confirmed | Deletion job completes | In-app | User |
| credit_low | Balance < 2 | In-app | User |
| credit_purchase_confirmed | IntaSend webhook confirmed | Push + in-app | User |
| check_in_reminder | No check-in by 8pm | Push | User (if enabled) |
| milestone | Streak: 3/7/30 days | In-app | User |
| reengagement_step1 | Persona not set after N days | Push + in-app | User |
| reengagement_step2 | First session not completed | Push + in-app | User |
| reengagement_step3 | 7-day session lapse | Push + in-app | User |
| reengagement_purchase | Balance = 0 post first session | Push + in-app | User |
| trial_reminder | Day 5 of trial | Push + in-app | User |
| trial_expired | Trial period ended | In-app | User |
| referral_reward | Referee completes first peer session | Push + in-app | Referrer |
| booking_confirmed | Therapist confirms booking | Push + in-app | Member |
| booking_reminder | 1hr before session | Push | Both parties |
| booking_cancelled | Either party cancels | Push + in-app | Other party |

---

## 12. RE-ENGAGEMENT ENGINE

Cron runs every 2 hours. Evaluates each user's `reengagement_step` and sends targeted nudge if:
- Quiet hours respected (21:00–07:00 EAT)
- `last_reengagement_push_at` > cooldown threshold
- Nudge not already sent for this trigger window (`event_ref` dedup)

| Step | Trigger | Nudge |
|---|---|---|
| step1_incomplete | Persona not set | "Set up your companion to get started" |
| step2_no_session | Persona done, no session | "Your first session is waiting" |
| step3_lapsed | 7+ days since last session | "It's been a week — we're here" |
| purchase | Balance = 0 after first session | "Top up to keep the momentum" |

Funnel advances on: persona set → step2; first session done → step3; second session within 7 days OR purchase → converted.

---

## 13. PRODUCTION INFRASTRUCTURE

### 13.1 Containerization
- `src/backend/Dockerfile`: multi-stage node:20-alpine, non-root `peerpal` user, `HEALTHCHECK` via `/health`
- `docker-compose.yml`: backend + redis:7-alpine with health-gated `depends_on`

### 13.2 CI/CD (GitHub Actions)
| Workflow | Trigger | Action |
|---|---|---|
| `ci.yml` | PR to main | Backend tests + frontend lint + Docker build |
| `deploy-staging.yml` | Push to main | Auto-deploy to Render staging; health check |
| `deploy-production.yml` | GitHub Release | Manual gate via `production` environment |
| `keep-alive.yml` | Every 12hrs | Ping `/health`; fail if not 200 |

Required GitHub Secrets: `RENDER_DEPLOY_HOOK_STAGING`, `RENDER_DEPLOY_HOOK_PROD`, `STAGING_BACKEND_URL`, `BACKEND_URL`

### 13.3 Logging
- pino + pino-http structured JSON logging across all routes
- Redacted paths: auth headers, cookies, passwords, tokens, emails, phone numbers

### 13.4 Error Tracking
- Sentry on all three portals (frontend, admin, therapist)
- Scrubbed fields: booking_id, member_alias, therapist_id, room_token, mpesa_number, phone
- Owner action: set `VITE_SENTRY_DSN` in Render/Vercel env vars

### 13.5 Circuit Breakers
- opossum wrapping FCM + email service
- Breaker state exposed in `/health` response

### 13.6 Dead Letter Queue
- `dlq_jobs` table; DLQ retry cron every 15 minutes
- Exponential backoff: 5m → 30m → 2hr → `dead`
- emailWorker + notificationWorker write to DLQ on final BullMQ failure

### 13.7 Connection Pooling
- pg pool: max 10 (Supabase free tier safe)
- Sentry alert when `waitingCount > 3` for >30s
- PgBouncer transaction mode recommended (owner action: enable in Supabase dashboard + set `DATABASE_POOLER_URL`)

### 13.8 Performance Indexes (Migration 108)
- `idx_peer_requests_accepted_by` — stats/leaderboard queries
- `idx_notifications_type` — broadcast dedup queries

---

## 14. DATA RETENTION & DELETION POLICY

### 14.1 User-Initiated Deletion
- `scheduled_deletion_at = NOW() + 24hrs`; cancellable within grace period
- Background job purges: Users, AI_Personas, Moods, Journals, Sessions, CreditTransactions, Credits, SafetyPlan, GroupMemberships, Notifications, TherapistReferrals (contact_detail only)
- GroupMessages: content → "[deleted]", user_id nulled
- **Exception:** AI_Interactions where `flagged = true` are anonymized (user_id → null), not deleted — disclosed in consent agreement

### 14.2 Account Deactivation (Soft)
- `is_active = false`; user cannot log in
- Data retained 30 days; same purge runs automatically after

### 14.3 Admin-Side Data Access
- Alias only — never email or real identity
- Can view anonymized mood trends and flagged interaction categories
- No raw data export

---

## 15. SECURITY

- All API communication HTTPS/TLS 1.3
- Passwords: bcrypt cost factor 12+
- JWT 7-day expiry + refresh token pattern
- IntaSend webhook signature verification on every receipt
- Contact details encrypted at rest (AES-256)
- RLS enabled on all Supabase tables
- Supabase Auth: leaked password protection enabled
- Rate limiting (per-route):
  - Auth endpoints: 5 attempts / 15 min
  - AI message: 30 messages/session, 100/day/user
  - High-abuse endpoints (promo redeem, peer request, trial claim): dedicated limiters
- Admin endpoints: role verified from DB on every request, not JWT payload alone
- FCM tokens stored per-device, rotated on login
- PostHog: `privacyMode: true` — AI prompts and responses never stored

---

## 16. TESTING STRATEGY

### 16.1 Unit Tests
- Risk keyword classifier
- Credit deduction logic (text, voice, grace buffer, zero-balance block)
- Streak logic (same-day, midnight boundary, reset)
- Peer request escalation (90s trigger, lock behaviour)
- Risk score calculation (all thresholds)
- IntaSend webhook signature verification
- Data deletion job
- Trial expiry logic (debit/refund since claim; per-user row lock)
- Webhook race condition (atomic UPDATE claim)
- Engagement score (recency/frequency/breadth/history formula)
- Peer push eligibility + dedup

### 16.2 Safety Tests (Must Pass Before Launch)
- AI cannot diagnose regardless of prompt framing
- AI redirects on all critical keyword variants
- AI cannot be manipulated via persona injection to bypass safety layer
- Journal risk classifier flags all critical keyword categories
- Emergency flow alerts admin within 5 seconds
- Data deletion purges all specified records; anonymizes flagged interactions
- No admin endpoint accessible with member token

### 16.3 Integration Tests
- Full onboarding flow
- Full peer session flow (request → broadcast → accept → lock → deduction → close)
- Full payment flow (IntaSend → webhook → credit update → notification)
- Full group moderation flow
- Full emergency flow
- Full data deletion flow
- Full therapist booking flow (browse → book → consent → session → rating)
- Trial drip + expiry end-to-end
- Referral reward trigger on first peer session

---

## 17. LAUNCH READINESS CHECKLIST

- [x] All core schema tables created and migrated (migrations 001–111)
- [x] All API endpoints implemented
- [x] Groq API configured; fallback model set
- [x] IntaSend live; M-Pesa webhook verified
- [x] FCM configured; `FCM_SERVICE_ACCOUNT_JSON` in backend env
- [x] Firebase web config in Vercel env vars
- [x] Sentry SDK installed across all three portals
- [x] PostHog installed; `privacyMode: true`
- [x] Docker image builds; `/health` endpoint live
- [x] CI/CD workflows active (ci.yml, deploy-staging.yml, deploy-production.yml)
- [x] RLS enabled on all Supabase tables
- [x] Rate limiting on high-abuse endpoints
- [x] Circuit breakers on FCM + email
- [x] DLQ cron active
- [x] Admin account created
- [x] Psychoeducation library seeded (5+ articles per category)
- [x] Groups seeded (8 categories)
- [x] Befrienders Kenya number verified: 0800 723 253
- [x] All safety tests passed
- [x] Data deletion flow tested end-to-end
- [x] Risk score job scheduled
- [x] Peer request escalation job scheduled
- [x] Re-engagement cron active (every 2hrs)
- [x] Consent version locked at '1.0'
- [ ] **Owner:** Run pending migrations (107, 108, 109, 110, 111) on live DB
- [ ] **Owner:** Set `VITE_SENTRY_DSN` in Render/Vercel for all three portals
- [ ] **Owner:** Add GitHub Secrets (`RENDER_DEPLOY_HOOK_STAGING`, `RENDER_DEPLOY_HOOK_PROD`, `STAGING_BACKEND_URL`, `BACKEND_URL`)
- [ ] **Owner:** Create `production` environment in GitHub → Settings → Environments
- [ ] **Owner:** Enable PgBouncer transaction mode in Supabase; set `DATABASE_POOLER_URL` on Render
- [ ] **Owner:** Enable Supabase Auth leaked password protection
- [ ] **Owner:** Restrict Firebase API key to `https://app.peer-pal.com/*` in Google Cloud Console
- [ ] **Owner:** Add Groq third-party AI disclosure to onboarding consent screen (currently missing — legal/GDPR requirement)
- [ ] **Owner:** Encrypt therapist session notes at rest in `therapy_session_notes` table (currently plaintext)
- [ ] **Owner:** Google Play developer account ($25) for APK distribution
- [ ] **Owner:** Clinical sign-off on peer screening scenarios (or ship with `PEER_SCREENING_LIVE=false`)
- [ ] **Owner:** Daraja B2C short code for therapist payouts — **PARTIAL**: payout code exists but short code application pending (Safaricom)
- [ ] **Owner:** ODPC registration (Data Controller + Processor) — **PLANNED**: not started
- [ ] Privacy policy and terms of service published (linked from onboarding)

---

## 18. MODULE SUMMARY

| # | Module | Free/Credits | Status |
|---|---|---|---|
| 1 | Onboarding | Free | ✅ Complete |
| 2 | Mood Check-In | Free | ✅ Complete |
| 3 | Dashboard | Free | ✅ Complete |
| 4 | Peer Support | Credits | ✅ Complete |
| 5 | AI Chat | Free | ✅ Complete |
| 6 | Therapist Marketplace | Credits/Booking | ✅ Complete |
| 7 | Journaling | Free | ✅ Complete |
| 8 | Groups | Free | ✅ Complete |
| 9 | Emergency | Free | ✅ Complete |
| 10 | Profile | Free | ✅ Complete |
| 11 | Psychoeducation Library | Free | ✅ Complete |
| 12 | Breathing & Grounding | Free | ✅ Complete |
| 12a | Calm Space | Free | ✅ Complete |
| 13 | Mood Analytics | Free | ✅ Complete |
| 14 | Safety Plan | Free | ✅ Complete |
| 15 | Daily Streak | Free | ✅ Complete |
| 16 | Anonymous Feedback | Free | ✅ Complete |
| 17 | Admin Dashboard | — | ✅ Complete |
| 18 | Notifications | — | ✅ Complete |
| 19 | Credit System | — | ✅ Complete |
| 20 | Free Trial & Promo Codes | — | ✅ Complete |
| 21 | Referral System | — | ✅ Complete (Seka) |
| 22a | Therapist Payouts (Daraja B2C) | — | ⚠️ Partial — code built, short code pending |
| 22b | ODPC Registration | — | 🔲 Planned — not started |
| 22 | PostHog Analytics | — | ✅ Complete |
| 23 | Sentry Error Tracking | — | ✅ Complete |
| 24 | Re-engagement Engine | — | ✅ Complete |
| 25 | Production Infrastructure | — | ✅ Complete |

**Total: 25 modules. 30 schema tables.**

---

## 19. CHECKPOINT

**Blueprint Version:** 2.0  
**Updated:** 2026-10-20  
**Status:** CURRENT — reflects production codebase  
**Previous version:** `mental_health_app_blueprint_v1.0.md`

**What changed from v1.0 → v2.0:**
- Therapist role: "future" → fully built (portal, marketplace, bookings, ratings, payouts)
- Payment provider: Paystack → IntaSend
- 9 new schema tables: TherapistProfiles, TherapistAvailability, Bookings, TherapistRatings, PromoCodes, PromoCodeRedemptions, ReferralCodes, ReferralRewards, DlqJobs
- 12 new columns on Users (re-engagement funnel, trial, engagement score)
- 10 new notification types
- New modules: Trial/Promo, Referrals, PostHog, Sentry, Re-engagement, Calm Space, Production Infrastructure
- Production infra section: Docker, CI/CD, pino logging, circuit breakers, DLQ, connection pooling

**What changed v2.0 → v2.1 (code-verified corrections):**
- Added 18+ age gate to onboarding (DOB required, backend-enforced)
- Credit packages corrected: 150/300/500 KSh with bundled AI conversations (was 50/100/200/500)
- Credit billing corrected: per-session (1 text, 2 voice) not per-minute
- AI pricing corrected: 1 free/week + bundles (not "always free")
- AI models corrected: gpt-oss-120b primary, qwen3.8-27b fallback via Groq
- Groups corrected: structured prompts/polls/reactions — not open chat
- Added Calm Space module (fully built — triggered on peer unavailability)
- Added 20% therapy platform fee and 25% peer earnings
- Session notes: clarified dual storage (localStorage draft + backend save); flagged plaintext storage gap
- Safety claims downgraded: admin escalation reaches queue, no SLA
- Added Groq third-party disclosure as missing launch blocker
- Therapist payouts status: Complete → Partial (short code pending)
- ODPC: listed as Planned (not started)
- Fixed table count: 9 new tables (was incorrectly stated as 6)
