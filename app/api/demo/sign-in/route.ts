import { NextResponse } from 'next/server';
import { demoUsers } from '@/lib/demo';
import { redis, kEnv } from '@/lib/storage';

// The demo buttons on the sign-in page (lib/demo.ts): a form post naming a
// demo account; answers with Clerk's sign-in page carrying a one-minute
// ticket for it, which signs the visitor in. Public (proxy.ts lets it
// through): it only ever signs in as a listed demo account, and only on
// Preview. Limited per address, since each ticket is a call to Clerk.

const MAX_PER_WINDOW = 20;
const WINDOW_SECONDS = 10 * 60;

export async function POST(req: Request) {
  const users = demoUsers();
  if (users.length === 0) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const form = await req.formData().catch(() => null);
  const user = users.find((u) => u.id === form?.get('user'));
  if (!user) return NextResponse.json({ error: 'Unknown demo account' }, { status: 400 });

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const key = kEnv(`ratelimit:demo:${ip}`);
  try {
    const count = await redis().incr(key);
    if (count === 1) await redis().expire(key, WINDOW_SECONDS);
    if (count > MAX_PER_WINDOW) return NextResponse.json({ error: 'Too many demo sign-ins. Try again in a few minutes.' }, { status: 429 });
  } catch {
    // Redis unavailable: the limiter is a courtesy to Clerk, not a lock.
  }

  try {
    const { signInTicket } = await import('@/lib/clerk-tickets');
    const ticket = await signInTicket(user.id);
    return NextResponse.redirect(new URL(`/sign-in?__clerk_ticket=${encodeURIComponent(ticket)}`, req.url), 303);
  } catch (err) {
    console.error('Demo sign-in failed', err instanceof Error ? err.name : err);
    return NextResponse.redirect(new URL('/sign-in?demo=unavailable', req.url), 303);
  }
}
