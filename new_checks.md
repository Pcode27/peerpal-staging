# MindBridge Pre-Launch Checklist
> For Claude Code agent execution. Each item is independent and testable.

---

## 1. Crisis Escalation & Safety
- [ ] If no peer accepts a request within 5 minutes, auto-surface Befrienders Kenya (0800 723 253) and Niskize (0900 620 800)
- [ ] Add crisis keyword/sentiment detection in AI layer; trigger hotline prompt immediately on detection
- [ ] Show hotline numbers even when app is offline or connectivity is poor
- [ ] Add AI chat as fallback option when no peer is found ("Talk to AI while you wait")
- [ ] Remove admin as primary crisis escalation path; admin receives notification only as secondary

---

## 2. Security & Encryption
- [ ] End-to-end encrypt all peer conversations (SMS and calls)
- [ ] Ensure no sensitive chat content is stored in plaintext on any server or logs
- [ ] Audit all API keys — rotate and store in environment variables, none hardcoded
- [ ] Update AI API key and restrict key permissions to minimum required scope
- [ ] Add rate limiting on all API endpoints to prevent abuse

---

## 3. Data Privacy & Legal Compliance
- [ ] Comply with Kenya Data Protection Act 2019 — document what data is collected, stored, and for how long
- [ ] Add explicit informed consent screen on onboarding: data use, volunteer peer nature (not licensed therapists), platform limitations
- [ ] Define and implement data retention policy — set auto-deletion schedules for conversation logs
- [ ] Add Privacy Policy and Terms of Service pages linked from onboarding and settings

---

## 4. Peer System
- [ ] Define peer room UI clearly — timed session, shows session type (SMS/call), countdown visible
- [ ] Implement peer onboarding gate: community guidelines agreement + basic quiz before volunteering
- [ ] Add flag/report mechanism for users to report peer misconduct
- [ ] Add peer incentive system: peers earn credits per completed session, redeemable for their own sessions
- [ ] Add peer leaderboard/points dashboard tab under peer insights
- [ ] Broadcast peer request to available peers; first to accept gets the session
- [ ] Stress test peer room with simulated concurrent load (target: 30,000 simultaneous users)
- [ ] Ensure app does not crash or degrade under concurrent peer room load
- [ ] When a user buys credits, let them choose SMS or call preference upfront

---

## 5. AI Layer
- [ ] Update AI API key
- [ ] Implement guardrails: block harmful content, self-harm language triggers crisis escalation not generic response
- [ ] AI must never present itself as a licensed therapist
- [ ] Test AI responses against edge cases: suicidal ideation, abuse disclosure, substance use

---

## 6. Groups Page
- [ ] Add WhatsApp-style chat field to each group
- [ ] Load and display historical group messages per group
- [ ] Add group profile, group icon, and member count display
- [ ] Pre-create groups for known conditions: depression, anxiety, grief, substance use, stress
- [ ] Lock posting to admin only — members can read, not post
- [ ] Add push notifications for new group posts
- [ ] Add group join flow based on user-selected condition

---

## 7. Content & UX
- [ ] Add calming sounds and music to the care/music section
- [ ] Add articles and reading materials library (mental health topics, coping strategies)
- [ ] Implement time-conscious login prompts and check-ins (e.g. morning/evening nudges)
- [ ] Add offline fallback UI — show hotline numbers and cached content when offline

---

## 8. Admin Panel
- [ ] Build complete admin dashboard: user reports, flagged sessions, peer activity, crisis escalation logs
- [ ] Admin receives alerts for: flagged peers, unresolved crisis escalations, reported content
- [ ] Admin can post to groups, manage group membership, remove users
- [ ] Admin cannot be the sole crisis fallback — system must handle crisis autonomously first

---

## 9. Onboarding
- [ ] Informed consent screen (see section 3)
- [ ] Peer volunteer onboarding gate (see section 4)
- [ ] Clear explanation of what MindBridge is and is not (not a clinical service)
- [ ] Smooth first-session flow: profile setup → condition selection → join group → explore peer or AI support

---

