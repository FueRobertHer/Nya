import { NextResponse } from 'next/server';
import { setRename, clearRename } from '@/lib/renames';
import { clearTransactionsCache } from '@/lib/cache';

// Rename a vendor (applies to every transaction sharing the vendor key). An
// empty name clears the rename, reverting to Plaid's name. The transactions
// route applies renames on top of the fetched data.

export async function POST(req: Request) {
  try {
    const { vendor_key, name } = await req.json();
    if (typeof vendor_key !== 'string' || !vendor_key || vendor_key.length > 200) {
      return NextResponse.json({ error: 'Invalid vendor key' }, { status: 400 });
    }
    if (typeof name !== 'string' || name.length > 100) {
      return NextResponse.json({ error: 'Invalid name' }, { status: 400 });
    }

    const trimmed = name.trim();
    if (trimmed) await setRename(vendor_key, trimmed);
    else await clearRename(vendor_key);
    await clearTransactionsCache(); // the cached payload has the old name

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to rename' }, { status: 500 });
  }
}
