import crypto from 'node:crypto';

/** How long an issued ticket stays valid. Just long enough to open the socket. */
export const TICKET_TTL_MS = 30_000;

/**
 * Short-lived, single-use credentials for opening the sync WebSocket. Browsers
 * can't set headers on a WS handshake, so the opening credential must ride in
 * the URL — and URLs leak through server/proxy logs and history. So we keep the
 * long-lived session token out of URLs entirely: the client mints a ticket over
 * an authenticated HTTP request (token in an Authorization header), and only
 * this ephemeral ticket goes in the WS query string. A leaked ticket is worth
 * nothing — it's consumed on first use and expires in seconds regardless.
 */
export class TicketStore {
  private tickets = new Map<string, { email: string; expiresAt: number }>();

  /** Mint a ticket for an authenticated user. */
  issue(email: string): { ticket: string; expiresInMs: number } {
    this.sweep();
    const ticket = crypto.randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { email, expiresAt: Date.now() + TICKET_TTL_MS });
    return { ticket, expiresInMs: TICKET_TTL_MS };
  }

  /**
   * Validate and burn a ticket, returning its email — or null if it's unknown,
   * expired, or already used. Single-use: a valid ticket is deleted here so it
   * can never authenticate a second connection.
   */
  consume(ticket: string): string | null {
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket);
    if (entry.expiresAt < Date.now()) return null;
    return entry.email;
  }

  /** Drop expired tickets so the map can't grow unbounded from unused mints. */
  private sweep(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAt < now) this.tickets.delete(ticket);
    }
  }
}
