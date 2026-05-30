import type { MiddlewareHandler } from 'hono';

interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per key per window. */
  max: number;
}

/**
 * Best-effort in-memory fixed-window rate limiter, keyed by client IP. Defense
 * in depth for the auth routes: it blunts credential brute-force and signup /
 * enumeration spam. Keyed off `x-forwarded-for` (the deploy terminates TLS at a
 * proxy); with no proxy header all callers share one bucket, which still caps
 * total throughput. Not a substitute for the constant-time, decoy-response
 * design of the endpoints themselves — just a coarse ceiling.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return async (c, next) => {
    const fwd = c.req.header('x-forwarded-for') ?? '';
    const key = fwd.split(',')[0]?.trim() || 'global';
    const now = Date.now();

    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
    } else if (entry.count >= opts.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'rate_limited' }, 429);
    } else {
      entry.count++;
    }

    // Opportunistically drop a stale bucket so the map can't grow unbounded.
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }

    await next();
  };
}
