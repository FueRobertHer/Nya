import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { plannedStore } from '@/lib/planned-store';
import { EMPTY_PLANNED, parsePlanned } from '@/lib/planned';

// The forecast's planned items, the detected bills and income said not to be
// recurring, and the low-balance warning (lib/planned.ts). GET answers the
// empty plan when nothing was ever saved; PUT replaces the whole value (the
// client always sends all of it, through lib/whole-list-store.ts), after
// checking every field. The forecast itself is worked out in the browser and
// never stored.

export async function GET() {
  try {
    const ctx = await dataCtx();
    return NextResponse.json({ planned: (await plannedStore.get(ctx)) ?? EMPTY_PLANNED });
  } catch (err) {
    return storeFailure(err, 'Failed to load planned items');
  }
}

export async function PUT(req: Request) {
  try {
    const ctx = await dataCtx();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid planned items' }, { status: 400 });
    }
    const parsed = parsePlanned(typeof body === 'object' && body !== null ? (body as { planned?: unknown }).planned : undefined);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    await plannedStore.set(ctx, parsed.ok);
    return NextResponse.json({ planned: parsed.ok });
  } catch (err) {
    return storeFailure(err, 'Failed to save planned items');
  }
}
