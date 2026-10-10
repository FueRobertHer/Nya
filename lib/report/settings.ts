// lib/report/settings.ts
//
// The person's report settings, as stored (lib/report/store.ts, one encrypted
// value per container) and as the report page edits them:
//
//   marked   the categories the person marked as mattering to them for
//            taxes, shown as a group of their own in every report, with an
//            appendix listing their transactions (lib/report/build.ts). Each
//            is a category's words: one of its text keys (lib/categories.ts),
//            which a rename never changes and a merge moves to the category
//            it went into, so a mark follows its category; the page saves
//            each category's own (choiceText). Words no category has any more
//            stay marked, matched by a row's own words.
//
// Only what the person chose. Nya never picks a category for this, suggests
// one, or says how any category is taxed: that is tax advice, and wrong often
// enough to be harmful (#43).
//
// Two checks, on purpose, as lib/allocation/settings.ts has. parseReportSettings
// is what a save must meet (the route runs every PUT through it, and the page's
// sheet each choice): every category text of at most MAX_CATEGORY_CHARS, as
// the app files categories (lower case, spaces collapsed), none twice, at most
// REPORT_SETTINGS_LIMITS.marked of them. isReportSettings is what a stored
// value must be to read back: the same shape and types, closed (a field this
// code doesn't know makes it unrecognised, so an older release never drops
// what a later one added when it saves), but not the limits, which a later
// release may change.
//
// Imports no data and no storage, so the route and the browser both use it.

import { MAX_CATEGORY_CHARS } from '../manual-txn-input';

export type ReportSettings = { v: 1; marked: string[] };

export const EMPTY_REPORT_SETTINGS: ReportSettings = { v: 1, marked: [] };

export const REPORT_SETTINGS_LIMITS = {
  /** Categories marked. More than any person's list of categories. */
  marked: 100,
  /** One category: as long as a recategorization (app/api/recategorize). */
  category: MAX_CATEGORY_CHARS,
} as const;

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A category as the app files one: lower case, spaces collapsed and trimmed
 *  (app/api/recategorize, lib/import/normalize.ts). */
export const categoryKey = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A clean copy of settings, or why they aren't settings. `input` checks
 *  everything a save must meet; otherwise only the shape and types. */
function readSettings(raw: unknown, input: boolean): { settings: ReportSettings } | { error: string } {
  if (!isRecord(raw)) return { error: 'settings must be an object' };
  for (const k of Object.keys(raw)) if (k !== 'v' && k !== 'marked') return { error: `settings has an unknown field "${k.slice(0, 40)}"` };
  if (raw.v !== 1) return { error: 'v must be 1' };
  if (!Array.isArray(raw.marked)) return { error: 'marked must be a list' };
  if (input && raw.marked.length > REPORT_SETTINGS_LIMITS.marked) return { error: `marked must be a list of at most ${REPORT_SETTINGS_LIMITS.marked}` };
  const marked: string[] = [];
  const seen = new Set<string>();
  for (const [i, c] of raw.marked.entries()) {
    if (typeof c !== 'string') return { error: `marked[${i}] must be text` };
    if (!input) {
      marked.push(c);
      continue;
    }
    const key = categoryKey(c);
    if (!key || key.length > REPORT_SETTINGS_LIMITS.category || CONTROL.test(key)) {
      return { error: `marked[${i}] must be a category of 1 to ${REPORT_SETTINGS_LIMITS.category} characters` };
    }
    if (seen.has(key)) return { error: `marked[${i}] names a category already marked` };
    seen.add(key);
    marked.push(key);
  }
  return { settings: { v: 1, marked } };
}

/** A clean copy of settings to save, or why they can't be saved. Categories
 *  are filed as the app files them. */
export function parseReportSettings(raw: unknown): { settings: ReportSettings } | { error: string } {
  return readSettings(raw, true);
}

/** Whether a value is settings as stored: the current shape and types,
 *  whatever limits applied when it was saved. */
export function isReportSettings(v: unknown): v is ReportSettings {
  return 'settings' in readSettings(v, false);
}
