# Staging and production releases

Every push to `main` deploys to **staging**. Nothing reaches **production** until someone fast-forwards the `production` branch, and the production workflow refuses any commit that didn't pass staging first.

```
PR ──CI──> merge to main ──> Deploy to Staging ──────────────────────────> staging (Seka's free accounts)
                               1. gate tests + replay every migration on an empty Postgres
                               2. migrations on staging Supabase
                               3. push commit to staging mirror ──> Render auto-deploys
                               4. wait until /health reports this commit
                               5. Vercel CLI deploys member, admin, therapist portals

push `production` (ff from main) ──> Deploy to Production ──────────────> production (existing accounts)
                               1. staging gate: this SHA passed staging on main (waits if still running)
                               2. no pending prod migrations (if PROD_DATABASE_URL set)
                               3. Render deploy hook, wait until prod /health reports this commit
                               4. frontends: Vercel CLI deploys this exact commit (or deploy hooks
                                  if PROD_VERCEL_* isn't configured)
```

Workflows: `.github/workflows/deploy-staging.yml`, `deploy-production.yml`, `keep-alive.yml`.
Scripts: `scripts/deploy/wait-for-commit.mjs`, `scripts/deploy/staging-gate.mjs`, `src/backend/migrations/run.js`.

## Why it's built this way

