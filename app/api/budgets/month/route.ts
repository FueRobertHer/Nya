import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { budgetsWithoutHistory, readAppBudgets, readBudgetMonth } from '@/lib/budget-month';
import { leftOutByCurrency, leftOutText } from '@/lib/spending';
import { indexTaxonomy } from '@/lib/categories';
import { rollingIn, rolloverStarts } from '@/lib/rollover';
import { readMonthParams, rolloverFailure } from '@/lib/rollover-http';

// A month of budgets for the Budgets tab (#37, lib/budget-month.ts): each
// budget's amount that month (what it was then, lib/rollover.ts), its carry
// into the month when it rolls over, the month's spending against it, the
// income pool when income carryover is on, and which months may be
// incomplete, worked out on the server from the stored history back to the
// first month any carry counts, so the tab and the read-only API agree.
//
// GET ?month=YYYY-MM&today=YYYY-MM[&history=1]. `today` is this month as the
// page has it (a month some time zone is in now); `month` the one shown, this
// month by default, back to MAX_MONTHS_BACK months. The first read with
// budgets begins the record of budgets by month, and each notes the budget set
// in it (lib/budget-months-store.ts).
//
// This month, when no budget rolls over in it and income carryover is off, is
// answered from the budgets and their record alone, with no transactions read
// (lib/budget-month.ts ONLY WHAT IS COUNTED IS READ): `history` false, and
// currency, spent, earliest, gaps and the left-out texts empty, since the page
// counts the month's own spending itself. `history=1` reads them all the same,
// for the month picker and the months a rollover can start from.
//
// The answer, for the page to render with the meters it already draws:
//   history                  whether the stored history was read (see above)
//   month, today, currency   the months, and the currency every figure is in
//   budgets                  that month's amounts, by category and group id
//   assumed                  ids whose amount that month was never recorded
//   recorded_since           the month the record began
//   carries                  each budget rolling over that month, by id
//   rollover                 each budget rolling over now, by id: the month
//                            its rollover began (for the editor)
//   starts                   each budget now, by id: the earliest month its
//                            rollover can count from (when it began, or as far
//                            back as one can start, for one older than the record)
//   spent                    that month's spending by category id
//   income, pool             the income carryover setting, and its pool
//   earliest                 the first month with any transactions
//   gaps                     months that may be incomplete, and why
//   left_out_text, notes     what the month's totals left out, and the read's notes
//   counted_left_out_text    what the earlier months a carry or the pool counts
//                            left out for being in another currency

export async function GET(req: Request) {
  try {
    const params = readMonthParams(new URL(req.url).searchParams);
    if ('error' in params) return NextResponse.json({ error: params.error }, { status: 400 });
    const ctx = await dataCtx();
    const app = await readAppBudgets(ctx, params.today);
    const plain = params.history ? null : budgetsWithoutHistory(app, params.month, params.today);
    if (plain) {
      const ix = indexTaxonomy(app.taxonomy);
      return NextResponse.json({
        history: false,
        month: params.month,
        today: params.today,
        currency: null,
        budgets: plain.budgets,
        assumed: plain.assumed,
        recorded_since: plain.recorded_since,
        carries: plain.carries,
        rollover: rollingIn(ix, app.budgetsNow, app.months, params.today),
        starts: rolloverStarts(ix, app.budgetsNow, app.months, params.today),
        spent: {},
        income: app.income,
        pool: null,
        earliest: null,
        gaps: [],
        left_out_text: null,
        counted_left_out_text: null,
        notes: [],
      });
    }
    const read = await readBudgetMonth(ctx, { month: params.month, today: params.today, app });
    const leftOut = leftOutByCurrency(read.monthRows.filter((t) => t.amount > 0), read.currency);
    return NextResponse.json({
      history: true,
      month: read.month,
      today: read.today,
      currency: read.currency,
      budgets: read.view.budgets,
      assumed: read.view.assumed,
      recorded_since: read.view.recorded_since,
      carries: read.view.carries,
      // For the editor, on the page's this month: each budget rolling over
      // now, and the earliest month each can roll over from.
      rollover: rollingIn(read.ix, read.budgetsNow, read.months, read.today),
      starts: rolloverStarts(read.ix, read.budgetsNow, read.months, read.today),
      spent: read.spent,
      income: read.income,
      pool: read.pool,
      earliest: read.earliest,
      gaps: read.gaps,
      left_out_text: leftOutText(leftOut, read.currency, { where: 'these budgets' }),
      counted_left_out_text: leftOutText(read.countedLeftOut, read.currency, { where: 'what rolled over from earlier months', plural: false }),
      notes: read.activity.notes,
    });
  } catch (err) {
    return rolloverFailure(err, 'Failed to load the month’s budgets');
  }
}
