import type { Context, Next } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

interface Bucket { count: number; resetAt: number; }

export function securityHeaders() {
  return async (context: Context, next: Next) => {
    await next();
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('X-Frame-Options', 'DENY');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    context.header('Cross-Origin-Opener-Policy', 'same-origin');
    context.header('Cross-Origin-Resource-Policy', 'same-origin');
    context.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (new URL(context.req.url).protocol === 'https:') context.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    context.header('Cache-Control', context.req.path === '/health' ? 'no-store' : context.res.headers.get('Cache-Control') ?? 'no-store');
  };
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly windowMs = 60_000) {}

  middleware(name: string, limit: number, trustProxy: boolean) {
    return async (context: Context, next: Next) => {
      const now = Date.now();
      const key = `${name}:${clientAddress(context, trustProxy)}`;
      const current = this.buckets.get(key);
      const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + this.windowMs } : current;
      bucket.count += 1;
      this.buckets.set(key, bucket);
      context.header('RateLimit-Limit', String(limit));
      context.header('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
      context.header('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
      if (bucket.count > limit) {
        context.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
        return context.json({ error: 'rate_limited', error_description: 'Too many requests.' }, 429);
      }
      if (this.buckets.size > 10_000) this.cleanup(now);
      await next();
    };
  }

  private cleanup(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key);
  }
}

function clientAddress(context: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = context.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded.slice(0, 128);
  }
  return getConnInfo(context).remote.address?.slice(0, 128) ?? 'direct-client';
}