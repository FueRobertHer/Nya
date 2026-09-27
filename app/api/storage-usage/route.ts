import { NextResponse } from 'next/server';
import { readStorageUsage } from '@/lib/blob-sizes';
import { maxBlobChars } from '@/lib/blob';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';

// How much this deployment's container stores in transaction and investment
// blobs, per Item and in total, measured now (lib/blob-sizes.ts), with the
// per-blob ceiling each one is measured against. Behind the session gate.

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
