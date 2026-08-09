import { NextResponse } from 'next/server';
import { getManualAccount, setManualBalance, MAX_BALANCE } from '@/lib/manual';
import { isOwedType } from '@/lib/balance';
import { rememberAccounts } from '@/lib/last-known';
import { computeNetWorth, accountBalanceMap } from '@/lib/networth';
import { recordSnapshot } from '@/lib/history';
import { clearCaches } from '@/lib/cache';
import { secretsMatch } from '@/lib/auth';

// Machine-writable balance updates for manual accounts, so anything that can
// make an HTTP request can feed Nya: a SimpleFIN puller, an OFX/ofxget cron, a
// scraper running on your own machine. This is the escape hatch for
// institutions Plaid doesn't support and that you'd rather not retype monthly.
//
// Scoped to UPDATING accounts that already exist -- never creating them. A
// leaked token can therefore corrupt balances but can't invent accounts, and
// the account_id it would need is only shown inside the app.
//
// Like /api/snapshot this route is excluded from the session gate in proxy.ts
// and authenticates itself instead. Unlike that route it is permanently
// reachable by anyone on the internet rather than called by Vercel's cron, so
// the token comparison is constant-time (lib/auth.ts) rather than `!==`.
//
// Example:
//   curl -X POST https://<host>/api/ingest/balance \
//     -H "Authorization: Bearer $INGEST_SECRET" \
//     -H 'Content-Type: application/json' \
//     -d '{"updates":[{"account_id":"manual_...","balance":1234.56}]}'

const MAX_UPDATES = 50;
const MAX_BODY_BYTES = 64 * 1024;

type Result = {
  account_id: string;
  status: 'updated' | 'not_found' | 'invalid' | 'error';
  reason?: string;
};

export async function POST(req: Request) {
  const secret = process.env.INGEST_SECRET;
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  // The `!secret` half matters: without it, a deploy that hasn't set the env
  // var would leave this route wide open instead of closed.
  if (!secret || !presented || !(await secretsMatch(presented, secret))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Read as text first so the size cap is enforced on the actual payload.
    // A Content-Length check alone is advisory: the header can be absent under
    // chunked encoding, or unparseable, and `NaN > limit` is false either way.
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Body too large' }, { status: 413 });
    }
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      // A malformed body is the caller's bug, not ours: 400, not 500, so a
      // script can tell "I sent garbage" from "the server broke".
      return NextResponse.json({ error: 'Body must be valid JSON' }, { status: 400 });
    }
    // Accept a single update, a bare array, or { updates: [...] }.
    const raw = Array.isArray(body) ? body : Array.isArray(body?.updates) ? body.updates : [body];
    if (raw.length === 0 || raw.length > MAX_UPDATES) {
      return NextResponse.json({ error: 'Invalid updates' }, { status: 400 });
    }

    const results: Result[] = [];
    // Sequential rather than concurrent: two updates naming the same account
    // would otherwise race each other's read-modify-write.
    for (const u of raw) {
      const account_id = String(u?.account_id ?? '').slice(0, 80);
      const balance = Number(u?.balance);

      if (!account_id) {
        results.push({ account_id: '', status: 'invalid', reason: 'Missing account_id' });
        continue;
      }
      if (!Number.isFinite(balance) || Math.abs(balance) > MAX_BALANCE) {
        results.push({ account_id, status: 'invalid', reason: 'Invalid balance' });
        continue;
      }

      // Per-update, so one unreadable record doesn't discard the results of
      // the updates that already succeeded. getManualAccount throws on a
      // decrypt or shape failure by design (lib/manual.ts), and letting that
      // escape the loop would turn a partial success into a bare 500 -- the
      // opposite of the per-id reporting contract below.
      try {
        const existing = await getManualAccount(account_id);
        if (!existing) {
          // Reported rather than silently ignored, so a script pointed at a
          // stale id fails visibly instead of looking healthy forever.
          results.push({ account_id, status: 'not_found' });
          continue;
        }
        if (isOwedType(existing.type) && balance < 0) {
          results.push({
            account_id,
            status: 'invalid',
            reason: 'Credit and loan balances are the amount owed, so they cannot be negative',
          });
          continue;
        }

        await setManualBalance(account_id, balance);
        results.push({ account_id, status: 'updated' });
      } catch (err) {
        console.error(`Ingest failed for ${account_id}`, err);
        results.push({ account_id, status: 'error', reason: 'Could not read or write this account' });
      }
    }

    const updated = results.filter((r) => r.status === 'updated').length;

    if (updated > 0) {
      await clearCaches();

      // Record the snapshot here rather than waiting for the app to be opened
      // or for the 13:00 UTC cron. Without this a nightly script would write
      // nothing to the chart, and one running after the cron would sit a full
      // day behind forever. Same gating as /api/snapshot: only a clean,
      // non-empty read gets recorded.
      try {
        const { institutions, netWorth } = await computeNetWorth();
        const clean = institutions.every((i) => !i.error);
        // `recorded` reflects whether the point actually landed, not just
        // whether we tried: recordSnapshot swallows its own errors, and a
        // script that trusts this field deserves the truth.
        const recorded =
          clean && institutions.length > 0
            ? await recordSnapshot(netWorth, accountBalanceMap(institutions))
            : false;
        // Keep accounts:meta in step with the snapshot, for the same reason
        // /api/snapshot does: an account this read learned about but no
        // dashboard load has seen would otherwise block recovery for its whole
        // institution (lib/last-known.ts refuses to draw a partial one).
        await rememberAccounts(institutions);
        return NextResponse.json({ updated, recorded, results });
      } catch (err) {
        // The balances did land; only the snapshot failed. Say so rather than
        // reporting a failure that would make a script retry the write.
        console.error('Ingest snapshot failed', err);
        return NextResponse.json({ updated, recorded: false, results });
      }
    }

    return NextResponse.json({ updated, recorded: false, results });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Ingest failed' }, { status: 500 });
  }
}
