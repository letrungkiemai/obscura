/**
 * Postgres-backed store check. Spins up a throwaway database, migrates it, and
 * exercises PostgresAccountStore + PostgresUpdateStore through their interfaces:
 * account round-trip + update, monotonic per-(owner,doc) seq, incremental
 * listSince, bytea blob fidelity, and per-user isolation. Drops the db at the end.
 *
 * Run: ./apps/server/node_modules/.bin/tsx apps/server/src/db/verify-db.ts
 */
import crypto from 'node:crypto';
import { createDb, getDatabaseUrl } from './db.js';
import { migrateToLatest } from './migrator.js';
import { PostgresAccountStore } from './accounts.js';
import { PostgresUpdateStore } from './updates.js';
import type { Account } from './accounts.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const b64 = (n = 32) => crypto.randomBytes(n).toString('base64url');

function account(email: string): Account {
  return {
    email,
    kdfSalt: b64(16),
    kdfParams: { opsLimit: 2, memLimit: 67108864, algorithm: 2 },
    authVerifierHash: b64(),
    wrappedDek: b64(),
    wrappedDekRecovery: b64(),
  };
}

async function main() {
  // Create a uniquely-named scratch db off the configured admin connection.
  const baseUrl = getDatabaseUrl();
  const dbName = `obscura_verify_${crypto.randomBytes(4).toString('hex')}`;
  const admin = createDb(baseUrl);
  await admin.executeQuery({ sql: `CREATE DATABASE ${dbName}`, parameters: [] } as never);
  await admin.destroy();

  const url = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const db = createDb(url);

  try {
    await migrateToLatest(db);
    const accounts = new PostgresAccountStore(db);
    const updates = new PostgresUpdateStore(db);

    // --- accounts: create / find / update ---
    const alice = account('alice@example.com');
    await accounts.create(alice);
    await accounts.create(account('bob@example.com'));

    const found = await accounts.findByEmail('alice@example.com');
    assert(found !== null, 'alice found');
    assert(found!.authVerifierHash === alice.authVerifierHash, 'verifier hash round-trips');
    assert(found!.kdfParams.memLimit === 67108864, 'kdf_params jsonb round-trips as object');
    assert((await accounts.findByEmail('nobody@example.com')) === null, 'unknown email → null');

    const newDek = b64();
    await accounts.update('alice@example.com', { wrappedDek: newDek });
    assert((await accounts.findByEmail('alice@example.com'))!.wrappedDek === newDek, 'update persists');

    // --- updates: monotonic seq, blob fidelity ---
    const docId = '00000000-0000-0000-0000-000000000000';
    const blobs = [b64(50), b64(50), b64(50)];
    const seqs: number[] = [];
    for (const blob of blobs) {
      const u = await updates.append('alice@example.com', docId, blob, 'devA');
      seqs.push(u.seq);
      assert(u.encryptedUpdate === blob, 'append returns the exact blob (bytea fidelity)');
    }
    assert(JSON.stringify(seqs) === JSON.stringify([1, 2, 3]), `seq is monotonic 1..3 (got ${seqs})`);

    const all = await updates.listSince('alice@example.com', docId, 0);
    assert(all.length === 3, `listSince(0) returns all 3 (got ${all.length})`);
    assert(all.every((u, i) => u.encryptedUpdate === blobs[i] && u.seq === i + 1), 'ordered + blobs intact');

    const partial = await updates.listSince('alice@example.com', docId, 2);
    assert(partial.length === 1 && partial[0].seq === 3, 'listSince(2) returns only seq 3');

    // --- per-user isolation ---
    await updates.append('bob@example.com', docId, b64(50), 'devB');
    const bobLog = await updates.listSince('bob@example.com', docId, 0);
    assert(bobLog.length === 1 && bobLog[0].seq === 1, "bob's log is independent (own seq from 1)");
    const aliceLog = await updates.listSince('alice@example.com', docId, 0);
    assert(aliceLog.length === 3, "bob's append did not leak into alice's log");

    // --- concurrent appends keep seq gap-free (retry-on-conflict path) ---
    const before = (await updates.listSince('alice@example.com', docId, 0)).length;
    await Promise.all(Array.from({ length: 10 }, () => updates.append('alice@example.com', docId, b64(20), 'devA')));
    const final = await updates.listSince('alice@example.com', docId, 0);
    const finalSeqs = final.map((u) => u.seq);
    const expected = Array.from({ length: before + 10 }, (_, i) => i + 1);
    assert(JSON.stringify(finalSeqs) === JSON.stringify(expected), `10 concurrent appends → contiguous seq (got ${finalSeqs})`);

    // --- snapshots: store prunes covered updates, numbering continues ---
    const total = (await updates.listSince('alice@example.com', docId, 0)).length; // before+10
    const cut = 5;
    const snap = b64(80);
    await updates.saveSnapshot('alice@example.com', docId, snap, cut);
    const latest = await updates.getLatestSnapshot('alice@example.com', docId);
    assert(latest?.upToSeq === cut && latest.encryptedSnapshot === snap, 'latest snapshot round-trips (blob + upToSeq)');
    const afterPrune = await updates.listSince('alice@example.com', docId, 0);
    assert(afterPrune.length === total - cut, `updates ≤ ${cut} pruned (kept ${afterPrune.length}, expected ${total - cut})`);
    assert(afterPrune.every((u) => u.seq > cut), 'only updates after the snapshot remain');

    await updates.saveSnapshot('alice@example.com', docId, b64(80), 3); // stale → ignored
    assert((await updates.getLatestSnapshot('alice@example.com', docId))!.upToSeq === cut, 'stale snapshot ignored');

    const next = await updates.append('alice@example.com', docId, b64(20), 'devA');
    assert(next.seq === total + 1, `append after prune continues numbering (got ${next.seq}, expected ${total + 1})`);

    // isolation: bob has no snapshot
    assert((await updates.getLatestSnapshot('bob@example.com', docId)) === null, "bob has no snapshot of his own");

    console.log('OK — accounts round-trip + update, monotonic seq, incremental listSince, bytea fidelity, isolation, concurrent-append integrity, and snapshot prune/restore all verified.');
  } finally {
    await db.destroy();
    // Drop the scratch db (terminate any lingering backends first).
    const cleanup = createDb(baseUrl);
    await cleanup.executeQuery({ sql: `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`, parameters: [] } as never);
    await cleanup.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