## 10. Testing & QA
- [ ] End-to-end peer request flow: request → broadcast → accept → session → close → credits deducted
- [ ] Crisis escalation flow: trigger → no peer found → hotline shown → AI fallback offered
- [ ] Load test: 30,000 concurrent peer rooms
- [ ] Test all three credit tiers (100 / 200 / 300 KES) — purchase, deduction, session limits
- [ ] Test on low-end Android devices and slow 3G connections
- [ ] App store submission checklist: screenshots, descriptions, age rating, health app compliance (Google Play & Apple)

---

## 11. App Store & Launch Prep
- [ ] Register as a health app on Google Play — review health content policy compliance
- [ ] Prepare App Store listing: screenshots, description, keywords
- [ ] Set up crash reporting (e.g. Sentry or Firebase Crashlytics)
- [ ] Set up basic analytics: session length, peer request conversion, drop-off points
- [ ] Internal beta test with at least 20 real users before public launch

Active blockers / external dependencies

These can't be unblocked by code — needs action from you or a third party:

┌─────┬──────────────────────────────────────┬───────────────────────────────┬──────────┐
│  #  │                 Item                 │            Status             │   Who    │
├─────┼──────────────────────────────────────┼───────────────────────────────┼──────────┤
│ —   │ IntaSend M-Pesa STK activation       │ Waiting on IntaSend support   │ IntaSend │
├─────┼──────────────────────────────────────┼───────────────────────────────┼──────────┤
│ —   │ IntaSend second webhook registration │ Waiting on STK activation     │ You      │
├─────┼──────────────────────────────────────┼───────────────────────────────┼──────────┤
│ —   │ Resend custom domain (Phase 30.2)    │ Blocked — no domain purchased │ You      │
└─────┴──────────────────────────────────────┴───────────────────────────────┴──────────┘

---
Code phases — priority order

┌──────────┬───────┬──────────────────────────────────────┬──────────┬──────────────────────────────────────────────────────────────────────┐
│ Priority │ Phase │                 Name                 │  Effort  │                                Notes                                 │
├──────────┼───────┼──────────────────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────┤
│ 1        │ 36    │ AI Pipeline Hardening                │ ~3-4h    │ Pipeline files uncommitted, migration not applied, 8 failure         │
│          │       │                                      │          │ scenarios untested                                                   │
├──────────┼───────┼──────────────────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────┤
│ 2        │ 45    │ Re-engagement Engine                 │ ~1 day   │ Schema + backend hooks + cron nudge job + SW rendering               │
├──────────┼───────┼──────────────────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────┤
│ 3        │ 46    │ Referral System                      │ ~half    │ referral_code at signup, reward on first purchase, stats endpoint    │
│          │       │                                      │ day      │                                                                      │
├──────────┼───────┼──────────────────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────┤
│ 4        │ 47    │ Free Trial & Promo Codes             │ ~1.5     │ Largest: trial columns, drip cron, AI 10-cap, Credits screen card,   │
│          │       │                                      │ days     │ admin promo CRUD                                                     │
├──────────┼───────┼──────────────────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────┤
│ 5        │ 38    │ Activities Marketplace               │ ~1.5     │ Counsellor/org activity listings, booking flow                       │
│          │       │                                      │ days     │                                                                      │
├──────────┼───────┼──────────────────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────┤
│ 6        │ 35    │ Life-Domain Peer Routing &           │ ~1 day   │ Post-rollout polish; not launch-blocking                             │
│          │       │ Resolution Tools                     │          │                                                                      │
├──────────┼───────┼──────────────────────────────────────┼──────────┼──────────────────────────────────────────────────────────────────────┤
│ 7        │ 24    │ Help a Friend                        │ blocked  │ Clinical content sign-off required before any code                   │
└──────────┴───────┴──────────────────────────────────────┴──────────┴──────────────────────────────────────────────────────────────────────┘

---
Ongoing infrastructure (low effort, can slot in between phases)

- Phase 12 safety tests — re-run against current codebase before public launch (2–3h)
- FCM end-to-end push test — close app fully on phone, trigger request from laptop, confirm banner arrives (30 min, just testing)
- Two-device peer session test — verify both sides show connected state + countdown simultaneously after the peer_joined fix (30 min)




