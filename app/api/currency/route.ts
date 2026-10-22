import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { currencySettingsStore, isHomeCurrency, withHome, SettingsRefused, NO_SETTINGS } from '@/lib/fx/settings';
import { readLatestRates } from '@/lib/fx/read';
import { isStale } from '@/lib/fx/rates';

// The person's home currency and own rates (lib/fx/settings.ts), and the
// ECB's newest rates beside them for the Currency card.
//
// GET answers the settings (none saved: no home currency, no rates), whether
// they can be used (`problem`, and `removable` only when their bytes are
// damaged, never for a value this release doesn't understand), and the ECB's
// newest publication: its day, its rates, whether they are stale, and which of
// the two fields read couldn't be used (`unusable`: the nightly fetch writes
// them again).
// PUT { home } chooses the home currency, or none with null: only the person
// ever writes it (docs/architecture.md, "Exchange rates"). Strict, through a
// compare-and-set: settings that can't be read are never written over (409).
// DELETE removes settings whose bytes are damaged, once the person confirms
// on the card; anything else is refused.
//
// Conversion happens on every read, after both caches, so nothing here
// clears a cache.

export async function GET() {
  try {
    const ctx = await dataCtx();
    const [report, ecb] = await Promise.all([currencySettingsStore.getReport(ctx), readLatestRates()]);
    const settings = report.value ?? NO_SETTINGS;
    const usable = !report.unreadable && !report.unrecognised;
    return NextResponse.json({
      home: usable ? settings.home : null,
      own: usable ? settings.own : [],
      changes: usable ? settings.changes : [],
      problem: report.unreadable ? 'unreadable' : report.unrecognised ? 'unrecognised' : null,
      removable: report.unreadable,
      ecb: {
        date: ecb.latest?.date ?? null,
        rates: ecb.latest?.rates ?? {},
        stale: isStale(ecb, Date.now()),
        fetch_ok: ecb.fetch?.ok ?? null,
        unusable: ecb.unusable,
      },
    });
  } catch (err) {
    return storeFailure(err, 'Failed to load your currency settings');
  }
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Send { "home": "EUR" }, or null for none.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'home') || !('home' in body)) {
    return NextResponse.json({ error: 'Send { "home": "EUR" }, or null for none.' }, { status: 400 });
  }
  const home = (body as { home: unknown }).home;
  if (home !== null && !isHomeCurrency(home)) {
    return NextResponse.json({ error: 'The home currency is a three-letter ISO code, like EUR or USD.' }, { status: 400 });
  }
  try {
    const ctx = await dataCtx();
    const day = new Date().toISOString().slice(0, 10);
    const saved = await currencySettingsStore.update(ctx, (current) => withHome(current, home, day));
    return NextResponse.json({ home: saved?.home ?? null, own: saved?.own ?? [], changes: saved?.changes ?? [] });
  } catch (err) {
    if (err instanceof SettingsRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    return storeFailure(err, 'Failed to save your home currency');
  }
}

export async function DELETE() {
  try {
    const ctx = await dataCtx();
    const report = await currencySettingsStore.getReport(ctx);
    // Only damaged bytes may be removed (lib/repo.ts): an unrecognised value
    // is intact, a release to roll forward to, never data to delete.
    if (!report.unreadable) {
      return NextResponse.json({ error: 'Your currency settings can be read, so there is nothing to remove.' }, { status: 409 });
    }
    await currencySettingsStore.remove(ctx);
    return NextResponse.json({ home: null, own: [], changes: [] });
  } catch (err) {
    return storeFailure(err, 'Failed to remove your currency settings');
  }
}
