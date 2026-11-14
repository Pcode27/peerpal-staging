# CLAUDE.md — Agent Instructions

You are building a mobile-first mental health support platform.

## Session Start (new session or compacted context)
Read `PROGRESS.md` first — it has the active phase, NEXT ACTION, and infrastructure state. Do not ask what to work on; find NEXT ACTION and resume. Update PROGRESS.md's NEXT ACTION at end of every session.

Reference files (read only when needed):
- `CHECKLIST.md` — ordered build tasks
- `graphify-out/GRAPH_REPORT.md` — full project graph (files, routes, schema)
- `blueprint/blueprint_v1.0.md` — full specification

## Workflow
- Dev servers before writing any code:
  - `cd src/backend && npm run dev` (port 3001)
  - `cd src/frontend && npm run dev` (port 5173)
  - `cd src/admin && npm run dev` (port 5175)
  - `cd src/therapist && npm run dev` (port 5176)
- Build locally, verify in browser, commit only when satisfied
- Never commit to see how something looks — only commit when it works correctly in the browser
- After every UI or route change, verify at localhost:5173 / 5175 / 5176 before moving to the next checklist item
- Run `npm run migrate` only when a migration is finalised and intentional — it applies to the live Supabase DB immediately
- Every migration file must have a corresponding `_rollback.sql` file alongside it

## Rules
- Follow the blueprint exactly. Do not invent, assume, or stub anything.
- Complete one checklist item fully before moving to the next.
- After completing any item: update CHECKLIST.md and PROGRESS.md immediately.
- If you encounter a conflict or ambiguity in the blueprint, stop and flag it — do not guess.
- Never skip the safety-related items in any module.
- Build order is defined in blueprint Section 16 — do not deviate from it.