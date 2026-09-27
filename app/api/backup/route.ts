import { NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/auth';
import { rawRedis } from '@/lib/storage';
import { recordOutcome, runBackup, vercelBlobStore } from '@/lib/backup';

// Nightly off-site backup (lib/backup.ts), hit by Vercel Cron (vercel.json)
// after the snapshot and its catch-up, so the day's point is in it and the
// export doesn't run while the snapshot writes. Vercel runs crons only on the
// production deployment.
//
// Authenticated like /api/snapshot: Vercel sends `Authorization: Bearer
// ${CRON_SECRET}`; without it the route always 401s. Excluded from the
// session gate in proxy.ts.
//
// 500 on any failure, with the reason, so the cron shows red in Vercel; the
// outcome is recorded too, so the dashboard says when backups have stopped.
// Values are never logged: only the reason and the backup's name and size.

export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !(await secretsMatch(req.headers.get('authorization') ?? '', `Bearer ${secret}`))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const store = await vercelBlobStore();
  if (!store) {
    console.error('Backup skipped: no blob store is connected (BLOB_READ_WRITE_TOKEN is not set)');
    await recordOutcome({ ok: false, reason: 'No blob store is connected.' });
    return NextResponse.json({ error: 'No blob store is connected (BLOB_READ_WRITE_TOKEN is not set).' }, { status: 500 });
  }
  try {
    const result = await runBackup(rawRedis(), store);
    await recordOutcome({ ok: true });
    console.log('Backup written', result.pathname, `${result.bytes} bytes`, `${result.keys} keys`, `${result.pruned.length} pruned`);
    return NextResponse.json(result);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('Backup failed', reason);
    await recordOutcome({ ok: false, reason });
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
