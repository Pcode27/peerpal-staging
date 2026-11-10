// Every secret and variable a workflow reads must be documented in
// docs/staging.md, so the setup checklist can't drift from the pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const wfDir = join(root, '.github', 'workflows');
const doc = readFileSync(join(root, 'docs', 'staging.md'), 'utf8');

// GitHub provides these; they're not part of setup.
const BUILTIN = new Set(['GITHUB_TOKEN']);

function referencedNames() {
  const names = new Map();
  for (const file of readdirSync(wfDir).filter((f) => f.endsWith('.yml'))) {
    const src = readFileSync(join(wfDir, file), 'utf8');
    for (const [, kind, name] of src.matchAll(/\b(secrets|vars)\.([A-Z0-9_]+)/g)) {
      if (!BUILTIN.has(name)) names.set(name, `${kind} in ${file}`);
    }
    // Matrix entries resolved through vars[matrix.*] at runtime.
    for (const [, name] of src.matchAll(/_var:\s*([A-Z0-9_]+)/g)) {
      names.set(name, `vars (matrix) in ${file}`);
    }
  }
  return names;
}

test('every workflow secret/variable is documented in docs/staging.md', () => {
  const names = referencedNames();
  assert.ok(names.size >= 10, `expected staging config names, found ${names.size}`);
  const missing = [...names].filter(([name]) => !doc.includes(`\`${name}\``));
  assert.deepEqual(missing, []);
});

test('deploy workflows refuse to run outside the primary repo (staging mirror)', () => {
  for (const file of ['deploy-staging.yml', 'deploy-production.yml', 'keep-alive.yml']) {
    const src = readFileSync(join(wfDir, file), 'utf8');
    assert.match(src, /if: github\.repository == 'iamparody\/peerpal-app'/, file);
  }
});

test('staging migrations always run with the target-ref guard', () => {
  const src = readFileSync(join(wfDir, 'deploy-staging.yml'), 'utf8');
  assert.match(src, /MIGRATE_EXPECT_REF: \$\{\{ vars\.STAGING_SUPABASE_REF \}\}/);
  assert.match(src, /STAGING_SUPABASE_REF/); // and the config check requires it
});
