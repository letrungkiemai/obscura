import type { SignupRequest, LoginChallengeResponse, LoginResponse } from '@obscura/shared';

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
