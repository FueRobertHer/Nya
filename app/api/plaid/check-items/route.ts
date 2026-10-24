import { NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/auth';
import { listContainers } from '@/lib/containers';
import { checkItemUsage, unusedDays, type UsageReport } from '@/lib/item-usage';

// Daily check of linked Items that cost money and do nothing (see
// lib/item-usage.ts), hit by Vercel Cron (vercel.json). It only flags them, for
// the owner to review in Settings, Connections; it removes nothing. Authenticated like
// the snapshot cron: excluded from the session gate in proxy.ts, and answering
// 401 unless the request carries `Authorization: Bearer ${CRON_SECRET}`.
//
// The response is counts only. Which institutions are flagged is shown to their
// owner in the app, never here or in the logs.

export const maxDuration = 300;

/** No Item is started after this long into the run: one takes up to two
 *  Plaid calls of 45 s each (lib/plaid.ts), so one started by then still
 *  finishes inside maxDuration. The rest are counted as deferred and checked
 *  the next day: a Plaid outage used to run the cron past 300 s, with no
 *  answer and no counts. */
const START_BUDGET_MS = 200_000;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !(await secretsMatch(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let registry;
  try {
    registry = await listContainers();
  } catch {
    console.error('Item check: the container registry could not be read.');
    return NextResponse.json({ error: 'The container registry could not be read.' }, { status: 500 });
  }

  const until = Date.now() + START_BUDGET_MS;
  const results: ({ container: string } & (UsageReport | { error: string }))[] = [];
  for (const c of registry) {
    if (c.status !== 'active') continue;
    try {
      results.push({ container: c.id, ...(await checkItemUsage({ container: c.id }, { until })) });
    } catch {
      // One container's trouble costs the others nothing.
      console.error('Item check failed for a container.');
      results.push({ container: c.id, error: 'Check failed' });
    }
  }

  const total = results.reduce((n, r) => n + ('flagged' in r ? r.flagged : 0), 0);
  const deferred = results.reduce((n, r) => n + ('deferred' in r ? (r.deferred ?? 0) : 0), 0);
  console.log(`Item check: ${results.length} container(s), ${total} Item(s) flagged for review${deferred > 0 ? `, ${deferred} left for tomorrow (out of time)` : ''}.`);
  const failed = results.some((r) => 'error' in r);
  return NextResponse.json({ flag_after_days: unusedDays(), results }, { status: failed ? 500 : 200 });
}
