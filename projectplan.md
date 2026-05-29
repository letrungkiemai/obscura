The plan:

I want to make a Notion-like note taking web app that runs on the browser
I want to make an API for the client to communicate with the server, using postgres as database
I want End to end encryption
I want the data to be syncronizable between different clients 


Phase 0 — Lock in the stack and scaffold

Client: React + TypeScript + BlockNote (editor) + Yjs (CRDT) + libsodium.js (crypto) + y-indexeddb (local persistence).
Server: Node + TypeScript API (Fastify or Hono are good fits) + Postgres + Kysely + Zod.
Set up a monorepo so the client and server can share TypeScript types and Zod schemas (your single-source-of-truth pattern applies cleanly here).

Phase 1 — Crypto and auth foundation (build this first; it shapes everything)

Design the key hierarchy: passphrase → Argon2id → a master key (stays on the client, never sent) plus a separate auth verifier (sent to the server for login). Generate a random data key (DEK), wrap it with the master key, and store the wrapped DEK + KDF salt + params server-side.
Build signup/login around that: the server only ever stores the auth verifier, KDF params, and the wrapped DEK. On login, the client derives the master key from the passphrase and unwraps the DEK locally. This is also what makes multi-device "just work" — any device with the passphrase can unwrap the same DEK.
Add a recovery key (a second wrapping of the DEK with a random high-entropy string the user saves), so a forgotten passphrase doesn't mean permanently lost notes.

Phase 2 — Editor and local document model

Get BlockNote rendering in React with a single page editing.
Back the editor with a Yjs document using BlockNote's collaboration support (it binds to Yjs via y-prosemirror). Now your document is a CRDT.
Persist the Yjs doc locally with y-indexeddb. At the end of this phase you have a working offline editor with reload-survival — and zero server involvement yet.

Phase 3 — The encrypted sync protocol (the heart of the project)

Hook Yjs's update event: every change emits a small binary update. Encrypt each update with the DEK (AEAD — XChaCha20-Poly1305, fresh nonce each time) before it leaves the client.
Build a WebSocket sync endpoint that receives encrypted update blobs, appends them to Postgres, and broadcasts them to the user's other connected devices.
On connect, a client fetches the encrypted updates it's missing, decrypts them locally, and applies them to rebuild its Yjs doc. The server stays a dumb append-and-relay layer over opaque bytes.

Phase 4 — Postgres schema

users — id, auth_verifier, kdf_salt, kdf_params, wrapped_dek, wrapped_dek_recovery.
documents — id, owner_id, created_at, updated_at, encrypted_title (metadata in plaintext, but encrypt the title — it's content).
doc_updates — id, doc_id, seq (monotonic per doc), encrypted_update (bytea), origin_client, created_at. This append-only log is your sync substrate; index on (doc_id, seq) for fast incremental pulls.
snapshots — doc_id, encrypted_snapshot, up_to_seq. Periodic compaction so a fresh device doesn't have to replay the entire update history.

Phase 5 — Multi-client sync semantics

Incremental pull: each client remembers the last seq it has and only fetches newer updates.
Real-time push: the WebSocket broadcasts new updates to other live devices instantly.
Offline: edits accumulate locally (Yjs + IndexedDB); on reconnect, push the queued updates and pull the missed ones — Yjs merges everything deterministically, so there's no conflict-resolution code to write. This is the payoff of the CRDT choice.
Compaction: have a client periodically write an encrypted snapshot and let the server prune updates older than it.

Phase 6 — Notion-style app shell

Build the sidebar: page list, nested pages, create/rename/delete/reorder.
Model the workspace structure (the page tree and ordering) as its own small Yjs doc, so structural changes sync and merge through the same encrypted pipeline as note content — reordering pages on two devices then merges cleanly too.
Search: client-side only. You can't search ciphertext on the server, so decrypt the user's notes locally (you have them synced anyway) and index in memory or with a small client-side search library.

Phase 7 — Harden and ship

Use HTTPS/WSS throughout (the payload is already E2EE, but still encrypt the transport), authenticate the WebSocket channel, and enforce strict per-user data isolation on every query.
Deploy the Node API + Postgres — Render or Railway, which you'd already looked at, both fit fine since the DB is just storing blobs.
Optionally wrap the client as a PWA for installability and offline resilience.
Test the real scenario end to end: edit a note on Device A while offline, edit the same note on Device B, reconnect both, and confirm the merge is clean and lossless.