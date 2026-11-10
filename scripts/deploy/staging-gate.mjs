#!/usr/bin/env node
// Production gate: a commit may only go to prod if the "Deploy to Staging"
// workflow succeeded on that exact SHA from main. A branch dispatched to
// staging by hand for testing doesn't qualify.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
//     node scripts/deploy/staging-gate.mjs <sha> [wait-seconds]
//
// If staging is still running for the SHA (you merged to production right
// after pushing main), it waits up to wait-seconds (default 1500) for it.
// Exit 0 when staged, 1 when not.

import { pathToFileURL } from 'node:url';

export const STAGING_WORKFLOW = 'deploy-staging.yml';

// Returns { state: 'ok' | 'pending' | 'failed' | 'missing', runUrl?, reason? }
export function stagingVerdict(runs, sha) {
  const onMain = (runs || []).filter((r) => r.head_sha === sha && r.head_branch === 'main');
  const ok = onMain.find((r) => r.status === 'completed' && r.conclusion === 'success');
  if (ok) return { state: 'ok', runUrl: ok.html_url };
  const running = onMain.find((r) => r.status !== 'completed');
  if (running) return { state: 'pending', runUrl: running.html_url };
  if (onMain.length) {
    return {
      state: 'failed',
      runUrl: onMain[0].html_url,
      reason: `staging ${onMain[0].conclusion} for ${sha}`,
    };
  }
  return { state: 'missing', reason: `no ${STAGING_WORKFLOW} run on main for ${sha}` };
}

export async function fetchStagingRuns({ repo, sha, token, fetchFn = fetch }) {
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${STAGING_WORKFLOW}/runs` +
    `?head_sha=${sha}&per_page=30`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
  const body = await res.json();
  return body.workflow_runs || [];
}

// Polls while staging is pending; returns the final verdict.
export async function waitForStaging({
  repo, sha, token,
  timeoutMs = 1500_000, intervalMs = 30_000,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = console.log,
}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const verdict = stagingVerdict(await fetchStagingRuns({ repo, sha, token, fetchFn }), sha);
    if (verdict.state !== 'pending') return verdict;
    if (now() >= deadline) {
      return { state: 'pending', runUrl: verdict.runUrl, reason: `staging still running for ${sha} after ${timeoutMs / 1000}s` };
    }
    log(`Staging still running for ${sha.slice(0, 7)} (${verdict.runUrl}); waiting...`);
    await sleepFn(intervalMs);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const sha = process.argv[2];
  const waitSeconds = Number(process.argv[3] || 1500);
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
  if (!sha || !token || !repo) {
    console.error('usage: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo staging-gate.mjs <sha> [wait-seconds]');
    process.exit(2);
  }
  const verdict = await waitForStaging({ repo, sha, token, timeoutMs: waitSeconds * 1000 });
  if (verdict.state === 'ok') {
    console.log(`Staged: ${verdict.runUrl}`);
    process.exit(0);
  }
  console.error(
    `Blocked: ${verdict.reason}.${verdict.runUrl ? ` ${verdict.runUrl}` : ''}\n` +
      'Production only takes commits that went green on staging. Push to main, wait for ' +
      '"Deploy to Staging" to pass, then fast-forward production (git merge --ff-only main).'
  );
  process.exit(1);
}
