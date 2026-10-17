import { NextResponse } from 'next/server';
import { secretsMatch } from '@/lib/auth';
import { rawRedis } from '@/lib/storage';
import { recordOutcome, runBackup, vercelBlobStore } from '@/lib/backup';
import { sweepDestroyedContainers } from '@/lib/account-deletion';

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
//
// First, every container whose key was destroyed by a deletion the day before
// is swept once more (lib/account-deletion.ts sweepDestroyedContainers), so a
// late write is never in tonight's archive. Best effort: a failure there is
// logged, and the backup goes on.

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
  // Timed so the headroom under maxDuration shows in the log, step by step as
  // each finishes: when one fails, the lines before it show where time went.
  const started = Date.now();
  const onStep = (step: string, ms: number) => console.log(`Backup ${step} took ${(ms / 1000).toFixed(1)}s`);
  try {
    const swept = await sweepDestroyedContainers(new Date());
    if (swept.length > 0) console.log(`Swept ${swept.length} deleted container(s) once more before the backup`);
  } catch (err) {
    console.error('The sweep of deleted containers failed; it runs again tomorrow', err instanceof Error ? err.name : typeof err);
  }
  try {
    const result = await runBackup(rawRedis(), store, new Date(), { onStep });
    // Logged before the outcome is recorded, so the line survives even if that
    // write is what stalls.
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      'Backup written',
      result.pathname,
      `${result.bytes} bytes`,
      `${result.keys} keys`,
      `${result.pruned.length} pruned`,
      `key archive ${result.key_archive.pathname} (${result.key_archive.keys} keys, ${result.key_archive.carried.length} carried forward, ${result.key_archive.rewritten.length} rewritten, ${result.key_archive.pruned.length} pruned${result.key_archive.dropped.length > 0 ? `, ${result.key_archive.dropped.length} that didn't read back deleted` : ''})`,
      `${result.shared_in.length} container(s) under a shared key`,
      `${seconds}s`
    );
    await recordOutcome({ ok: true });
    return NextResponse.json(result);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('Backup failed', reason);
    await recordOutcome({ ok: false, reason });
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}
