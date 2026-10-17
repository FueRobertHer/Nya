// lib/import/apps/detect.ts
//
// Which app an export is from, by its header row, and the columns each role
// is in. Pure, safe to import from client code.
//
// BY WHAT ONLY THAT APP WRITES. Each app's module says what tells its header
// (lib/import/apps/*.ts recognises): Monarch's Merchant and Original
// Statement; YNAB's Flag or its "Category Group/Category" (YNAB 4's Master
// Category); ZeroSum's Outflow and Inflow beside Tags, with no Flag; Lunch
// Money's Currency beside at least two of its own (Original Name, Parent ID,
// Recurring ID, Created At, Transaction number); Actual's Account, Payee,
// Notes, Category and Amount, with no Currency or Merchant. The first that
// recognises the header wins, in that order, so a header that would fit two
// (ZeroSum's is YNAB's without Flag, plus Tags) goes to the more specific.
// A header none recognises goes to the mapping step, where the person says
// which app it is from and which column is which (columnsFor proposes them).

import { columnsByAlias, headerKey, type AppSpec } from './common';
import { MONARCH } from './monarch';
import { YNAB } from './ynab';
import { ZEROSUM } from './zerosum';
import { LUNCH_MONEY } from './lunchmoney';
import { ACTUAL } from './actual';
import type { AppColumns, AppId } from './types';

/** Every app's reader, in the order headers are tried (see the header). */
export const SPECS: readonly AppSpec[] = [MONARCH, YNAB, ZEROSUM, LUNCH_MONEY, ACTUAL];

export function specOf(app: AppId): AppSpec {
  return SPECS.find((s) => s.app === app)!;
}

/** The app this header is from, with its columns, or null. */
export function detectApp(header: readonly string[]): { app: AppId; columns: AppColumns } | null {
  const keys = new Set(header.map((h) => headerKey(h.replace(/\s*\(\d+\)$/, ''))));
  for (const spec of SPECS) {
    const columns = columnsByAlias(header, spec.aliases);
    if (spec.recognises(columns, keys)) return { app: spec.app, columns };
  }
  return null;
}

/** The columns an app's names find in this header: what the mapping step
 *  proposes for a file the person says is from that app. */
export function columnsFor(app: AppId, header: readonly string[]): AppColumns {
  return columnsByAlias(header, specOf(app).aliases);
}
