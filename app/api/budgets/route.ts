import { NextResponse } from 'next/server';
import { getBudgets, setBudgets, type Budgets } from '@/lib/budgets';

export async function GET() {
  try {
    return NextResponse.json({ budgets: await getBudgets() });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to load budgets' }, { status: 500 });
  }
}

// Replaces the whole budget set (the client always sends the full map).
export async function PUT(req: Request) {
  try {
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
    await setBudgets(clean);
    return NextResponse.json({ budgets: clean });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Failed to save budgets' }, { status: 500 });
  }
}
