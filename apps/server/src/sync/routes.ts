import type { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { UpgradeWebSocket } from 'hono/ws';
import { SyncMessageSchema } from '@obscura/shared';
import type { SyncMessage } from '@obscura/shared';
import type { UpdateStore } from '../db/updates.js';
import type { SyncHub } from './hub.js';

interface SyncDeps {
  upgradeWebSocket: UpgradeWebSocket;
  sessions: Map<string, string>; // sessionToken → email
  updates: UpdateStore;
  hub: SyncHub;
}

function send(ws: WSContext, message: SyncMessage): void {
  ws.send(JSON.stringify(message));
}

/**
 * Mount the encrypted-sync WebSocket at GET /api/sync. The server is a dumb
 * append-and-relay layer over opaque ciphertext:
 *   - push  → append to the user's log, ack the assigned seq to the sender,
 *             and broadcast the stored update to the user's other devices.
 *   - pull  → reply with every update after the client's last seq, so a
 *             (re)connecting device rebuilds its doc from what it's missing.
 */
export function registerSyncRoutes(app: Hono, deps: SyncDeps): void {
  const { upgradeWebSocket, sessions, updates, hub } = deps;

  app.get(
    '/api/sync',
    upgradeWebSocket((c) => {
      // Authenticate the channel up front. Browsers can't set headers on a
      // WebSocket handshake, so the session token rides in the query string.
      // (Phase 7: tokens in URLs can leak via logs — move to a subprotocol or
      // a short-lived ticket before shipping.)
      const token = c.req.query('token') ?? '';
      const email = sessions.get(token) ?? null;

      if (!email) {
        return {
          onOpen: (_evt, ws) => ws.close(1008, 'unauthorized'),
        };
      }

      return {
        onOpen: (_evt, ws) => {
          hub.add(email, ws);
        },

        onMessage: async (evt, ws) => {
          if (typeof evt.data !== 'string') return; // we only speak JSON text
          const parsed = SyncMessageSchema.safeParse(safeJson(evt.data));
          if (!parsed.success) return;
          const msg = parsed.data;

          if (msg.type === 'push') {
            const stored = await updates.append(
              email,
              msg.docId,
              msg.encryptedUpdate,
              msg.originClient,
            );
            // Tell the sender which seq it got (so it can advance its cursor)…
            send(ws, { type: 'ack', docId: msg.docId, seq: stored.seq });
            // …and relay the opaque blob to the user's other live devices.
            hub.broadcastToOthers(email, ws, {
              type: 'updates',
              docId: msg.docId,
              updates: [stored],
            });
            return;
          }

          if (msg.type === 'pull') {
            const missing = await updates.listSince(email, msg.docId, msg.fromSeq);
            send(ws, { type: 'updates', docId: msg.docId, updates: missing });
            return;
          }

          // 'updates' / 'ack' are server→client only; ignore if a client sends them.
        },

        onClose: (_evt, ws) => {
          hub.remove(email, ws);
        },

        onError: (_evt, ws) => {
          hub.remove(email, ws);
        },
      };
    }),
  );
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
