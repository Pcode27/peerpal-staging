# PeerPal Operations Runbook

## Infrastructure overview
- **Backend**: Node.js on Render, deployed from the `production` branch. `main` goes to staging first; fast-forwarding `production` ships to prod once the commit passed staging. See `docs/staging.md`.
- **Database**: Supabase PostgreSQL (pooler URL for app, direct URL for migrations)
- **Cache**: Upstash Redis (REST API — stateless, no persistent sessions)
- **Auth**: JWT (stateless — no server-side session state)
- **Payments**: IntaSend (webhook-driven)
- **Media**: Twilio NTS (TURN credentials, per-session)

---

## Deploy strategy (39.4)

Render performs a **rolling deploy** — new instance starts, passes health check, then traffic is cut over. There is no true blue/green on the free/starter tier; rollback is a manual re-deploy of the previous commit.

### Zero-downtime migration checklist (expand/contract pattern)
Every migration that changes a column used by running code must be backwards-compatible:

1. **Add** — add a column with a default value. Deploy code that reads/writes both old and new. ✅ safe.
2. **Backfill** — run a migration to populate the new column on existing rows.
3. **Switch** — deploy code that uses only the new column.
4. **Drop old** — in a later deploy, drop the old column.

**Never** in a single deploy: rename a column, change a type, drop a column that live code still reads.

### Rollback path
1. `git checkout production && git reset --hard <last-good-sha> && git push --force-with-lease origin production`. Deploy to Production redeploys it (that commit passed staging when it first shipped).
2. Fix forward on `main` afterwards. The next `git merge --ff-only main` on `production` moves it past the rolled-back commit.
3. If a migration was already applied: write a `_rollback.sql` (every migration has one) and run it via `node migrations/run.js <id>_rollback` against the direct DB URL.

---

## Supabase point-in-time recovery (39.5)

Supabase Pro plans include PITR. Verify it is enabled:
- Dashboard → Project Settings → Add-ons → Point in Time Recovery
- Retention: minimum 7 days recommended.

### Recovery procedure
1. Supabase Dashboard → Backups → select restore point.
2. Restore to a new project (never restore in-place if the bad migration is still running).
3. Update `DATABASE_URL` / `DATABASE_POOLER_URL` in Render env vars to point at restored project.
4. Re-run any migrations that were applied after the restore point.

---

## Redis (Upstash) wipe recovery

Redis holds short-lived cache only (balance cache, rate limit counters). A wipe is **non-fatal**:
- Users who are mid-session will not be logged out (JWT auth is stateless).
- Balance cache repopulates on the next request.
- Rate limit counters reset — a brief window of unthrottled requests. Monitor login endpoint for abuse after a wipe.

No action needed beyond noting the wipe time in the incident log.

---

## Login failure runbook (39.5)

If users cannot log in, check in this order:

| Step | Check | Tool |
|------|-------|------|
| 1 | Health endpoint responding | `GET /health` — should return `status: ok` |
| 2 | DB reachable and latency | `GET /health/db` — `latency_ms` should be <200ms; `pool.waiting` should be 0 |
| 3 | Pool saturation | `pool.waiting > 0` on `/health/db` means all 20 connections are held. Check for long-running queries in Supabase dashboard. |
| 4 | bcrypt overhead | Check Render logs for `[login-perf]` lines. `bcrypt_ms` ~250ms is normal. >800ms suggests CPU saturation. |
| 5 | DB slow queries | Check Render logs for `[slow-query]` lines (>500ms). Look for missing indexes or lock contention. |
| 6 | Rate limiter blocking | 429 responses mean `loginCooldownMiddleware` is tripping. Check for a brute-force attempt or a misconfigured client hammering login. |
| 7 | Supabase status | Check status.supabase.com for any active incidents. |

### Key log patterns
```
[login-perf] { db_ms: 45, bcrypt_ms: 260, total_ms: 310 }   ← normal
[login-perf] { db_ms: 1200, bcrypt_ms: 255, total_ms: 1460 } ← DB slow, check pool/indexes
[slow-query] { duration: 820, query: "SELECT id, alias..." }   ← specific query to investigate
[pg-pool] Unexpected client error <message>                    ← idle client dropped, non-fatal
```

---

## Horizontal scaling notes (39.3)

State is fully external:
- **Sessions**: JWT (no server-side state). Multiple instances work without sticky sessions.
- **Cache**: Upstash Redis (shared across instances via REST API).
- **WebSocket signaling**: `ws/signaling.js` is in-process. If you scale to >1 instance, WS connections to different instances won't share rooms. Solution: move signaling to a Redis pub/sub adapter (e.g. `socket.io-redis`) before scaling horizontals.

### Scaling on Render
- Render → Service → Scaling → increase instance count (paid plans).
- Health check URL: `/health` — Render polls this to determine instance readiness.
- `X-Request-Id` header is set on every response for cross-instance log tracing.
