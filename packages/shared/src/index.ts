import { z } from 'zod';

// --- Crypto / auth wire format ---
// Base64 (URL-safe, no padding) encoded binary. The server treats all of these
// as opaque strings; it can never derive a key or decrypt content from them.
const b64 = z.string().min(1);

export const KdfParamsSchema = z.object({
  opsLimit: z.number().int().positive(),
  memLimit: z.number().int().positive(),
  algorithm: z.number().int(), // libsodium crypto_pwhash_ALG_* (Argon2id)
});
export type KdfParams = z.infer<typeof KdfParamsSchema>;

export const SignupRequestSchema = z.object({
  email: z.string().email(),
  kdfSalt: b64,
  kdfParams: KdfParamsSchema,
  authVerifier: b64, // server stores only a hash of this
  wrappedDek: b64, // DEK wrapped with the master key
  wrappedDekRecovery: b64, // DEK wrapped with the recovery key
});
export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const LoginChallengeRequestSchema = z.object({ email: z.string().email() });
export type LoginChallengeRequest = z.infer<typeof LoginChallengeRequestSchema>;

export const LoginChallengeResponseSchema = z.object({
  kdfSalt: b64,
  kdfParams: KdfParamsSchema,
});
export type LoginChallengeResponse = z.infer<typeof LoginChallengeResponseSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  authVerifier: b64,
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  sessionToken: b64,
  wrappedDek: b64,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RecoverChallengeResponseSchema = z.object({ wrappedDekRecovery: b64 });
export type RecoverChallengeResponse = z.infer<typeof RecoverChallengeResponseSchema>;

// Resetting credentials (after passphrase rotation or recovery) resubmits the
// same shape as signup, keyed by email.
export const ResetRequestSchema = SignupRequestSchema;
export type ResetRequest = z.infer<typeof ResetRequestSchema>;

// --- Users ---
export const UserSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type User = z.infer<typeof UserSchema>;

// --- Documents ---
export const DocumentSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string().uuid(),
  encryptedTitle: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const CreateDocumentSchema = z.object({
  encryptedTitle: z.string(),
});
export type CreateDocumentInput = z.infer<typeof CreateDocumentSchema>;

// --- Document updates (the encrypted CRDT append-log) ---
export const DocUpdateSchema = z.object({
  id: z.string().uuid(),
  docId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  encryptedUpdate: z.string(), // base64-encoded ciphertext
  originClient: z.string(),
  createdAt: z.coerce.date(),
});
export type DocUpdate = z.infer<typeof DocUpdateSchema>;

/**
 * Until multi-document support lands (Phase 6) each user has a single note. This
 * fixed (nil) UUID identifies it on the wire so the sync protocol is already
 * doc-addressed and needs no changes when real per-document ids arrive.
 */
export const DEFAULT_DOC_ID = '00000000-0000-0000-0000-000000000000';

// --- Sync WebSocket message envelope ---
// All `encryptedUpdate`s are base64 (URL-safe, no padding) ciphertext; the
// server appends and relays them as opaque bytes and can never decrypt them.
export const SyncMessageSchema = z.discriminatedUnion('type', [
  // client → server: a freshly-encrypted local Yjs update to append + relay.
  z.object({
    type: z.literal('push'),
    docId: z.string().uuid(),
    encryptedUpdate: z.string(),
    originClient: z.string(),
  }),
  // client → server: send me everything after the last seq I have.
  z.object({ type: z.literal('pull'), docId: z.string().uuid(), fromSeq: z.number().int().nonnegative() }),
  // server → client: appended/relayed updates (pull response or live broadcast).
  z.object({ type: z.literal('updates'), docId: z.string().uuid(), updates: z.array(DocUpdateSchema) }),
  // server → the pushing client: the seq assigned to its push.
  z.object({ type: z.literal('ack'), docId: z.string().uuid(), seq: z.number().int().nonnegative() }),
  // Compaction. Same shape both ways:
  //   client → server: "here's a full encrypted snapshot of the doc as of
  //                      upToSeq; store it and prune updates ≤ upToSeq."
  //   server → client: "you're behind a snapshot; restore from this, then I'll
  //                      send the tail of updates after upToSeq."
  z.object({
    type: z.literal('snapshot'),
    docId: z.string().uuid(),
    encryptedSnapshot: z.string(),
    upToSeq: z.number().int().nonnegative(),
  }),
]);
export type SyncMessage = z.infer<typeof SyncMessageSchema>;
