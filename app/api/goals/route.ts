import { NextResponse } from 'next/server';
import { effectiveLinks, getLinks, liveAccountIds, resolveId, type Link } from '@/lib/links';
import { StoredDataUnreadableError, describeUnreadable } from '@/lib/stored-json';
import { getGoals, setGoals, type Goal } from '@/lib/goals';

export async function GET() {
  try {
    const goals = await getGoals();
    // A goal tracking an account that has since been linked to a new id
    // (lib/links.ts) follows it, so its progress keeps working after a
    // reconnect. The stored goal isn't touched here; the next save from the
    // client writes the current id, which is harmless and survives an unlink.
    // Links that can't be read leave the ids as stored.
    let links = new Map<string, Link>();
    try {
      links = effectiveLinks(await getLinks(), await liveAccountIds());
    } catch {
      links = new Map();
    }
    return NextResponse.json({
      goals: goals.map((g) => (g.account_id ? { ...g, account_id: resolveId(g.account_id, links) } : g)),
    });
  } catch (err) {
    // 409, not 500, and flagged: the client must not show "none" and let the
    // next save overwrite what is there.
    if (err instanceof StoredDataUnreadableError) {
      console.error('Stored goals unreadable:', describeUnreadable(err));
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
      console.error('Stored goals unreadable:', describeUnreadable(err));
      return NextResponse.json({ error: err.message, unreadable: true }, { status: 409 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Failed to save goals' }, { status: 500 });
  }
}
