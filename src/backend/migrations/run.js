require('dotenv').config();
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname);

// Forward migrations only, in filename order, minus the ones already applied.
function planMigrations(files, appliedSet) {
  return files
    .filter((f) => f.endsWith('.sql') && !f.includes('_rollback'))
    .sort()
    .filter((f) => !appliedSet.has(f));
}

// Refuse to run against the wrong database. CI sets MIGRATE_EXPECT_REF to the
// target Supabase project ref; Supabase connection strings carry it in the host
// (db.<ref>.supabase.co) or the pooler username (postgres.<ref>).
function assertExpectedTarget(connectionString, expectRef) {
  if (!expectRef) return;
  if (!connectionString || !connectionString.includes(expectRef)) {
    throw new Error(
      `Refusing to migrate: connection string does not contain expected project ref "${expectRef}"`
    );
  }
}

async function run({ check = false } = {}) {
  const connectionString = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
  assertExpectedTarget(connectionString, process.env.MIGRATE_EXPECT_REF);

  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
  const client = await pool.connect();

  try {
    // Create migration tracking table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations_log (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Get list of already-applied migrations
    const { rows: applied } = await client.query(
      'SELECT filename FROM migrations_log ORDER BY filename'
    );
    const appliedSet = new Set(applied.map((r) => r.filename));
    const pending = planMigrations(fs.readdirSync(MIGRATIONS_DIR), appliedSet);

    // --check: report pending migrations without applying them. Exit 3 if any.
    if (check) {
      if (pending.length === 0) {
        console.log('No pending migrations.');
        return 0;
      }
      console.log(`${pending.length} pending migration(s):`);
      for (const file of pending) console.log(`  PENDING  ${file}`);
      return 3;
    }

    if (pending.length === 0) {
      console.log(`No pending migrations (${appliedSet.size} already applied).`);
      return 0;
    }

    let appliedCount = 0;
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO migrations_log (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`  OK    ${file}`);
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`  FAIL  ${file}: ${err.message}`);
        return 1;
      }
    }

    console.log(`\nMigrations complete: ${appliedCount} applied, ${appliedSet.size} skipped.`);
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run({ check: process.argv.includes('--check') })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('Migration runner error:', err.message);
      process.exit(1);
    });
}

module.exports = { planMigrations, assertExpectedTarget };
