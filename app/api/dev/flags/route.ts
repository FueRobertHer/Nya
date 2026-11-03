import { NextResponse } from 'next/server';
import { devFlagsHere } from '@/lib/dev-flags';
import { sameSite } from '@/lib/same-site';
import { flagsStore } from '@/lib/flag-store';
import { flagCache } from '@/lib/flag-cache';
import { choiceOf, isFlagKey, valueFromChoice, flagDef, type FlagValue } from '@/lib/flags';
import { StoredDataUnreadableError, StoreRefusedError } from '@/lib/repo';

// Setting a feature switch in local development (lib/dev-flags.ts says
// where): PUT { key, choice }, from /dev/flags. Missing anywhere else. The
// proxy has already turned away anyone signed out, as for every route; anyone
// signed in, demo accounts included, may set one here. The list of who may
// sign in is set from F2's admin page only.
//
// The value is built here from the choice (lib/flags.ts valueFromChoice), an
// audience keeping the accounts it is also on for, and written with its change
// in one step (lib/flag-store.ts), recorded as made in local development. A
// stored value that can't be read is never written over: 409. This server's
// own copy of the switches is forgotten after, so the next page shows it;
// another process (the proxy keeps its own) sees it within 30 seconds.

const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function PUT(req: Request) {
  if (!devFlagsHere()) return json(404, { error: 'Not found' });
  if (!sameSite(req)) return json(403, { error: 'Send it from this site’s own page, as JSON.' });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const key = body?.key;
  if (!isFlagKey(key)) return json(400, { error: 'Name a feature switch this release knows.' });
  if (flagDef(key).value === 'list') return json(400, { error: 'Who may sign in is set on the admin page.' });
  const choice = body?.choice;
  if (valueFromChoice(key, choice, null) === null) return json(400, { error: 'That isn’t a choice this switch takes.' });
  try {
    // The choice already stored writes nothing, and records no change.
    const value = await flagsStore.update(key, (current: FlagValue | null) => (current !== null && choiceOf(key, current) === choice ? current : valueFromChoice(key, choice, current)!), 'local development');
    flagCache.forget();
    return json(200, { key, choice: choiceOf(key, value) });
  } catch (err) {
    if (err instanceof StoredDataUnreadableError) return json(409, { error: 'The stored value of this switch can’t be read, so it was left as it is.', unreadable: true });
    if (err instanceof StoreRefusedError) return json(err.status, { error: err.message });
    console.error('Dev flags: a switch could not be set:', err instanceof Error ? err.name : typeof err);
    return json(500, { error: 'The switch couldn’t be set just now.' });
  }
}
