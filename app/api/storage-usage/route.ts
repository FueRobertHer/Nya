import { NextResponse } from 'next/server';
import { readStorageUsage } from '@/lib/blob-sizes';
import { maxBlobChars } from '@/lib/blob';
import { deploymentContainer, type Deployment } from '@/lib/sessions';

// How much this deployment's container stores in transaction and investment
// blobs, per Item and in total, measured now (lib/blob-sizes.ts), with the
// per-blob ceiling each one is measured against. Behind the session gate.
//
// The sizes do not depend on the container being worked out, so a registry
// that cannot be read costs only the container field, with the reason.

export async function GET() {
  let dep: Deployment | { kind: 'error' };
  try {
    dep = await deploymentContainer();
  } catch {
    dep = { kind: 'error' };
  }
  try {
    const usage = await readStorageUsage();
    return NextResponse.json({
      container: dep.kind === 'container' ? dep.container : null,
      ...(dep.kind === 'container'
        ? {}
        : { container_problem: dep.kind === 'none' ? 'No container exists yet.' : dep.kind === 'unusable' ? dep.reason : 'The container registry could not be read.' }),
      ceiling_chars: maxBlobChars(),
      ...usage,
    });
  } catch (err) {
    console.error('Storage usage read failed', err instanceof Error ? err.name : err);
    return NextResponse.json({ error: 'Could not read storage usage' }, { status: 500 });
  }
}
