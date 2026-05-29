import type { WSContext } from 'hono/ws';
import type { SyncMessage } from '@obscura/shared';

/**
 * Tracks live WebSocket connections per user so a push from one device can be
 * relayed to that user's other connected devices. Strictly per-user: a socket
 * is only ever in its own email's set, so broadcasts never cross accounts.
 */
export class SyncHub {
  private connections = new Map<string, Set<WSContext>>();

  add(email: string, ws: WSContext): void {
    let set = this.connections.get(email);
    if (!set) {
      set = new Set();
      this.connections.set(email, set);
    }
    set.add(ws);
  }

  remove(email: string, ws: WSContext): void {
    const set = this.connections.get(email);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.connections.delete(email);
  }

  /** Send a message to all of the user's connections except the originating one. */
  broadcastToOthers(email: string, sender: WSContext, message: SyncMessage): void {
    const set = this.connections.get(email);
    if (!set) return;
    const payload = JSON.stringify(message);
    for (const ws of set) {
      if (ws === sender) continue;
      try {
        ws.send(payload);
      } catch {
        // A dead socket will be cleaned up by its own close handler.
      }
    }
  }
}
