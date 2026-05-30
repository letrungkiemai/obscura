import type {
  SignupRequest,
  LoginChallengeResponse,
  LoginResponse,
  SyncTicketResponse,
} from '@obscura/shared';

// Vite proxies /api -> http://localhost:3000 (see vite.config.ts).
const BASE = '/api/auth';

interface Result<T> {
  status: number;
  data: T | null;
}

async function post<T>(path: string, body: unknown): Promise<Result<T>> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as T | null;
  return { status: res.status, data };
}

export function signup(payload: SignupRequest) {
  return post<{ ok: boolean }>('/signup', payload);
}

export function loginChallenge(email: string) {
  return post<LoginChallengeResponse>('/login/challenge', { email });
}

export function login(email: string, authVerifier: string) {
  return post<LoginResponse>('/login', { email, authVerifier });
}

/**
 * Mint a short-lived, single-use ticket for opening the sync WebSocket. The
 * session token authenticates via the Authorization header (kept out of URLs);
 * only the returned ticket goes in the WS query string. Returns null on failure
 * (e.g. an expired session) so the caller can back off and retry.
 */
export async function syncTicket(sessionToken: string): Promise<string | null> {
  const res = await fetch('/api/sync/ticket', {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as SyncTicketResponse | null;
  return data?.ticket ?? null;
}
