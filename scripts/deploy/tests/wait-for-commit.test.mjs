import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHealth, waitForCommit } from '../wait-for-commit.mjs';

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

test('evaluateHealth: matching commit is live', () => {
  assert.equal(evaluateHealth(200, { commit: SHA }, SHA), 'live');
});

test('evaluateHealth: 200 from the previous instance is old, not live', () => {
  assert.equal(evaluateHealth(200, { commit: OLD }, SHA), 'old');
  assert.equal(evaluateHealth(200, { status: 'ok' }, SHA), 'old');
});

test('evaluateHealth: non-200 or unparseable body is down', () => {
  assert.equal(evaluateHealth(503, { commit: SHA }, SHA), 'down');
  assert.equal(evaluateHealth(200, null, SHA), 'down');
  assert.equal(evaluateHealth(0, null, SHA), 'down');
});

// Fake clock: sleep advances time, so the loop runs instantly.
function harness(responses) {
  let t = 0;
  const calls = [];
  return {
    calls,
    now: () => t,
    sleepFn: async (ms) => { t += ms; },
    log: () => {},
    fetchFn: async (url) => {
      calls.push(url);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (r instanceof Error) throw r;
      return { status: r.status, json: async () => r.body };
    },
  };
}

test('waitForCommit: waits through cold start and old instance, then succeeds', async () => {
  const h = harness([
    new Error('timeout'),
    { status: 502, body: null },
    { status: 200, body: { commit: OLD } },
    { status: 200, body: { commit: SHA } },
  ]);
  const ok = await waitForCommit({ baseUrl: 'https://x.onrender.com/', sha: SHA, ...h });
  assert.equal(ok, true);
  assert.equal(h.calls.length, 4);
  assert.equal(h.calls[0], 'https://x.onrender.com/health');
});

test('waitForCommit: gives up at the deadline when the new commit never appears', async () => {
  const h = harness([{ status: 200, body: { commit: OLD } }]);
  const ok = await waitForCommit({
    baseUrl: 'https://x.onrender.com', sha: SHA, timeoutMs: 60_000, intervalMs: 15_000, ...h,
  });
  assert.equal(ok, false);
  assert.ok(h.calls.length >= 4 && h.calls.length <= 5, `calls: ${h.calls.length}`);
});
