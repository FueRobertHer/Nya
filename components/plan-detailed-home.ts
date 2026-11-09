// components/plan-detailed-home.ts
//
// Home's FI line for a detailed plan, so it says what the Plan says. Only then does
// Home load the law and the tax year and ask for the other accounts' last year. A flat
// plan's line is its flat figures, which this leaves alone at no cost.
//
// A detailed plan's Home reads the allocation settings for itself (useAllocation loads
// on mount, which every Home shouldn't pay for), since what Needs attention says of
// its buckets rests on them. That takes no law: flat plans read nothing.
//
// A plan with `lastsIn` (D9) answers with the earliest stop that lasts, found in the
// simulator's worker (useLastingOnHome, components/plan-lasting.ts), which Home loads
// only for such a plan; a detailed one's drawdown input comes from here, and no search
// runs for it, since that answer would be replaced.

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AllocationSettings } from '@/lib/allocation/settings';
import { isAllocationSettings, overridesOf } from '@/lib/allocation/settings';
import { bucketsToday, type BasisHolding } from '@/lib/fire/buckets-today';
import type { Count } from '@/lib/fire/compile';
import type { InvestedAssets } from '@/lib/fire/inputs';
import type { FiguresRefused, PlanFigures } from '@/lib/fire/plan-figures';
import type { Measured } from '@/lib/fire/plan';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import type { TaxChoices } from '@/lib/fire/tax-choices';
import type { TaxFacts } from '@/lib/fire/tax-facts';
import type { PlanInputsCopy, PlanInputsStore } from '@/lib/plan-inputs-store';
import type { DetailedInput } from '@/lib/fire/plan-detail';
import type { DetailedAnswer } from './plan-detailed';
import { attentionNotes } from './plan-drawdown';
import type { LastingAnswer } from './plan-lasting';
import { planLasting, planSearch } from './plan-search';

type Loaded = typeof import('./plan-detailed');
type SettingsRead = { value: AllocationSettings | null };

/** The allocation settings, read once they are wanted. A failed read counts as settled:
 *  the buckets stand in for what it would say, as they do on the Plan. */
export function useSettingsRead(wanted: boolean): SettingsRead | null {
  const [settings, setSettings] = useState<SettingsRead | null>(null);
  useEffect(() => {
    if (!wanted || settings) return;
    let live = true;
    fetch('/api/allocation-settings')
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { settings?: unknown } | null) => {
        if (live) setSettings({ value: body && isAllocationSettings(body.settings) ? body.settings : null });
      })
      .catch(() => {
        if (live) setSettings({ value: null });
      });
    return () => {
      live = false;
    };
  }, [wanted, settings]);
  return wanted ? settings : null;
}

/** What Needs attention says of a detailed plan, from what its buckets and items hold. */
export function detailAttention(args: { assets: Pick<InvestedAssets, 'accounts' | 'childAccounts'>; holdings: readonly BasisHolding[]; facts: TaxFacts; settings: AllocationSettings | null; plan: FirePlanV2 }) {
  const today = bucketsToday({ assets: args.assets, holdings: args.holdings, tax: args.facts, overrides: overridesOf(args.settings).buckets, partner: args.plan.partnerAge !== null });
  return attentionNotes({ today, items: args.plan.items });
}

export function useDetailOnHome(
  wanted: boolean,
  args: {
    plan: FirePlanV2;
    measured: Measured;
    count: Count;
    flat: PlanFigures | FiguresRefused;
    assets: Pick<InvestedAssets, 'accounts' | 'childAccounts'>;
    holdings: readonly BasisHolding[];
    facts: TaxFacts;
    choices: TaxChoices | null;
    settings: SettingsRead | null;
    store: PlanInputsStore;
    rows: PlanInputsCopy['rows'];
    /** The rows the buckets read. */
    ids: readonly string[];
    paid: number;
    calendarYear: number;
    /** The plan answers with the earliest stop that lasts (D9): its input is handed
     *  back for that, and nothing is searched for. */
    handOff?: boolean;
  }
): (DetailedAnswer & { input?: DetailedInput }) | null {
  const search = planSearch();
  useSyncExternalStore(search.subscribe, search.version, search.version);
  const [loaded, setLoaded] = useState<Loaded | 'failed' | null>(null);
  const { ids, settings } = args;
  const idsKey = ids.join(',');

  useEffect(() => {
    if (!wanted || loaded) return;
    let live = true;
    import('./plan-detailed').then(
      (m) => live && setLoaded(m),
      () => live && setLoaded('failed')
    );
    return () => {
      live = false;
    };
  }, [wanted, loaded]);
  useEffect(() => {
    if (wanted) args.store.fill(ids);
    // idsKey stands for ids, a new list each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, args.store, idsKey]);

  const run = useMemo(() => (loaded && loaded !== 'failed' ? loaded.createDetailedFigures(search) : null), [loaded, search]);
  if (!wanted) return null;
  if (loaded === 'failed') return { figures: args.flat, working: false, failed: true };
  const settled = ids.every((id) => args.rows[id] && !args.rows[id].pending);
  if (!loaded || !run || !settings || !settled) return { figures: args.flat, working: true, failed: false };
  const today = loaded.pageBuckets({ assets: args.assets, holdings: args.holdings, facts: args.facts, settings: settings.value, rows: args.rows, partner: args.plan.partnerAge !== null });
  const input = loaded.detailedInput({ plan: args.plan, tax: args.choices, facts: args.facts, today, paid: args.paid, calendarYear: args.calendarYear });
  if (args.handOff) {
    search.drop('home');
    return { figures: args.flat, working: true, failed: false, input };
  }
  return run('home', args.plan, args.measured, args.count, input, args.flat);
}

/** Home's line for a plan with `lastsIn` (D9), as the Plan's answer has it: loads
 *  components/plan-lasting.ts, and the page's store starts the simulator's worker for
 *  the job. `input`: a detailed plan's, null in the flat model; `held`, a detailed
 *  plan's input isn't there yet. Null when not wanted, or with nothing to search with. */
export function useLastingOnHome(
  wanted: boolean,
  args: { plan: FirePlanV2; measured: Measured; count: Count; flat: PlanFigures | FiguresRefused; input: DetailedInput | null; held: boolean }
): LastingAnswer | null {
  const store = planLasting();
  useSyncExternalStore(store.subscribe, store.version, store.version);
  const [loaded, setLoaded] = useState<typeof import('./plan-lasting') | 'failed' | null>(null);
  useEffect(() => {
    if (!wanted || loaded) return;
    let live = true;
    import('./plan-lasting').then(
      (m) => live && setLoaded(m),
      () => live && setLoaded('failed')
    );
    return () => {
      live = false;
    };
  }, [wanted, loaded]);
  const run = useMemo(() => (loaded && loaded !== 'failed' ? loaded.createLastingFigures(store) : null), [loaded, store]);
  if (!wanted) return null;
  if (loaded === 'failed') return { figures: args.flat, working: false, failed: true, lasting: null };
  if (!run || args.held) return { figures: args.flat, working: true, failed: false, lasting: null };
  return run('home', args.plan, args.measured, args.count, args.input, args.flat);
}
