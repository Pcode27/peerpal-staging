import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stagingVerdict, fetchStagingRuns, waitForStaging } from '../staging-gate.mjs';

const SHA = 'c'.repeat(40);
const run = (over) => ({
  head_sha: SHA, head_branch: 'main', status: 'completed', conclusion: 'success',
  html_url: 'https://run/1', ...over,
});

test('stagingVerdict: successful staging run on the exact SHA passes', () => {
  assert.deepEqual(stagingVerdict([run()], SHA), { state: 'ok', runUrl: 'https://run/1' });
});

test('stagingVerdict: missing when there are no runs', () => {
  assert.equal(stagingVerdict([], SHA).state, 'missing');
  assert.equal(stagingVerdict(undefined, SHA).state, 'missing');
});

test('stagingVerdict: failed or cancelled runs block', () => {
  assert.equal(stagingVerdict([run({ conclusion: 'failure' })], SHA).state, 'failed');
  assert.equal(stagingVerdict([run({ conclusion: 'cancelled' })], SHA).state, 'failed');
});

test('stagingVerdict: queued or in-progress runs are pending, not ok', () => {
  assert.equal(stagingVerdict([run({ status: 'in_progress', conclusion: null })], SHA).state, 'pending');
  assert.equal(stagingVerdict([run({ status: 'queued', conclusion: null })], SHA).state, 'pending');
});

test('stagingVerdict: a green run on a different SHA does not count', () => {
  assert.equal(stagingVerdict([run({ head_sha: 'd'.repeat(40) })], SHA).state, 'missing');
});

test('stagingVerdict: a branch dispatched to staging by hand is not prod-eligible', () => {
  assert.equal(stagingVerdict([run({ head_branch: 'feat/x' })], SHA).state, 'missing');
});

test('stagingVerdict: passes if any run on the SHA succeeded (re-run after failure)', () => {
  const v = stagingVerdict([run({ conclusion: 'failure' }), run({ html_url: 'https://run/2' })], SHA);
  assert.deepEqual(v, { state: 'ok', runUrl: 'https://run/2' });
});

test('fetchStagingRuns: queries the staging workflow by SHA with auth, all statuses', async () => {
  let seen;
  const fetchFn = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ workflow_runs: [run()] }) };
  };
  const runs = await fetchStagingRuns({ repo: 'iamparody/peerpal-app', sha: SHA, token: 't', fetchFn });
  assert.equal(runs.length, 1);
  assert.match(seen.url, /\/repos\/iamparody\/peerpal-app\/actions\/workflows\/deploy-staging\.yml\/runs\?head_sha=c{40}/);
  assert.doesNotMatch(seen.url, /status=/); // must see in-progress runs to wait on them
  assert.equal(seen.opts.headers.Authorization, 'Bearer t');
});

test('fetchStagingRuns: API errors throw instead of silently passing', async () => {
  const fetchFn = async () => ({ ok: false, status: 403 });
  await assert.rejects(fetchStagingRuns({ repo: 'a/b', sha: SHA, token: 't', fetchFn }), /403/);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleepFn: async (ms) => { t += ms; } };
}

test('waitForStaging: waits through an in-progress run until it goes green', async () => {
  const seq = [
    [run({ status: 'in_progress', conclusion: null })],
    [run({ status: 'in_progress', conclusion: null })],
    [run()],
  ];
  const fetchFn = async () => ({ ok: true, json: async () => ({ workflow_runs: seq.shift() }) });
  const v = await waitForStaging({ repo: 'a/b', sha: SHA, token: 't', fetchFn, intervalMs: 10, ...fakeClock(), log: () => {} });
  assert.equal(v.state, 'ok');
  assert.equal(seq.length, 0);
});

test('waitForStaging: returns failed when the awaited run fails', async () => {
  const seq = [[run({ status: 'in_progress', conclusion: null })], [run({ conclusion: 'failure' })]];
  const fetchFn = async () => ({ ok: true, json: async () => ({ workflow_runs: seq.shift() }) });
  const v = await waitForStaging({ repo: 'a/b', sha: SHA, token: 't', fetchFn, intervalMs: 10, ...fakeClock(), log: () => {} });
  assert.equal(v.state, 'failed');
});

test('waitForStaging: does not wait when nothing ran for the SHA', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return { ok: true, json: async () => ({ workflow_runs: [] }) }; };
  const v = await waitForStaging({ repo: 'a/b', sha: SHA, token: 't', fetchFn, ...fakeClock(), log: () => {} });
  assert.equal(v.state, 'missing');
  assert.equal(calls, 1);
});

test('waitForStaging: gives up at the deadline', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ workflow_runs: [run({ status: 'queued', conclusion: null })] }) });
  const v = await waitForStaging({ repo: 'a/b', sha: SHA, token: 't', fetchFn, timeoutMs: 100, intervalMs: 30, ...fakeClock(), log: () => {} });
  assert.equal(v.state, 'pending');
  assert.match(v.reason, /still running/);
});
