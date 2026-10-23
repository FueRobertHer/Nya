import { NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/auth';
import { fetchEcbRates } from '@/lib/fx/ecb-fetch';

// The nightly fetch of the ECB's euro reference rates (lib/fx/ecb-fetch.ts),
// hit by Vercel Cron at 16:30 UTC (vercel.json), after the ECB publishes at
// about 16:00 CET: 15:00 UTC in winter, 14:00 UTC in summer. Its own cron, apart
// from the snapshot (13:00, 15:00) and the backup (16:00), so neither can
// delay it or be delayed by it. Crons run only on production: elsewhere (a
// preview, an environment just restored into an empty database) an operator
// calls it once by hand with the cron secret (docs/operations.md).
//
// Authenticated like the other crons: excluded from the session gate in
// proxy.ts, and answering 401 unless the request carries
// `Authorization: Bearer ${CRON_SECRET}`. `?full=1` compares and rewrites
// every year rather than only the recent ones.
//
// 200 with what it wrote, or 500 with why not, so Vercel's log shows a failed
// night. Never a person's request: no reader fetches rates.

export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !(await secretsMatch(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const full = new URL(req.url).searchParams.get('full') === '1';
  const outcome = await fetchEcbRates({ full });
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 500 });
}
