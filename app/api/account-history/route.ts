import { NextResponse } from 'next/server';
import { getAccountHistory } from '@/lib/history';

// Balance history for a single account (real snapshots + estimated
// backfill), for the per-account chart in the Accounts tab. Reads only from
// Redis -- no Plaid calls -- so it's fast enough to fetch on tap.

export async function GET(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing account id' }, { status: 400 });
    }
    const points = await getAccountHistory(id);
    return NextResponse.json({ points });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to fetch account history' }, { status: 500 });
  }
}
