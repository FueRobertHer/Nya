import { NextResponse } from 'next/server';
import { containerUnavailable } from '@/lib/data-ctx';
import { adminCtx, notAdmin } from '@/lib/admin-items';
import { getContainer, type Ctx } from '@/lib/containers';
import { sameSite } from '@/lib/same-site';
import { freshSignIn, PASSWORD_MAX } from '@/lib/fresh-sign-in';
import { flagsStore } from '@/lib/flag-store';
import { flagCache } from '@/lib/flag-cache';
import { isFlagKey, type FlagValue } from '@/lib/flags';
import { flagChangeNeedsFreshSignIn, FlagChangeRefused, nextFlagValue, NoFlagChange, parseFlagChange } from '@/lib/flag-change';
import { switchRow } from '@/lib/flag-view';
import { StoredDataUnreadableError, StoreRefusedError } from '@/lib/repo';

// The admin page's change to one feature switch (lib/flag-change.ts says
// which changes there are): PUT { key, change, password? }, from the Feature
// switches card on /admin. Answers the flag's row as it now stands
// (lib/flag-view.ts switchRow).
//
// In this order:
//   - the admin alone (lib/admin-items.ts adminCtx): anyone else gets the 404
//     a missing route gets, before the body is read;
//   - from this site's own page, naming its origin (lib/same-site.ts);
//   - a change this flag's kind takes, and an account added must be in the
//     registry and active: 400 with words;
//   - a fresh sign-in (lib/fresh-sign-in.ts) everywhere but Preview and a
//     local `next dev` (flagChangeNeedsFreshSignIn), checked after the
//     request is known to be good, so nobody is asked to confirm it's them
//     for a change that would be refused;
//   - written with its change in one step (lib/flag-store.ts), recorded as
//     made by the admin's container. A change that changes nothing writes
//     nothing and answers 200; a stored value that can't be read is never
//     written over: 409.
// This server's own copy of the switches is forgotten after, so the next page
// shows the change; another process sees it within 30 seconds.

const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function fail(err: unknown): Response {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  console.error('Admin flags: a switch could not be set:', err instanceof Error ? err.name : typeof err);
  return json(500, { error: 'The switch couldn’t be set just now.' });
}

export async function PUT(req: Request) {
  let admin: Ctx | null;
  try {
    admin = await adminCtx();
  } catch (err) {
    return fail(err);
  }
  if (!admin) return notAdmin();
  if (!sameSite(req, { requireOrigin: true })) return json(403, { error: 'Send it from this site’s own page, as JSON.' });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const key = body?.key;
  if (!isFlagKey(key)) return json(400, { error: 'Name a feature switch this release knows.' });
  const change = parseFlagChange(key, body?.change);
  if ('refused' in change) return json(400, { error: change.refused });
  const password = body?.password;
  if (password !== undefined && password !== null && (typeof password !== 'string' || password.length > PASSWORD_MAX)) return json(400, { error: 'password must be text.' });

  try {
    if (change.op === 'add-account' && (await getContainer(change.container))?.status !== 'active') {
      return json(400, { error: 'That account isn’t one in use here.' });
    }
    if (flagChangeNeedsFreshSignIn()) {
      const fresh = await freshSignIn(req, typeof password === 'string' ? password : null);
      if (fresh instanceof NextResponse) return fresh;
    }
    let seen: FlagValue | null = null;
    let value: FlagValue | null;
    try {
      value = await flagsStore.update(
        key,
        (current) => {
          seen = current;
          return nextFlagValue(key, current, change);
        },
        admin.container,
      );
      flagCache.forget();
    } catch (err) {
      if (!(err instanceof NoFlagChange)) throw err;
      value = seen;
    }
    return json(200, { row: switchRow(key, value, 'admin') });
  } catch (err) {
    if (err instanceof FlagChangeRefused) return json(400, { error: err.message });
    if (err instanceof StoredDataUnreadableError) return json(409, { error: 'The stored value of this switch can’t be read, so it was left as it is.', unreadable: true });
    if (err instanceof StoreRefusedError) return json(err.status, { error: err.message });
    return fail(err);
  }
}
