const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { planMigrations, assertExpectedTarget } = require('../migrations/run');
const { buildInfo } = require('../utils/buildInfo');

test('planMigrations: forward files only, sorted, applied ones skipped', () => {
  const files = ['002_b.sql', '001_a.sql', '001_a_rollback.sql', 'run.js', '003_c.sql'];
  assert.deepEqual(planMigrations(files, new Set(['001_a.sql'])), ['002_b.sql', '003_c.sql']);
});

test('planMigrations: fresh database gets every forward migration in the repo', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'migrations'));
  const plan = planMigrations(files, new Set());
  assert.ok(plan.length > 100, `expected the full history, got ${plan.length}`);
  assert.equal(plan[0], '001_users.sql');
  assert.ok(plan.every((f) => f.endsWith('.sql') && !f.includes('_rollback')));
  assert.deepEqual(plan, [...plan].sort());
});

test('planMigrations: every forward migration has a rollback alongside it', () => {
  const files = fs.readdirSync(path.join(__dirname, '..', 'migrations'));
  const set = new Set(files);
  // Migrations before 076 predate the rollback rule; enforce it from there on.
  const missing = planMigrations(files, new Set())
    .filter((f) => Number(f.slice(0, 3)) >= 76)
    .filter((f) => !set.has(f.replace(/\.sql$/, '_rollback.sql')));
  assert.deepEqual(missing, []);
});

test('assertExpectedTarget: no expected ref means no check (local dev)', () => {
  assert.doesNotThrow(() => assertExpectedTarget('postgres://localhost/x', undefined));
  assert.doesNotThrow(() => assertExpectedTarget(undefined, ''));
});

test('assertExpectedTarget: matches direct host and pooler username forms', () => {
  const ref = 'abcdefghijklmnop';
  assert.doesNotThrow(() =>
    assertExpectedTarget(`postgresql://postgres:pw@db.${ref}.supabase.co:5432/postgres`, ref));
  assert.doesNotThrow(() =>
    assertExpectedTarget(`postgresql://postgres.${ref}:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`, ref));
});

test('assertExpectedTarget: refuses a different project (staging job pointed at prod)', () => {
  assert.throws(
    () => assertExpectedTarget('postgresql://postgres:pw@db.prodprodprodprod.supabase.co:5432/postgres', 'stagingstaging12'),
    /Refusing to migrate/
  );
  assert.throws(() => assertExpectedTarget(undefined, 'stagingstaging12'), /Refusing to migrate/);
});

test('buildInfo: reports Render commit and deploy env, null when absent', () => {
  assert.deepEqual(buildInfo({ RENDER_GIT_COMMIT: 'abc', DEPLOY_ENV: 'staging' }),
    { commit: 'abc', environment: 'staging' });
  assert.deepEqual(buildInfo({}), { commit: null, environment: null });
});
