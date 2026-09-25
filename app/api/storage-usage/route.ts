import { NextResponse } from 'next/server';
import { readStorageUsage } from '@/lib/blob-sizes';
import { maxBlobChars } from '@/lib/blob';
import { deploymentContainer } from '@/lib/sessions';

// How much this deployment's container stores in transaction and investment
// blobs, per Item and in total (lib/blob-sizes.ts), with the per-blob ceiling
// each one is measured against. Behind the session gate.

export async function GET() {
  try {
    const dep = await deploymentContainer();
    const usage = await readStorageUsage();
    return NextResponse.json({
      container: dep.kind === 'container' ? dep.container : null,
      ceiling_chars: maxBlobChars(),
      ...usage,
    });
  } catch (err) {
    console.error('Storage usage read failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not read storage usage' }, { status: 500 });
  }
}