- **Two sets of free accounts.** Free tiers are counted per account: Render gives 750 instance hours per workspace per month (prod alone can use ~730, and running out suspends every free service in the workspace), and Supabase gives 2 free projects per owner. Staging on Seka's accounts doubles the free capacity and can never knock prod over.
- **One code repo.** `iamparody/peerpal-app` stays the only place code is written. Moving it to a GitHub org would break Vercel Hobby (it can't deploy private org repos).
- **Staging mirror repo.** Seka's Render can't read a private repo on someone else's personal account. GitHub Actions force-pushes each staged commit to a private mirror on Seka's account, and the staging Render service builds from that. Nobody commits to the mirror.
- **Vercel CLI for staging frontends.** Vercel Hobby only builds commits whose git author owns the account, so Git-connected staging projects would reject Antony's commits. Actions builds with the CLI and deploys without git metadata.
- **`/health` reports the commit.** `src/backend/utils/buildInfo.js` returns Render's `RENDER_GIT_COMMIT`. The workflows wait for the exact SHA, so a 200 from the old instance doesn't count as a deploy.
- **Migration target guard.** `run.js` refuses to run when `MIGRATE_EXPECT_REF` is set and the connection string doesn't contain that Supabase project ref. The staging workflow always sets it, so a mis-pasted secret can't migrate prod.

## One-time setup: Seka (staging accounts)

Do these in order. Write down every value marked **→** and send them to the repo owner over a private channel (not WhatsApp group, not email in plain text).

### 1. GitHub mirror repo
1. On your GitHub account, create an **empty private** repo named `peerpal-staging` (no README).
2. That repo → Settings → Actions → General → **Disable actions**. (The workflow files also skip themselves outside `iamparody/peerpal-app`; this is belt and braces.)
3. Your GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
   - Repository access: only `peerpal-staging`
   - Permissions: **Contents: Read and write**, **Workflows: Read and write** (the pushed commits contain workflow files)
   - Expiry: 1 year, calendar a reminder to rotate.
   - **→ `STAGING_MIRROR_TOKEN`** = the token. **→ `STAGING_MIRROR_REPO`** = `<your-username>/peerpal-staging`
4. Seed the mirror once so Render has something to connect to. From `C:\dev\peerpal\peerpal-app`:
   ```
   git fetch origin
   git push https://github.com/<your-username>/peerpal-staging.git origin/main:refs/heads/main
   ```

### 2. Supabase (staging database)
1. New project, name `peerpal-staging`, region **North EU (Stockholm)**, same as prod (`eu-north-1`). Save the database password.
2. **→ `STAGING_SUPABASE_REF`** = the project ref (the random id in the dashboard URL, also in Settings → General).
3. Settings → Database → Connection string → **Session pooler** (port 5432). Use this, not "Direct connection": the direct host is IPv6-only on free projects and GitHub runners can't reach it. **→ `STAGING_DATABASE_URL`**. It contains `postgres.<ref>`, which the migration guard checks.
4. Storage → New bucket `therapists-docs`, **Public off**. New bucket `therapist-photos`, **Public on**. (Names must match `src/backend/services/storage.js`. The comments in `docs/supabase_storage_setup.sql` say `therapist-docs`; the code uses `therapists-docs`.)
5. SQL Editor → run `docs/supabase_storage_setup.sql`.
6. Project Settings → Data API: note the Project URL. Project Settings → API Keys → Legacy API keys: note the `service_role` key (same key type prod uses). Both go to Render below.

Tables are created by the first staging run: the workflow applies every migration from `001_users.sql` up.

### 3. Upstash (staging Redis)
Create a Redis database, region `eu-central-1` (Frankfurt, next to Render). Note the REST URL, REST token, and the `rediss://` TCP URL for Render below.

### 4. Render (staging backend)
New → Web Service → connect GitHub → `peerpal-staging`.

| Setting | Value |
|---|---|
| Branch | `main` |
| Region | Frankfurt (closest to prod Supabase in eu-north-1) |
| Root Directory | **blank**. If set to `src/backend`, Render skips commits that don't touch it and the staging job times out waiting for the new commit |
| Language | Docker |
| Dockerfile path | `src/backend/Dockerfile` |
| Docker build context | `src/backend` |
| Instance type | Free |
| Health check path | `/health` |
| Auto-Deploy | On Commit |

**→ `STAGING_BACKEND_URL`** = the service URL, e.g. `https://peerpal-staging-api.onrender.com` (no trailing slash).

Environment variables (Render → Environment). Never paste prod secrets here.

| Variable | Staging value |
|---|---|
| `NODE_ENV` | `production` |
| `DEPLOY_ENV` | `staging` (shows in `/health`) |
| `DATABASE_URL` | Supabase Session pooler URL (port 5432), same as `STAGING_DATABASE_URL` |
| `DATABASE_POOLER_URL` | Supabase **Transaction pooler** URL (port 6543). `src/backend/db/index.js` prefers it for app queries |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | from step 2.6 |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_REDIS_URL` | from step 3 |
| `JWT_SECRET`, `ENCRYPTION_KEY` | new random values, **not** prod's. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `FRONTEND_URL` | the three staging Vercel URLs, comma-separated (CORS allowlist) |
| `APP_URL` | staging member app URL |
| `THERAPIST_PORTAL_URL` | staging therapist URL |
| `GROQ_API_KEY`, `GROQ_PRIMARY_MODEL`, `GROQ_FALLBACK_MODEL`, `GROQ_DETECTION_MODEL` | a separate Groq key if possible, same model names as prod |
| `RESEND_API_KEY`, `EMAIL_FROM` | your own Resend key. Without a verified domain it only delivers to your own address, which is what staging wants |
| `PAYMENT_PROVIDER`, `DARAJA_ENV`, `INTASEND_SECRET_KEY`, `INTASEND_WEBHOOK_CHALLENGE`, `PAYSTACK_SECRET_KEY` | **sandbox/test credentials only**. `DARAJA_ENV=sandbox` |
| `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`, `TWILIO_*` | dev values are fine |
| `FCM_SERVICE_ACCOUNT_JSON` | a separate Firebase project if you want push on staging; leave unset to skip |
| `SENTRY_DSN` | same DSN as prod is fine; `DEPLOY_ENV` separates the events |
| `POSTHOG_PROJECT_TOKEN`, `POSTHOG_HOST` | leave unset so staging doesn't pollute prod analytics |
| `PEER_SCREENING_LIVE` | match prod |

The first deploy goes Live as soon as the database login works: `/health` only runs `SELECT 1`, which needs no tables. The background jobs log `relation ... does not exist` until the first workflow run applies the migrations. That's expected. Until the pipeline branch reaches the mirror, `/health` also won't include `commit` or `environment`.

If the log shows `password authentication failed` and then `ECIRCUITBREAKER`, the password in the URL is wrong or not URL-encoded (`%` must be `%25`). Suspend the service so it stops retrying, reset the DB password to letters and digits only, wait about 15 minutes for Supabase to lift the block, update both DB vars, then resume and redeploy.

### 5. Vercel (staging frontends)
Create three empty projects on your Hobby account (no Git connection, no local files):
```
npx vercel@63.1.2 login
npx vercel@63.1.2 project add peerpal-staging-app
npx vercel@63.1.2 project add peerpal-staging-admin
npx vercel@63.1.2 project add peerpal-staging-therapist
```
Each project → Settings:
- Build and Deployment → Framework Preset: **Vite**. Root Directory: **blank**. Git: **not connected**.
- Environment Variables, scope **Production**:
  - all three: `VITE_API_URL` = `STAGING_BACKEND_URL`, `VITE_SENTRY_DSN` (optional)
  - member app also: `VITE_WS_URL` (= backend URL with `wss://`), `VITE_APP_URL` (= member app URL), `VITE_FIREBASE_*` (only if you set up staging FCM), leave `VITE_POSTHOG_*` unset

Values to send:
- **→ `STAGING_VERCEL_ORG_ID`**: Vercel → your team → Settings → General → Team ID (`team_...`).
- **→ `STAGING_VERCEL_PROJECT_FRONTEND`**, **`STAGING_VERCEL_PROJECT_ADMIN`**, **`STAGING_VERCEL_PROJECT_THERAPIST`**: each project → Settings → General → Project ID (`prj_...`).
- **→ `STAGING_FRONTEND_URL`**, **`STAGING_ADMIN_URL`**, **`STAGING_THERAPIST_URL`**: each project's `*.vercel.app` production domain.
- **→ `STAGING_VERCEL_TOKEN`**: Vercel → Account Settings → Tokens → create, scope your Hobby team, 1 year.

Then set `FRONTEND_URL`, `APP_URL`, `THERAPIST_PORTAL_URL` on Render (step 4) to those URLs.

## One-time setup: repo owner (iamparody)

Only the repo owner can manage secrets on a personal-account repo.

### 1. Secrets and variables
`iamparody/peerpal-app` → Settings → Secrets and variables → Actions.

**Secrets** (hidden):

| Name | From |
|---|---|
| `STAGING_DATABASE_URL` | Seka |
| `STAGING_MIRROR_TOKEN` | Seka |
| `STAGING_VERCEL_TOKEN` | Seka |
| `VERCEL_HOOK_FRONTEND`, `VERCEL_HOOK_ADMIN`, `VERCEL_HOOK_THERAPIST` | already exist. Each prod Vercel project → Settings → Git → Deploy Hooks. **Each hook must be for branch `production`**, or prod builds `main` |
| `RENDER_DEPLOY_HOOK_PROD` | already exists (prod Render → Settings → Deploy Hook) |
| `PROD_VERCEL_TOKEN` | recommended: your Vercel → Account Settings → Tokens, scope the team that owns the 3 prod projects, 1 year. With it, prod frontends deploy the exact gated commit via the CLI instead of the deploy hooks |
| `BACKEND_URL` | already exists (prod backend URL, used by keep-alive and the prod health wait) |
| `PROD_DATABASE_URL` | optional: prod Supabase Session pooler URL. Enables the pending-migrations gate |

**Variables** (visible, not secret):

| Name | From |
|---|---|
| `STAGING_SUPABASE_REF` | Seka |
| `STAGING_BACKEND_URL` | Seka |
| `STAGING_MIRROR_REPO` | Seka |
| `STAGING_VERCEL_ORG_ID` | Seka |
| `STAGING_VERCEL_PROJECT_FRONTEND` | Seka |
| `STAGING_VERCEL_PROJECT_ADMIN` | Seka |
| `STAGING_VERCEL_PROJECT_THERAPIST` | Seka |
| `STAGING_FRONTEND_URL` | Seka |
| `STAGING_ADMIN_URL` | Seka |
| `STAGING_THERAPIST_URL` | Seka |
| `PROD_SUPABASE_REF` | optional, set together with `PROD_DATABASE_URL` (guards the check against the wrong DB) |
| `PROD_VERCEL_ORG_ID` | with `PROD_VERCEL_TOKEN`: prod Vercel team → Settings → General → Team ID (`team_...`) |
| `PROD_VERCEL_PROJECT_FRONTEND`, `PROD_VERCEL_PROJECT_ADMIN`, `PROD_VERCEL_PROJECT_THERAPIST` | with `PROD_VERCEL_TOKEN`: each prod project → Settings → General → Project ID (`prj_...`) |

`RENDER_DEPLOY_HOOK_STAGING` and the `STAGING_BACKEND_URL` **secret** are no longer used (staging reads the variable). Delete them if they exist.

### 2. Point production at the `production` branch
The `production` branch exists. Make sure every prod deploy source follows it:
1. Render (prod backend) → Settings → Build & Deploy → **Branch: `production`**, Auto-Deploy: **Off**. The workflow fires the deploy hook after the staging gate passes. With Auto-Deploy on, Render deploys on the push itself, before the gate, and the gate protects nothing.
2. Vercel prod frontends, pick one:
   - **CLI (recommended):** add `PROD_VERCEL_TOKEN`, `PROD_VERCEL_ORG_ID` and the 3 `PROD_VERCEL_PROJECT_*` above. Run one production deploy and check the 3 frontend jobs say "Deploying ... with the Vercel CLI". Then, on each prod project, Settings → Git → **Disconnect**. Git-connected projects build on every push by themselves, which bypasses the gate (and if the production branch is `main`, ships `main` straight to prod).
   - **Deploy hooks (current):** every hook (Settings → Git → Deploy Hooks) must be for branch `production`. The hook builds the branch head, so it can't pin the exact commit, and the Git connection keeps building pushes by itself.
3. Push something small to `main` and confirm prod does **not** redeploy, while staging does.

## Day to day

**Ship a change:** push (or merge a PR) to `main`. Staging updates in ~10 minutes: tests, staging migrations, backend, then the three frontends. Actions → Deploy to Staging shows the commit and URLs in the run summary. Test on the staging URLs.

**Promote to prod:**
1. If the change includes new migrations, apply them to prod first: `cd src/backend && npm run migrate` with prod `DATABASE_URL` in `.env`. Migrations must be backward-compatible (expand/contract, see `RUNBOOK.md`), because the old code runs against the new schema until the deploy finishes. `npm run migrate:check` lists what's pending without applying.
2. Fast-forward `production` to the staged commit:
   ```
   git checkout production
   git pull
   git merge --ff-only main
   git push origin production
   git checkout main
   ```
   Use `--ff-only`. A merge commit is a new SHA that never ran on staging, so the gate blocks it. If `--ff-only` refuses, someone committed straight to `production`: bring that commit into `main` first.
3. Watch Actions → Deploy to Production. It fails before firing any deploy hook if the commit didn't pass staging or prod migrations are pending. If staging is still running for the commit, it waits (up to 25 minutes).

**Smoke test before every release.** On the staging URLs, by hand:
1. Register a new member account and verify the email (Resend delivers to the Resend account owner's address).
2. Log a mood and send one AI companion message; confirm a reply arrives.
3. Book a therapy session from the member app; confirm it shows in the therapist portal.
4. Admin portal: log in and open the therapist verification list.
5. If staging FCM is set up: trigger a push (peer request) and confirm it arrives.

**Roll back:** move `production` back to the last good commit and push:
```
git checkout production
git reset --hard <last-good-sha>
git push --force-with-lease origin production
git checkout main
```
That commit passed staging when it first shipped, so the gate lets it through. Then fix forward on `main`.

**Emergency hotfix that can't wait for staging:** commit to `production` and push (the gate blocks it), then Actions → Deploy to Production → Run workflow on `production` with **skip_staging_gate** ticked. Bring the fix into `main` right after.

**Test a branch on staging without merging:** Actions → Deploy to Staging → Run workflow → pick the branch. It deploys, but the production gate won't accept it (only staging runs from `main` count).

## Free-tier limits to know

| Limit | Effect on staging | Handled by |
|---|---|---|
| Render free spins down after 15 min idle, ~1 min to wake | first request after a break is slow | `wait-for-commit.mjs` uses 90 s request timeouts |
| Render 750 h/month per workspace | staging is idle most of the time, far under | separate workspace from prod |
| Supabase pauses after 7 days idle | staging DB goes offline | `keep-alive.yml` pings staging `/health` (runs `SELECT 1`) every 12 h |
| Supabase 500 MB database | fine for test data | |
| Upstash free daily command cap | BullMQ polls Redis constantly; if staging hits the cap, queues stall | watch the Upstash dashboard the first week |
| Vercel Hobby is non-commercial | staging isn't public, fine | prod is the concern, see below |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Staging is not configured. Missing: ...` | secrets/variables not set | repo owner adds the names listed |
| `Refusing to migrate: connection string does not contain expected project ref` | `STAGING_DATABASE_URL` points at a different project than `STAGING_SUPABASE_REF` | fix whichever is wrong. This guard is what stops a prod URL from being migrated by staging |
| `Migration replay (fresh DB)` fails | a migration only works on prod's existing data (e.g. assumes an admin user exists) | make it skip cleanly on an empty DB, like `092_seed_missing_groups.sql`. Staging migrations don't run until replay passes |
| `did not report commit <sha> within 900s` | Render build failed or is slow | Render dashboard → Events/Logs. Re-run the job once fixed |
| Push to mirror rejected (403) | mirror token expired or lacks Workflows permission | regenerate per Seka step 1.3 |
| Vercel `Git author ... must have access` | `.git` wasn't removed before deploy | check the Deploy step still runs `rm -rf .git` |
| Production fails at `Staging gate` | the commit never went green on staging from `main`, or `production` got a merge commit | push to `main`, wait for staging, then `git merge --ff-only main` |
| Production waits at `Staging gate` | staging is still running for that commit | nothing; it continues when staging passes, fails if staging fails |
| Production times out at `Wait for production backend` | prod Render deployed another branch (hook or Branch setting not `production`), or the build failed | Render prod → Events. Fix the branch setting and re-run |
| Prod frontends show old code | on hooks: a hook is for `main`, not `production` | switch to the CLI path (owner step 2) or recreate the hook for `production` |
| Frontend job warns `PROD_VERCEL_* not configured` | CLI values missing, fell back to hooks | add them (owner step 1) |
| Vercel CLI `Project not found` in a prod frontend job | `PROD_VERCEL_ORG_ID` / project ID wrong, or token scoped to another team | recheck the IDs and token scope |

## Known gaps

- **Prod on free tiers.** Prod Render free spins down after 15 minutes; a user opening crisis support could wait ~1 minute. Vercel Hobby forbids commercial use and prod takes payments. Both are prod decisions, separate from staging.
- **No required-reviewer approval for prod.** GitHub only offers that on paid plans for private repos. The gate is "pushing `production`", which needs write access.
- **Prod frontends bypass the gate until the CLI path is on.** While the prod Vercel projects are Git-connected they build pushes by themselves, gate or not. Fixed by owner step 2 (CLI + disconnect Git). The backend is gated as long as prod Render Auto-Deploy is Off.
- **Frontend lint is red on `main`** (86 errors in `npm run lint`). The PR CI job fails because of it. Staging runs the frontend tests but not lint, so staging isn't blocked.
- **Fresh DB has no groups.** `092` seeds the condition groups only when an admin user exists. On staging, create the admin account, then re-insert the groups (copy the `INSERT` from `092_seed_missing_groups.sql`).
