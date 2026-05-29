/**
 * CLI: apply pending migrations to the database in DATABASE_URL (or the local
 * default). Run: yarn workspace @obscura/server migrate
 */
import { createDb, getDatabaseUrl } from './db.js';
import { migrateToLatest } from './migrator.js';

async function main() {
  const url = getDatabaseUrl();
  console.log(`Migrating ${url.replace(/:\/\/[^@/]*@/, '://***@')} …`);
  const db = createDb(url);
  try {
    await migrateToLatest(db);
    console.log('Migrations up to date.');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
