import { NextResponse } from 'next/server';
import { StoredDataUnreadableError } from '@/lib/stored-json';
import { getGoals, setGoals, type Goal } from '@/lib/goals';

export async function GET() {
  try {
    return NextResponse.json({ goals: await getGoals() });
  } catch (err) {
    // 409, not 500, and flagged: the client must not show "none" and let the
    // next save overwrite what is there.
    if (err instanceof StoredDataUnreadableError) {
      return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Failed to load goals' }, { status: 500 });
  }
}

// Replaces the whole goal list (the client always sends the full set).
export async function PUT(req: Request) {
  try {
    const { goals } = await req.json();
    if (!Array.isArray(goals) || goals.length > 20) {
      return NextResponse.json({ error: 'Invalid goals' }, { status: 400 });
    }
    const clean: Goal[] = [];
    for (const g of goals) {
      const id = String(g?.id ?? '').slice(0, 40);
      const name = String(g?.name ?? '').trim().slice(0, 60);
      const target = Number(g?.target);
      const account_id =
        g?.account_id == null ? null : String(g.account_id).slice(0, 100);
      if (!id || !name || !Number.isFinite(target) || target <= 0) {
        return NextResponse.json({ error: 'Invalid goal entry' }, { status: 400 });
      }
      clean.push({ id, name, target, account_id });
    }
    await setGoals(clean);
    return NextResponse.json({ goals: clean });
  } catch (err) {
    if (err instanceof StoredDataUnreadableError) {
      return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Failed to save goals' }, { status: 500 });
  }
}
