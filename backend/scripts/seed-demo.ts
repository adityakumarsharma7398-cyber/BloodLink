/**
 * CLI entry point for the DEMO_ONLY dataset. Reads `DATABASE_URL` from the real `.env` — never
 * touches hosted Supabase unless that variable is deliberately pointed at it, which the guards
 * below refuse. This must be run explicitly (`npm run demo:seed` / `demo:reset`); nothing at
 * server startup ever calls it (requirement 11).
 *
 * Usage:
 *   npm run demo:seed   -- --yes     Seed (or re-seed) the demo dataset
 *   npm run demo:reset  -- --yes     Remove the demo dataset, seed nothing back
 */
import pg from 'pg';
import { loadRuntimeConfig } from '../src/config/env.js';
import { resetDemoData, seedDemoData } from '../src/demo/seedDemoData.js';

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'seed' && mode !== 'reset') fail('Usage: seed-demo.ts <seed|reset> --yes');
  if (!process.argv.includes('--yes')) {
    fail(`This writes demo data to the database named by DATABASE_URL. Re-run with --yes to confirm you mean the RIGHT database (never production, never hosted unless you intend that).`);
  }

  let config: ReturnType<typeof loadRuntimeConfig>;
  try {
    config = loadRuntimeConfig();
  } catch (error) {
    fail(`Could not load configuration: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (config.env === 'production') {
    fail('Refusing to seed or reset demo data: NODE_ENV=production.');
  }
  if (!config.database.url) {
    fail('DATABASE_URL is not configured.');
  }

  const masked = config.database.url.replace(/:\/\/[^@]+@/, '://***@');
  console.log(`Target database: ${masked}`);

  const client = new pg.Client({ connectionString: config.database.url, ssl: config.database.ssl.mode === 'disable' ? false : { rejectUnauthorized: config.database.ssl.mode === 'verify' } });
  await client.connect();
  try {
    if (mode === 'reset') {
      await resetDemoData(client);
      console.log('Demo dataset removed.');
      return;
    }
    const summary = await seedDemoData(client);
    console.log('Demo dataset seeded:');
    console.log(`  organizations: ${summary.organizations.map((o) => o.name).join(', ')}`);
    console.log(`  facilities: ${summary.facilities.map((f) => f.name).join(', ')}`);
    console.log(`  users: ${summary.users.length}`);
    console.log(`  donors: ${summary.donors.total} (${summary.donors.eligibleForActivation} eligible for activation)`);
    console.log(`  requests: ${summary.requests.map((r) => `${r.requestNumber} (${r.status})`).join(', ')}`);
    console.log(`  historical issued units: ${summary.historicalUnitsIssued}`);
    console.log('\nNext: sign in as one of the demo users and run POST /api/intelligence/runs for Centre A to generate predictions.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
