import type { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import type { UpgradeWebSocket } from 'hono/ws';
import { SyncMessageSchema } from '@obscura/shared';
import type { SyncMessage } from '@obscura/shared';
import type { UpdateStore } from '../db/updates.js';
import type { SyncHub } from './hub.js';
import type { TicketStore } from './tickets.js';

interface SyncDeps {
  upgradeWebSocket: UpgradeWebSocket;
  sessions: Map<string, string>; // sessionToken → email
  tickets: TicketStore;
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
 *   - pull  → reply with every update after the client's last seq (restoring
 *             from a snapshot first if the client is behind one), so a
 *             (re)connecting device rebuilds its doc from what it's missing.
 *   - snapshot → store a client's encrypted compaction snapshot and prune the
 *             updates it now covers.
 */
export function registerSyncRoutes(app: Hono, deps: SyncDeps): void {
  const { upgradeWebSocket, sessions, tickets, updates, hub } = deps;

  // Mint a short-lived, single-use ticket for opening the sync socket. The
  // long-lived session token authenticates this request via the Authorization
  // header (never a URL), and only the ephemeral ticket then rides the WS URL.
  app.post('/api/sync/ticket', (c) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const email = sessions.get(token) ?? null;
    if (!email) return c.json({ error: 'unauthorized' }, 401);
    return c.json(tickets.issue(email));
  });

  app.get(
    '/api/sync',
    upgradeWebSocket((c) => {
      // Authenticate the channel up front. Browsers can't set headers on a WS
      // handshake, so the opening credential must ride in the query string — we
      // use a single-use, seconds-long ticket (minted above) rather than the
      // session token, so a URL leaked via logs/history exposes nothing usable.
      const ticket = c.req.query('ticket') ?? '';
      const email = tickets.consume(ticket);

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
            // If a snapshot covers ground the client hasn't got, restore from it
            // first (the pruned updates ≤ upToSeq live only in the snapshot now),
            // then send the tail. Otherwise just send the updates it's missing.
            const snapshot = await updates.getLatestSnapshot(email, msg.docId);
            const from = snapshot && snapshot.upToSeq > msg.fromSeq ? snapshot.upToSeq : msg.fromSeq;
            if (snapshot && snapshot.upToSeq > msg.fromSeq) {
              send(ws, {
                type: 'snapshot',
                docId: msg.docId,
                encryptedSnapshot: snapshot.encryptedSnapshot,
                upToSeq: snapshot.upToSeq,
              });
            }
            const missing = await updates.listSince(email, msg.docId, from);
            send(ws, { type: 'updates', docId: msg.docId, updates: missing });
            return;
          }

          if (msg.type === 'snapshot') {
            // Client-uploaded compaction: store it and prune covered updates.
            await updates.saveSnapshot(email, msg.docId, msg.encryptedSnapshot, msg.upToSeq);
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
