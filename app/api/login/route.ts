import { NextResponse } from 'next/server';
import {
  createSessionToken,
  verifyPassword,
  previewLoginAllowed,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/auth';
import { ContainerError, type ContainerId } from '@/lib/containers';
import { currentEpoch, loginContainer } from '@/lib/sessions';
import { passwordAttemptsExhausted, countWrongPassword, clearWrongPasswords } from '@/lib/rate-limit';

// Brute-force protection: at most LOGIN_MAX_FAILURES wrong passwords per IP
// per window, tracked in Redis and shared with the password asked for again
// before a data download (lib/rate-limit.ts). Successful login clears the
// counter. If Redis is unreachable we fail open: login availability beats a
// rate limit.

export async function POST(req: Request) {
  try {
    if (await passwordAttemptsExhausted(req)) {
      return NextResponse.json(
        { error: 'Too many attempts. Try again in a few minutes.' },
        { status: 429 }
      );
    }

    const { password, previewLogin } = await req.json();

    // One-click login for preview deployments. The browser asks for a session
    // instead of being handed APP_PASSWORD, so the password is never shipped to
    // the client. Refused on production, where previewLoginAllowed() is false.
    if (previewLogin === true) {
      if (!previewLoginAllowed()) {
        return NextResponse.json({ error: 'Not available' }, { status: 403 });
      }
    } else if (!password || !(await verifyPassword(password))) {
      await countWrongPassword(req);
      return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
    }

    await clearWrongPasswords(req); // clean slate after a successful login

    let container: ContainerId;
    try {
      container = await loginContainer();
    } catch (err) {
      if (!(err instanceof ContainerError)) throw err;
      console.error('Login refused:', err.message);
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const token = await createSessionToken({ container, epoch: await currentEpoch(container, Date.now(), { fresh: true }) });
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
