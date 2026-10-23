import { NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/auth';
import { runAttachmentSweep } from '@/lib/attachment-sweep';

// The nightly clean-up of receipts and documents (lib/attachment-sweep.ts),
// hit by Vercel Cron (vercel.json) after the backup and the day's other jobs.
// Vercel runs crons only on the production deployment.
//
// Authenticated like /api/backup: Vercel sends `Authorization: Bearer
// ${CRON_SECRET}`; without it the route always 401s. Excluded from the
// session gate in proxy.ts.
//
// 500 on a failure, with the reason, so the cron shows red in Vercel; the
// outcome is recorded too (lib/backup.ts recordAttachmentSweep), so the
// dashboard says when the sweep has failed, held back, or stopped. Logs carry
// counts and account ids, never a file's name or anything in it.

export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !(await secretsMatch(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await runAttachmentSweep(new Date());
    console.log('Receipts sweep', JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('Receipts sweep failed', reason);
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
