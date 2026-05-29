import { z } from 'zod';

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

// --- Sync WebSocket message envelope ---
export const SyncMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('push'), docId: z.string().uuid(), encryptedUpdate: z.string() }),
  z.object({ type: z.literal('pull'), docId: z.string().uuid(), fromSeq: z.number().int() }),
  z.object({ type: z.literal('updates'), docId: z.string().uuid(), updates: z.array(DocUpdateSchema) }),
]);
export type SyncMessage = z.infer<typeof SyncMessageSchema>;
