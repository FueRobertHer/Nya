import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { StoredDataUnreadableError, describeUnreadable } from '@/lib/stored-json';
import { getBudgets, setBudgets, type Budgets } from '@/lib/budgets';

export async function GET() {
  try {
    const ctx = await dataCtx();
    return NextResponse.json({ budgets: await getBudgets(ctx) });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    // 409, not 500, and flagged: the client must not show "none" and let the
    // next save overwrite what is there.
    if (err instanceof StoredDataUnreadableError) {
      console.error('Stored budgets unreadable:', describeUnreadable(err));
      return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Failed to load budgets' }, { status: 500 });
  }
}

// Replaces the whole budget set (the client always sends the full map).
export async function PUT(req: Request) {
  try {
    const ctx = await dataCtx();
    const { budgets } = await req.json();
    if (typeof budgets !== 'object' || budgets === null || Array.isArray(budgets)) {
      return NextResponse.json({ error: 'Invalid budgets' }, { status: 400 });
    }
    const entries = Object.entries(budgets);
    if (entries.length > 50) {
      return NextResponse.json({ error: 'Too many budgets' }, { status: 400 });
    }
    const clean: Budgets = {};
    for (const [category, amount] of entries) {
      const name = String(category).trim().slice(0, 60);
      const value = Number(amount);
      if (!name || !Number.isFinite(value) || value <= 0) {
        return NextResponse.json({ error: 'Invalid budget entry' }, { status: 400 });
      }
      clean[name] = value;
    }
    await setBudgets(ctx, clean);
    return NextResponse.json({ budgets: clean });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    if (err instanceof StoredDataUnreadableError) {
      console.error('Stored budgets unreadable:', describeUnreadable(err));
      return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Failed to save budgets' }, { status: 500 });
  }
}
