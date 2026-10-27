import { NextResponse } from 'next/server';
import { clerkEnabled } from '@/lib/auth-mode';
import { appUrl } from '@/lib/app-url';
import { storeFailure } from '@/lib/store-failure';
import { demoUsers } from '@/lib/demo';
import { demoTarget, SeedRefused } from '@/lib/demo-seed/guard';
import type { DemoName } from '@/lib/demo-seed/profiles';
import { DEFAULT_SCENARIO, scenarioById, scenarioViews } from '@/lib/demo-seed/scenarios';
import { ResetLimited, resetDemoAccount, resetPhase, resetState } from '@/lib/demo-seed/reset';
import { RESET_WINDOW_SECONDS } from '@/lib/demo-seed/store';

// The Demo data card (components/DemoDataCard.tsx): resetting the signed-in
// demo account to a scenario (lib/demo-seed/scenarios.ts), from the app.
//
//   GET   { demo: false } for anyone but a demo account; for one, its
//         scenarios, the one it starts on, the last reset (finished, still
//         running, or stopped part way), how long until the next may run,
//         and why it can't be reset, when it can't
//   POST  { scenario } resets it (lib/demo-seed/reset.ts)
//
// Only ever the signed-in account's own container, only for a demo account
// (lib/demo.ts, which already means Preview, Development or a local
// `next dev`), and only on Plaid's sandbox. The demo has no fresh sign-in, so
// the session is all that stands behind a POST that replaces everything:
// it must come from this site's own page, as JSON, which a form on another
// site can't send without the browser asking first. Once in ten minutes per
// account (the reset's own limit, which is its lock too).

// A reset links each bank and waits for its year of transactions (about a
// minute; the wait is capped below, the links take seconds each).
export const maxDuration = 300;
const HISTORY_TIMEOUT_MS = 90_000;

const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** The signed-in Clerk account, null without Clerk or a sign-in. */
async function signedIn(): Promise<string | null> {
  if (!clerkEnabled()) return null;
  const { auth } = await import('@clerk/nextjs/server');
  return (await auth()).userId ?? null;
}

/** The signed-in demo account and its container, null for anyone else. */
async function signedInDemo() {
  const userId = await signedIn();
  return userId ? demoTarget(userId) : null;
}

/** This site's addresses: the one the request came to (a Preview deployment
 *  has several), and the configured one. */
function ownOrigins(req: Request): string[] {
  const configured = appUrl();
  return [new URL(req.url).origin, ...(configured ? [new URL(configured).origin] : [])];
}

/** Sent by this site's own page: no other origin named, no other site's
 *  fetch, and JSON (which a page on another site can't send without the
 *  browser asking first, and nothing here answers that). */
function sameSite(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (origin !== null && !ownOrigins(req).includes(origin)) return false;
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  return (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

function failure(err: unknown): NextResponse {
  if (err instanceof ResetLimited) return json(429, { error: err.message }, { 'Retry-After': String(err.secondsLeft) });
  if (err instanceof SeedRefused) return json(409, { error: err.message });
  return storeFailure(err, 'The demo couldn’t be reset just now.');
}

export async function GET() {
  try {
    const userId = await signedIn();
    const demo = userId ? demoUsers().find((u) => u.id === userId) : undefined;
    if (!userId || !demo) return json(200, { demo: false });
    const base = { demo: true, scenarios: scenarioViews(), default: DEFAULT_SCENARIO[demo.label as DemoName], window_minutes: RESET_WINDOW_SECONDS / 60 };
    let target;
    try {
      target = await demoTarget(userId);
    } catch (err) {
      // Said on the card, rather than the card going away without a word.
      if (err instanceof SeedRefused) return json(200, { ...base, last: null, next_in_seconds: 0, refused: err.message });
      throw err;
    }
    if (!target) return json(200, { ...base, last: null, next_in_seconds: 0, refused: 'This demo account isn’t set up here yet. Load the page again.' });
    const { record, secondsLeft } = await resetState(target.ctx);
    return json(200, {
      ...base,
      last: record ? { scenario: record.scenario, at: record.finished_at ?? record.started_at, phase: resetPhase(record) } : null,
      next_in_seconds: secondsLeft,
    });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(req: Request) {
  if (!sameSite(req)) return json(403, { error: 'A demo account is reset from its own Settings page.' });
  const body = (await req.json().catch(() => null)) as { scenario?: unknown } | null;
  const scenario = scenarioById(body?.scenario);
  if (!scenario) return json(400, { error: 'Choose one of the scenarios.' });
  try {
    const target = await signedInDemo();
    if (!target) return json(403, { error: 'Only a demo account can be reset.' });
    if ((process.env.PLAID_ENV || 'sandbox') !== 'sandbox') return json(403, { error: 'Demo accounts are reset only on Plaid’s sandbox.' });
    const report = await resetDemoAccount(target, scenario, new Date().toISOString().slice(0, 10), { historyTimeoutMs: HISTORY_TIMEOUT_MS });
    return json(200, { ok: true, scenario: scenario.id, waiting: report.waiting });
  } catch (err) {
    console.error('Demo reset failed', err instanceof Error ? err.name : typeof err);
    return failure(err);
  }
}
