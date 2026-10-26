'use client';

// The Plan's scenarios on the Plan tab (lib/fire/scenarios.ts): the
// Scenarios sheet, opened from the Plan's bar or the open scenario's card,
// which lists them, makes, renames, duplicates and deletes them (each a
// second level of the sheet), opens one, and compares two to four plans side
// by side (components/PlanCompare.tsx); and the open scenario's card, under
// the bar on every segment, which says that what is shown and saved is the
// scenario's, lists what it changes, each with "Use your plan's", and says
// why it isn't worked out when it can't be.
//
// Nothing here saves the Plan. A scenario's figures are worked out on the
// page (lib/fire/plan-figures.ts) and its simulation in the Plan tab's
// worker, one job per plan, with the Plan's method and seed; answers are kept
// for the visit only (rememberResult), never stored.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import PlanCompare from './PlanCompare';
import type { CompareColumn, ColumnOutcome } from './plan-compare';
import type { ScenarioClient, ScenarioEntry, ScenariosState } from './plan-scenarios';
import { currencyText, eventCountsText, eventText, EVENT_PART_TEXT, laterText, resolveErrorText, retirementText, shortText, changeText, SETTING_NAMES } from './plan-scenario-text';
import {
  NO_CHANGES,
  SCENARIO_NAME_MAX,
  MAX_PLAN_SCENARIOS,
  changesOf,
  nameTaken,
  otherCurrency,
  removeAdded,
  resolveScenario,
  restoreItem,
  scenarioChanges,
  unsetChange,
  type ScenarioChange,
  type ScenarioChanges,
} from '@/lib/fire/scenarios';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import type { FirePlan, Measured } from '@/lib/fire/plan';
import type { Method, SimPlan, SimResult } from '@/lib/fire/simulate';
import type { PlanJob, PlanJobResult } from '@/lib/fire/jobs';

export { ScenarioTag } from './ScenarioTag';

type Run = (job: PlanJob, signal?: AbortSignal) => Promise<PlanJobResult>;

/** Answers kept for the visit, by job, the last few: the Plan's answer, a
 *  scenario resolving to the same engine plan, and a column shown again all
 *  reuse one. */
export function rememberResult(cache: Map<string, SimResult>, key: string, result: SimResult, keep = 12): void {
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > keep) cache.delete(cache.keys().next().value as string);
}

/** The key a simulation's answer is kept by: the one the Plan tab uses. */
export const jobKey = (method: Method, sim: SimPlan) => JSON.stringify([method, sim]);

/** The jobs compare mode asks for: one per plan that can be simulated, each
 *  with the Plan's method and no options of its own, so every plan gets the
 *  engine's one seed, run count and block length, on the worker's one
 *  market. */
export function compareJobs(outcomes: readonly ({ kind: 'not-run' } | { kind: 'figures'; figures: PlanFigures })[], method: Method): { key: string; job: PlanJob & { kind: 'simulate' } }[] {
  return outcomes.flatMap((o) => (o.kind === 'figures' && 'sim' in o.figures.engine ? [{ key: jobKey(method, o.figures.engine.sim), job: { kind: 'simulate' as const, method, plan: o.figures.engine.sim } }] : []));
}

type Answer = SimResult | 'pending' | { error: string };

/** Each wanted plan's answer, run in the tab's worker one at a time, those
 *  not wanted any more dropped from its queue. */
