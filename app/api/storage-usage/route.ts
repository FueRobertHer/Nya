import { NextResponse } from 'next/server';
import { readStorageUsage } from '@/lib/blob-sizes';
import { maxBlobChars } from '@/lib/blob';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';

// How much this deployment's container stores where it can grow large,
// measured now (lib/blob-sizes.ts): the transaction and investment blobs per
// Item, and every store on the storage seam that holds something, each with
// its largest value, beside the ceiling each write is measured against. Not
// the older stores kept as hashes, so no figure here is the container's whole
// size. Behind the session gate.

export async function GET() {
  try {
    const ctx = await dataCtx();
    return NextResponse.json({ container: ctx.container, ceiling_chars: maxBlobChars(), ...(await readStorageUsage(ctx)) });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error('Storage usage read failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not read storage usage' }, { status: 500 });
  }
}
