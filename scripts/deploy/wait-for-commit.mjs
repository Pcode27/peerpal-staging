#!/usr/bin/env node
// Poll <base-url>/health until the backend reports the expected commit.
// A 200 from the previous instance is not a deploy, so we match on the SHA
// that buildInfo() puts in the /health body (src/backend/utils/buildInfo.js).
//
//   node scripts/deploy/wait-for-commit.mjs <base-url> <sha> [timeout-seconds]
//
// Exit 0 when live, 1 on timeout. Free Render instances take ~1 min to wake,
// so each request gets a long timeout of its own.

import { pathToFileURL } from 'node:url';

export function evaluateHealth(status, body, sha) {
  if (status !== 200 || !body) return 'down';
  if (body.commit === sha) return 'live';
  return 'old';
}

export async function waitForCommit({
  baseUrl,
  sha,
  timeoutMs = 600_000,
  intervalMs = 15_000,
  requestTimeoutMs = 90_000,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = console.log,
}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/health`;
  const deadline = now() + timeoutMs;
  let attempt = 0;

  while (true) {
    attempt++;
    let status = 0;
    let body = null;
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (err) {
      log(`attempt ${attempt}: request failed (${err.name})`);
    }

    const state = evaluateHealth(status, body, sha);
    if (status) log(`attempt ${attempt}: HTTP ${status}, commit ${body?.commit ?? 'none'} -> ${state}`);
    if (state === 'live') return true;
    if (now() + intervalMs > deadline) return false;
    await sleepFn(intervalMs);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [baseUrl, sha, timeoutSec = '600'] = process.argv.slice(2);
  if (!baseUrl || !sha) {
    console.error('usage: wait-for-commit.mjs <base-url> <sha> [timeout-seconds]');
    process.exit(2);
  }
  const ok = await waitForCommit({ baseUrl, sha, timeoutMs: Number(timeoutSec) * 1000 });
  if (!ok) console.error(`${baseUrl} did not report commit ${sha} within ${timeoutSec}s`);
  process.exit(ok ? 0 : 1);
}