function useAnswers(wanted: { key: string; job: PlanJob }[], run: Run, cache: Map<string, SimResult>): { answers: Map<string, Answer>; retry: () => void } {
  const [, setTick] = useState(0);
  const failed = useRef(new Map<string, string>());
  const [attempt, setAttempt] = useState(0);
  const wantedRef = useRef(wanted);
  wantedRef.current = wanted;
  const joined = wanted.map((w) => w.key).join('\n');
  useEffect(() => {
    let live = true;
    const stop = new AbortController();
    for (const w of wantedRef.current) {
      if (cache.has(w.key) || failed.current.has(w.key)) continue;
      void run(w.job, stop.signal).then((r) => {
        if (!live) return;
        if (r.ok && r.kind === 'simulate') rememberResult(cache, w.key, r.result);
        else if (!r.ok && r.error !== 'cancelled') failed.current.set(w.key, r.error);
        setTick((n) => n + 1);
      });
    }
    return () => {
      live = false;
      stop.abort();
    };
    // joined stands for the wanted jobs (their key holds the method); attempt
    // for a retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, attempt]);
  const answers = new Map<string, Answer>();
  for (const w of wanted) {
    const hit = cache.get(w.key);
    const err = failed.current.get(w.key);
    answers.set(w.key, hit ?? (err !== undefined ? { error: err } : 'pending'));
  }
  return {
    answers,
    retry: () => {
      failed.current.clear();
      setAttempt((n) => n + 1);
    },
  };
}

/** What compare mode has for a scenario before its simulation: why it isn't
 *  worked out, or its figures. */
export function scenarioOutcome(
  base: FirePlan,
  s: ScenarioEntry,
  measured: Measured,
  planCurrency: string | null,
  /** Whether the Plan's currency is known (lib/fire/plan-currency.ts). */
  known = true
): { kind: 'not-run'; reason: string } | { kind: 'figures'; figures: PlanFigures } {
  const other = otherCurrency(s, planCurrency);
  if (other && planCurrency) return { kind: 'not-run', reason: currencyText(other, planCurrency, known) };
  const r = resolveScenario(base, s);
  if (!r.ok) return { kind: 'not-run', reason: resolveErrorText(r.field, r.error, base, s) };
  const f = planFigures(r.plan, measured, s.events);
  if ('refused' in f) return { kind: 'not-run', reason: REFUSED_TEXT };
  return { kind: 'figures', figures: f };
}

export const REFUSED_TEXT = 'Its lasting changes in spending take your spending in retirement below zero, so it isn’t worked out: change them, or remove one.';

/** What a plan is, in compare mode: its changes, its life events and where
 *  they count, and what its figures leave out. */
export function PlanDetails({ entry, base, outcome, money }: { entry: ScenarioEntry | null; base: FirePlan; outcome: ColumnOutcome; money: (n: number) => string }) {
  const lines: ReactNode[] = [];
  if (!entry) lines.push(<li key="plan">Your plan as it is.</li>);
  else {
    const changes = scenarioChanges(base, entry);
    if (changes.length === 0 && entry.events.length === 0) lines.push(<li key="none">No changes yet: it is your plan as it is.</li>);
    for (const [i, c] of changes.entries()) {
      lines.push(
        <li key={`c${i}`}>
          <Masked>{changeText(c, base, entry, money)}</Masked>
        </li>
      );
    }
    const notes = outcome.kind === 'figures' ? (outcome.figures.events?.notes ?? []) : [];
    for (const e of entry.events) {
      lines.push(
        <li key={e.id}>
          {e.label}: <Masked>{eventText(e, money)}</Masked> {eventCountsText(e)}{' '}
          {notes
            .filter((n) => n.id === e.id)
            .map((n) => EVENT_PART_TEXT[n.part])
            .join(' ')}
        </li>
      );
    }
  }
  if (outcome.kind === 'not-run') {
    lines.push(
      <li key="why" className="plan-warning">
        {outcome.reason}
      </li>
    );
  } else {
    const f = outcome.figures;
    if (f.retirement && f.view.spending.value !== null) {
      lines.push(
        <li key="ret">
          <Masked>{`FI number from ${retirementText(f.retirement.spending, f.retirement.lasting, f.view.spending.value, money)}.`}</Masked>
        </li>
      );
    }
    const later = laterText((f.events?.later ?? []).map((l) => ({ amount: l.amount, fromAge: l.fromAge })), money);
    if (later) {
      lines.push(
        <li key="later">
          <Masked>{later}</Masked>
        </li>
      );
    }
    if (f.short) {
      lines.push(
        <li key="short" className="plan-warning">
          <Masked>{shortText(f.short, f.plan.age, money)}</Masked>
        </li>
      );
    }
  }
  return <ul className="plan-assumptions">{lines}</ul>;
}

/** The sheet's second level: what one of the list's buttons opened. */
type Level =
  | { kind: 'new' }
  | { kind: 'rename'; entry: ScenarioEntry }
  | { kind: 'duplicate'; entry: ScenarioEntry }
  | { kind: 'delete'; entry: ScenarioEntry }
  | { kind: 'delete-unreadable'; id: string };

/** The list's button that opened a level, which focus goes back to. */
const openerOf = (l: Level): string => (l.kind === 'new' ? 'new' : l.kind === 'delete-unreadable' ? `unreadable:${l.id}` : `${l.kind}:${l.entry.id}`);

/** The Scenarios sheet. It stays mounted while closed (only the sheet's body
 *  goes), so the plans picked for Compare last for the visit. */
export function ScenariosSheet({
  open,
  onClose,
  state,
  client,
  base,
  baseFigures,
  measured,
  planCurrency,
  planCurrencyKnown = true,
  canOpen,
  planState,
  whyNot,
  openId,
  onOpen,
  onLeave,
  run,
  cache,
  method,
  money,
  today,
}: {
  open: boolean;
  onClose: () => void;
  state: ScenariosState;
  client: ScenarioClient;
  /** The Plan as the tab shows it. */
  base: FirePlan;
  baseFigures: PlanFigures;
  measured: Measured;
  planCurrency: string | null;
  /** Whether the Plan's currency is known (lib/fire/plan-currency.ts). */
  planCurrencyKnown?: boolean;
  /** The Plan has loaded and waits on no repair. */
  canOpen: boolean;
  /** How the saved Plan's load went: until it has loaded, nothing is
   *  compared, since a scenario is its changes to the Plan, and figures over
   *  the defaults would be about a plan nobody made. While it loads, the
   *  list is only why, and a spinner. */
  planState: 'loading' | 'ready' | 'error';
  /** Why scenarios can't be opened or changed now, when they can't. */
  whyNot: string | null;
  openId: string | null;
  /** A scenario opened from its row or made here, or null when the open one
   *  is deleted. */
  onOpen: (id: string | null) => void;
  /** The open scenario's row's "Back to your plan". */
  onLeave: () => void;
  run: Run;
  cache: Map<string, SimResult>;
  method: Method;
  money: (n: number) => string;
  today: string;
}) {
  // Null: the list.
  const [level, setLevel] = useState<Level | null>(null);
  const [opened, setOpened] = useState(0);
  const [error, setError] = useState('');
  const go = (l: Level) => {
    setOpened((n) => n + 1);
    setLevel(l);
    setError('');
  };
  // Opened again: the list, not a level left behind, from its first frame.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setLevel(null);
  }
  // Back at the list, focus goes to the first of the buttons given here that
  // can take it, or stays on the sheet's panel, where the sheet's own effect
  // (a child's, so it runs first) put it.
  const listButtons = useRef(new Map<string, HTMLButtonElement | null>());
  const keep = (key: string) => (el: HTMLButtonElement | null) => {
    listButtons.current.set(key, el);
  };
  const returnTo = useRef<string[] | null>(null);
  const toList = (focus: string[]) => {
    returnTo.current = focus;
    setLevel(null);
  };
  useEffect(() => {
    if (!returnTo.current || (open && level)) return;
    // Only into an open sheet: a save that ends as it slides out leaves focus
    // where the sheet gave it back.
    if (open) {
      const to = returnTo.current.map((key) => listButtons.current.get(key)).find((b) => b && !b.disabled);
      to?.focus({ preventScroll: true });
    }
    returnTo.current = null;
  }, [level, open]);
  const back = () => {
    if (level) toList([openerOf(level)]);
  };
  const list = state.list;
  /** Where focus goes once a row is deleted: the next scenario's Open, else
   *  the one before's, else that neighbour's Delete (while none can be
   *  opened), else New scenario. After an unreadable one, the next unreadable
   *  one's Delete it, else the row before it (another unreadable one's, or the
   *  last scenario's Open or Delete), else New scenario. */
  const afterDelete = (gone: string): string[] => {
    const rows = [...list.map((s) => `open:${s.id}`), ...(gone.startsWith('unreadable:') ? state.unreadable.map((id) => `unreadable:${id}`) : [])];
    const at = rows.indexOf(gone);
    if (at < 0) return ['new'];
    const near = rows[at + 1] ?? rows[at - 1];
    return [rows[at + 1], rows[at - 1], near?.startsWith('open:') ? `delete:${near.slice(5)}` : undefined, 'new'].filter((k): k is string => !!k);
  };
  const ready = state.status === 'ready';
  const busy = state.saving;
  const changeable = ready && canOpen && !busy;

  // Which plans are compared: the Plan and the first three scenarios, until
  // the person chooses; two to four at once.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const ids = ['plan', ...list.map((s) => s.id)];
  const picked = (chosen ?? ids.slice(0, 4)).filter((id) => ids.includes(id));
  const selected = picked.length >= 2 ? picked : ids.slice(0, Math.min(4, ids.length));
  const toggle = (id: string) => {
    const now = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    setChosen(ids.filter((x) => now.includes(x)));
  };

  const columns = useMemo(() => {
    return ids
      .filter((id) => selected.includes(id))
      .map((id): { column: Omit<CompareColumn, 'outcome'>; entry: ScenarioEntry | null; before: ReturnType<typeof scenarioOutcome> } => {
        if (id === 'plan') return { column: { id, name: 'Your plan', isPlan: true }, entry: null, before: { kind: 'figures', figures: baseFigures } };
        const entry = list.find((s) => s.id === id) as ScenarioEntry;
        return { column: { id, name: entry.name, isPlan: false }, entry, before: scenarioOutcome(base, entry, measured, planCurrency, planCurrencyKnown) };
      });
    // ids and selected are derived from list and chosen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, chosen, base, baseFigures, measured, planCurrency, planCurrencyKnown]);
  const wanted = compareJobs(
    columns.map((c) => c.before),
    method
  );
  // Nothing is compared until the Plan has loaded (planState).
  const { answers, retry } = useAnswers(planState === 'ready' && list.length > 0 ? wanted : [], run, cache);
  const compared: CompareColumn[] = columns.map(({ column, before }) => {
    if (before.kind === 'not-run') return { ...column, outcome: before };
    const f = before.figures;
    if (!('sim' in f.engine)) return { ...column, outcome: { kind: 'figures', figures: f, result: { missing: f.engine.missing } } };
    return { ...column, outcome: { kind: 'figures', figures: f, result: answers.get(jobKey(method, f.engine.sim)) ?? 'pending' } };
  });
  const failed = compared.some((c) => c.outcome.kind === 'figures' && typeof c.outcome.result === 'object' && 'error' in c.outcome.result);

  const create = async (name: string) => {
    const r = await client.create({ name, currency: planCurrency, ...NO_CHANGES });
    if ('error' in r) return r.error;
    // In one commit, so the sheet's focus going back loses to the Plan's
    // heading, which takes it as the scenario opens.
    onClose();
    onOpen(r.ok.id);
    return true;
  };

  const listBody =
    planState === 'loading' ? (
      // Until the Plan has loaded, no row and no summary over the defaults.
      <>
        {whyNot && <p className="panel-note">{whyNot}</p>}
        <div className="spinner" role="status" aria-label="Loading your plan" />
      </>
    ) : (
      <>
        <button className="btn secondary" ref={keep('new')} onClick={() => go({ kind: 'new' })} disabled={!changeable || list.length >= MAX_PLAN_SCENARIOS}>
          New scenario
        </button>
        <p className="panel-note">
          What-ifs beside your plan. Each keeps only what it changes (a retirement age, a spending figure, a life event) and follows your plan for the rest, so a change
          to your plan reaches every scenario.
        </p>
        {whyNot && <p className="panel-note">{whyNot}</p>}
        {state.status === 'loading' && <div className="spinner" role="status" aria-label="Loading your scenarios" />}
        {state.status === 'error' && (
          <>
            <div className="error">{state.error}</div>
            <button className="secondary" style={{ marginTop: 8 }} onClick={() => void client.load()}>
              Try again
            </button>
          </>
        )}
        {ready && list.length === 0 && state.unreadable.length === 0 && state.unrecognised.length === 0 && (
          <p className="empty-note">No scenarios yet. Make one to try retiring earlier, spending more, or a life event, without changing your plan.</p>
        )}
        {ready && list.length > 0 && (
          <div className="plan-rows">
            {list.map((s) => {
              const changes = scenarioChanges(base, s);
              const first = changes[0] ? changeText(changes[0], base, s, money) : null;
              const more = changes.length - 1 + s.events.length;
              const summary = first
                ? `${first}${more > 0 ? `, and ${more} more` : ''}`
                : s.events.length > 0
                  ? `${s.events.length} life event${s.events.length === 1 ? '' : 's'}`
                  : 'No changes yet';
              return (
                <div key={s.id} className="plan-row">
                  <div className="plan-row-main">
                    <span className="plan-row-label">{s.name}</span>
                    <button
                      className="plan-edit"
                      ref={keep(`open:${s.id}`)}
                      onClick={() => {
                        // In one commit with what it opens or leaves, as create's.
                        onClose();
                        if (openId === s.id) onLeave();
                        else onOpen(s.id);
                      }}
                      disabled={!canOpen || busy}
                      aria-label={openId === s.id ? 'Back to your plan' : `Open ${s.name}`}
                    >
                      {openId === s.id ? 'Back to your plan' : 'Open'}
                    </button>
                  </div>
                  <div className="plan-row-note">
                    <span>
                      <Masked>{summary}</Masked>
                    </span>
                  </div>
                  <div className="plan-scenario-actions">
                    <button className="plan-edit" ref={keep(`rename:${s.id}`)} onClick={() => go({ kind: 'rename', entry: s })} disabled={!changeable} aria-label={`Rename ${s.name}`}>
                      Rename
                    </button>
                    <button
                      className="plan-edit"
                      ref={keep(`duplicate:${s.id}`)}
                      onClick={() => go({ kind: 'duplicate', entry: s })}
                      disabled={!changeable || list.length >= MAX_PLAN_SCENARIOS}
                      aria-label={`Duplicate ${s.name}`}
                    >
                      Duplicate
                    </button>
                    <button className="plan-edit" ref={keep(`delete:${s.id}`)} onClick={() => go({ kind: 'delete', entry: s })} disabled={!ready || busy} aria-label={`Delete ${s.name}`}>
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {ready && list.length >= MAX_PLAN_SCENARIOS && <p className="panel-note">You have {MAX_PLAN_SCENARIOS} scenarios, the most Nya keeps: delete one to make another.</p>}
        {state.unreadable.map((id) => (
          <div key={id} className="plan-row">
            <div className="error" style={{ marginTop: 0 }}>
              A saved scenario couldn’t be read: its stored data is damaged.
            </div>
            <button className="secondary" style={{ marginTop: 8 }} ref={keep(`unreadable:${id}`)} onClick={() => go({ kind: 'delete-unreadable', id })} disabled={busy}>
              Delete it
            </button>
          </div>
        ))}
        {state.unrecognised.length > 0 && (
          <p className="panel-note">
            {state.unrecognised.length === 1 ? 'A scenario was' : `${state.unrecognised.length} scenarios were`} saved by a newer version of Nya: kept, and not shown here.
          </p>
        )}

        {ready && list.length > 0 && planState === 'ready' && (
          <>
            <div className="plan-subhead">Compare</div>
            <p className="panel-note">Choose two to four plans.</p>
            <div className="chart-ranges plan-choice plan-compare-pick" role="group" aria-label="Plans to compare">
              {ids.map((id) => {
                const on = selected.includes(id);
                const name = id === 'plan' ? 'Your plan' : (list.find((s) => s.id === id)?.name ?? '');
                return (
                  <button key={id} type="button" className="chart-range" aria-pressed={on} disabled={on ? selected.length <= 2 : selected.length >= 4} onClick={() => toggle(id)}>
                    {name}
                  </button>
                );
              })}
            </div>
            <PlanCompare
              columns={compared}
              method={method}
              money={money}
              today={today}
              details={Object.fromEntries(columns.map((c, i) => [c.column.id, <PlanDetails key={c.column.id} entry={c.entry} base={base} outcome={compared[i].outcome} money={money} />]))}
            />
            {failed && (
              <button className="secondary" style={{ marginTop: 12 }} onClick={retry}>
                Try again
              </button>
            )}
          </>
        )}
      </>
    );

  return (
    <Sheet
      open={open}
      title={level ? (level.kind === 'new' ? 'New scenario' : level.kind === 'rename' ? 'Rename' : level.kind === 'duplicate' ? 'Duplicate' : 'Delete') : 'Scenarios'}
      onClose={onClose}
      onBack={level ? back : undefined}
      level={level ? level.kind : 'list'}
    >
      {!level && listBody}
      {level?.kind === 'new' && (
        <NameForm key={opened} initial="" others={list} exceptId={null} busy={busy} onCancel={back} onSave={create} intro="A scenario starts as your plan: open it, and every change you make there is saved to it, never to your plan." />
      )}
      {level?.kind === 'rename' && (
        <NameForm
          key={opened}
          initial={level.entry.name}
          others={list}
          exceptId={level.entry.id}
          busy={busy}
          onCancel={back}
          onSave={async (name) => {
            const e = level.entry;
            const r = await client.save(e.id, { ...changesOf(e), name, currency: e.currency }, e.rev);
            if ('error' in r) return r.error;
            toList([openerOf(level)]);
            return true;
          }}
        />
      )}
      {level?.kind === 'duplicate' && (
        <NameForm
          key={opened}
          initial={`${level.entry.name} (copy)`.slice(0, SCENARIO_NAME_MAX)}
          others={list}
          exceptId={null}
          busy={busy}
          onCancel={back}
          intro="A copy of every change and life event, under a new name."
          onSave={async (name) => {
            const e = level.entry;
            const r = await client.create({ ...changesOf(e), name, currency: e.currency });
            if ('error' in r) return r.error;
            // The tenth can't be copied again: then its row's Rename.
            toList([openerOf(level), `rename:${e.id}`]);
            return true;
          }}
        />
      )}
      {(level?.kind === 'delete' || level?.kind === 'delete-unreadable') && (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            {level.kind === 'delete'
              ? `Delete the scenario “${level.entry.name}”? Your plan isn’t changed. This can’t be undone.`
              : 'Delete the scenario that couldn’t be read? What it held can’t be recovered from here, and this can’t be undone.'}
          </p>
          {error && <div className="error">{error}</div>}
          <div className="button-pair" style={{ marginTop: 16 }}>
            <button className="secondary" onClick={back} disabled={busy}>
              Cancel
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                const id = level.kind === 'delete' ? level.entry.id : level.id;
                const r = await client.remove(id, level.kind === 'delete-unreadable');
                if ('error' in r) {
                  setError(r.error);
                  return;
                }
                if (openId === id) onOpen(null);
                toList(afterDelete(level.kind === 'delete' ? `open:${id}` : `unreadable:${id}`));
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function NameForm({
  initial,
  others,
  exceptId,
  busy,
  intro,
  onSave,
  onCancel,
}: {
  initial: string;
  others: ScenarioEntry[];
  exceptId: string | null;
  busy: boolean;
  intro?: string;
  onSave: (name: string) => Promise<true | string>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  return (
    <>
      {intro && (
        <p className="panel-note" style={{ marginTop: 0 }}>
          {intro}
        </p>
      )}
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={SCENARIO_NAME_MAX} disabled={busy} placeholder="Retire at 50" />
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          disabled={busy}
          onClick={async () => {
            const n = name.trim();
            if (!n) return setError('Give it a name.');
            if (nameTaken(others, n, exceptId)) return setError('Another scenario has that name: choose another, so they can be told apart.');
            const r = await onSave(n);
            if (r !== true) setError(r);
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}

/** Which of the Plan's forms changes a field, for "Change it" when an open
 *  scenario breaks a rule. Null: no one form; the changes below fix it. */
export type FixForm = 'about' | 'assumptions' | 'simulation' | 'spending' | 'savings' | 'assets' | null;
export function formFor(field: string): FixForm {
  if (field === 'targetAge' || field === 'age') return 'about';
  if (['withdrawalRate', 'realReturn', 'taxRate', 'partTimeIncome'].includes(field)) return 'assumptions';
  if (field === 'spending' || field === 'savings' || field === 'assets') return field;
  if (field === 'income' || field === 'expenses' || field.startsWith('income[') || field.startsWith('expenses[') || field === 'plan') return null;
  return 'simulation';
}

/** The open scenario's card, under the Plan's bar on every segment. It has
 *  no heading of its own: the bar's names the scenario. */
export function ScenarioCard({
  entry,
  base,
  problem,
  other,
  planCurrency,
  planCurrencyKnown = true,
  confirmWhyNot,
  editable,
  money,
  eventsCount,
  eventsWhere,
  onSave,
  onConfirmCurrency,
  onFix,
  notice = null,
  scenariosCount,
  onScenarios,
}: {
  entry: ScenarioEntry;
  base: FirePlan;
  /** Why it isn't worked out with the Plan as it is (a rule it breaks, or
   *  lasting changes below zero), and the field at fault. */
  problem: { text: string; field: string | null } | null;
  /** The currency its amounts were typed in, when it isn't the Plan's now. */
  other: string | null;
  planCurrency: string | null;
  /** Whether the Plan's currency is known (lib/fire/plan-currency.ts). */
  planCurrencyKnown?: boolean;
  /** Why "They're in" isn't offered now (accounts still loading, or with a
   *  problem), or null. */
  confirmWhyNot: string | null;
  editable: boolean;
  money: (n: number) => string;
  eventsCount: number;
  /** Where its Life events card is: on Your path (worked out), just below
   *  this card (refused for lasting changes below zero), or nowhere. */
  eventsWhere: 'path' | 'below' | null;
  /** null: not saved, and `notice` says why (so the card doesn't say it twice). */
  onSave: (changes: ScenarioChanges) => Promise<boolean | string | null>;
  onConfirmCurrency: () => Promise<boolean | string | null>;
  onFix: (form: Exclude<FixForm, null>) => void;
  /** What a save said that has no form left to say it in. */
  notice?: string | null;
  /** How many scenarios are listed, once they have loaded, for its
   *  Scenarios button. */
  scenariosCount: number | null;
  /** Opens the Scenarios sheet, to open another, or compare. */
  onScenarios: () => void;
}) {
  const [error, setError] = useState('');
  const changes = scenarioChanges(base, entry);
  const act = async (next: { ok: ScenarioChanges } | { error: string }) => {
    if ('error' in next) return setError(next.error);
    const r = await onSave(next.ok);
    setError(r === true || r === null ? '' : typeof r === 'string' ? r : 'It wasn’t saved. Try again in a moment.');
  };
  const undo = (c: ScenarioChange) => {
    switch (c.kind) {
      case 'set':
        // Back to the plan's start: a balance typed for this one goes too.
        return act({ ok: c.field === 'start' && entry.set.start === 'custom' ? unsetChange(unsetChange(entry, 'start'), 'startBalance') : unsetChange(entry, c.field) });
      case 'left-out':
      case 'replaced':
        return act(restoreItem(base, entry, c.list, c.item.id));
      case 'moot':
        return act(restoreItem(base, entry, c.list, c.id));
      case 'added':
      case 'orphan':
        return act({ ok: removeAdded(base, entry, c.list, c.item.id) });
    }
  };
  const fixWith = problem?.field ? formFor(problem.field) : null;
  return (
    <div className="card plan-scenario-card">
      <p className="panel-note">
        Everything below is this scenario, and changes you make here are saved to it, never to your plan. Your age, how your figures are measured, the method and
        the allocation settings are your plan’s, the same in every scenario. Leaving the Plan tab, or reloading, brings back your plan.
      </p>
      {other && planCurrency && (
        <>
          <div className="error">{currencyText(other, planCurrency, planCurrencyKnown)}</div>
          {confirmWhyNot ? (
            <p className="panel-note">{confirmWhyNot}</p>
          ) : (
            <button
              className="secondary"
              style={{ marginTop: 8 }}
              disabled={!editable}
              onClick={async () => {
                const r = await onConfirmCurrency();
                setError(r === true || r === null ? '' : typeof r === 'string' ? r : 'It wasn’t saved. Try again in a moment.');
              }}
            >
              They’re in {planCurrency}
            </button>
          )}
        </>
      )}
      {notice && (
        <div className="error" role="alert">
          {notice}
        </div>
      )}
      {problem && (
        <>
          <div className="error">
            {problem.text}
          </div>
          {fixWith && (
            <button className="secondary" style={{ marginTop: 8 }} onClick={() => onFix(fixWith)} disabled={!editable}>
              Change it
            </button>
          )}
        </>
      )}
      <div className="plan-subhead">What it changes</div>
      {changes.length === 0 && eventsCount === 0 ? (
        <p className="empty-note">Nothing yet: it is your plan as it is. Change anything below, or add a life event, and it is saved here.</p>
      ) : (
        <div className="plan-rows">
          {changes.map((c, i) => {
            // A typed balance goes with starting from one: it follows the
            // plan's only once the start does.
            const tied = c.kind === 'set' && c.field === 'startBalance' && entry.set.start === 'custom';
            const remove = c.kind === 'added' || c.kind === 'orphan' || c.kind === 'moot';
            const what = c.kind === 'set' ? SETTING_NAMES[c.field].toLowerCase() : c.kind === 'moot' ? 'an item your plan no longer has' : `“${c.item.label}”`;
            return (
              <div key={i} className="plan-row">
                <div className="plan-row-note">
                  <span>
                    <Masked>{changeText(c, base, entry, money)}</Masked>
                    {tied && <span className="plan-muted"> Kept while this scenario starts from a balance you typed.</span>}
                  </span>
                  {!tied && (
                    <button className="plan-edit" onClick={() => void undo(c)} disabled={!editable} aria-label={remove ? `Remove ${what}` : `Use your plan’s ${what}`}>
                      {remove ? 'Remove' : 'Use your plan’s'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {eventsCount > 0 && (
            <div className="plan-row">
              <div className="plan-row-note">
                <span>
                  {eventsCount} life event{eventsCount === 1 ? '' : 's'}
                  {eventsWhere === 'path' ? ', on Your path.' : eventsWhere === 'below' ? ', below.' : '.'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <button className="btn secondary" aria-haspopup="dialog" onClick={onScenarios}>
        {scenariosCount !== null && scenariosCount > 0 ? `Scenarios (${scenariosCount})` : 'Scenarios'}
      </button>
    </div>
  );
}
