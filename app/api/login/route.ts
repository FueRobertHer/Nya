import { NextResponse } from 'next/server';
import { createSessionToken, verifyPassword, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from '@/lib/auth';
import { redis, k } from '@/lib/storage';

// Brute-force protection: at most MAX_FAILURES wrong passwords per IP per
// window, tracked in Redis. Successful login clears the counter. If Redis is
// unreachable we fail open -- login availability beats a rate limit.
const MAX_FAILURES = 10;
const WINDOW_SECONDS = 15 * 60;

function rateLimitKey(req: Request): string {
  // Vercel sets x-forwarded-for; first hop is the client.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  return k(`ratelimit:login:${ip}`);
}

export async function POST(req: Request) {
  try {
    const key = rateLimitKey(req);

    try {
      const failures = await redis().get<number>(key);
      if (failures !== null && Number(failures) >= MAX_FAILURES) {
        return NextResponse.json(
          { error: 'Too many attempts — try again in a few minutes' },
          { status: 429 }
        );
      }
    } catch {
      // Redis unavailable: skip the limiter rather than lock the user out.
    }

    const { password } = await req.json();
    if (!password || !(await verifyPassword(password))) {
      try {
        const failures = await redis().incr(key);
        if (failures === 1) await redis().expire(key, WINDOW_SECONDS);
      } catch {
        // Best-effort counter.
      }
      return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
    }

    try {
      await redis().del(key); // clean slate after a successful login
    } catch {
      // Counter just expires on its own.
    }

    const token = await createSessionToken();
    const res = NextResponse.json({ success: true });
    res.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      // Safari rejects Secure cookies over http://localhost, which would
      // break local dev -- only require Secure in production (always HTTPS on Vercel).
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: SESSION_MAX_AGE_SECONDS,
      path: '/',
    });
    return res;
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
