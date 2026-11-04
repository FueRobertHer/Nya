'use client';

// Your plans on the Plan tab (the tax plan's C2): the Plans sheet, opened
// from the Plan's bar or the open copy's card, and the open copy's card.
//
// THE SHEET lists every plan, yours first with its badge, then the copies in
// the order they were made, each with when it reaches FI and how it differs
// from yours (components/plan-diff.ts). A row opens that plan's level: Open
// it, Make this your plan, Rename, Duplicate, and Delete (last, asking
// first). New copy makes a copy of your plan and opens it; Compare sets two
// to four plans side by side (components/PlanCompare.tsx). Your plan can't
// be deleted: another is made yours first.
//
// THE CARD (CopyCard) is under the bar on every segment while a copy is
// open: how it differs from your plan, why it isn't worked out when it
// isn't (its amounts in another currency, lasting changes below zero),
// what a save said with no form left to say it in, and Make this your plan
// and Plans.
//
// Nothing here saves: every write is the tab's (components/PlanTab.tsx,
// through components/plan-list.ts), handed in. A plan's figures are worked
// out on the page (lib/fire/plan-figures.ts) and its simulation in the Plan
// tab's worker, one job per plan, with your plan's method and seed; answers
// are kept for the visit only (rememberResult), never stored.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import ActionRows from './ActionRows';
import PlanCompare from './PlanCompare';
import { chevron, RIGHT } from './ActivityBar';
import type { CompareColumn, ColumnOutcome } from './plan-compare';
import { plansCount as countOf, type PlansState } from './plan-list';
import { copyDiffParts, diffText, rowText } from './plan-diff';
import { fiWhen } from './plan-what-if';
import { plansText } from './PlanBar';
import { EVENT_PART_TEXT, laterText, retirementText, shortText } from './plan-scenario-text';
import { PlanRowsSkeleton } from './LoadingSkeletons';
import { Notice } from './TotalCaveats';
import { MAX_FIRE_PLANS } from '@/lib/fire/copies';
import { SCENARIO_NAME_MAX, nameTaken } from '@/lib/fire/scenarios';
import { asEvent } from '@/lib/fire/items';
import type { PlanFigures } from '@/lib/fire/plan-figures';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import type { Method, SimPlan, SimResult } from '@/lib/fire/simulate';
import type { PlanJob, PlanJobResult } from '@/lib/fire/jobs';

type Run = (job: PlanJob, signal?: AbortSignal) => Promise<PlanJobResult>;

/** Answers kept for the visit, by job, the last few: your plan's answer, a
 *  copy running the same engine plan, and a column shown again all reuse
 *  one. */
export function rememberResult(cache: Map<string, SimResult>, key: string, result: SimResult, keep = 12): void {
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > keep) cache.delete(cache.keys().next().value as string);
}

/** The key a simulation's answer is kept by: the one the Plan tab uses. */
export const jobKey = (method: Method, sim: SimPlan) => JSON.stringify([method, sim]);

/** What a plan has before its simulation: why it isn't worked out, or its
 *  figures. */
export type PlanOutcome = { kind: 'not-run'; reason: string } | { kind: 'figures'; figures: PlanFigures };

/** The jobs compare mode asks for: one per plan that can be simulated, each
 *  with your plan's method and no options of its own, so every plan gets
 *  the engine's one seed, run count and block length, on the worker's one
 *  market. */
export function compareJobs(outcomes: readonly PlanOutcome[], method: Method): { key: string; job: PlanJob & { kind: 'simulate' } }[] {
  return outcomes.flatMap((o) => (o.kind === 'figures' && 'sim' in o.figures.engine ? [{ key: jobKey(method, o.figures.engine.sim), job: { kind: 'simulate' as const, method, plan: o.figures.engine.sim } }] : []));
}

/** Said for a copy whose lasting changes take spending in retirement below
 *  zero. */
export const REFUSED_TEXT = 'Its lasting changes in spending take your spending in retirement below zero, so it isn’t worked out: change them, or remove one.';

/** One plan as the sheet shows it. */
export type SheetPlan = {
  id: string;
  name: string;
  isMain: boolean;
  /** Its stamp, which a write names; null for your plan before it is saved. */
  updatedAt: string | null;
  /** The plan as it runs, the facts every plan shares in its fields. */
  plan: FirePlanV2;
  outcome: PlanOutcome;
};

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

/** What a plan is, in compare mode: how it differs from yours (`parts`,
 *  components/plan-diff.ts), and what its figures leave out. */
export function PlanDetails({ plan, parts, outcome, money }: { plan: SheetPlan; parts: readonly string[]; outcome: ColumnOutcome; money: (n: number) => string }) {
  const lines: ReactNode[] = [];
  if (plan.isMain) lines.push(<li key="plan">Your plan as it is.</li>);
  else if (parts.length === 0) lines.push(<li key="none">The same as your plan.</li>);
  for (const [i, p] of parts.entries()) {
    lines.push(
      <li key={`c${i}`}>
        <Masked>{p}</Masked>
      </li>
    );
  }
  if (outcome.kind === 'not-run') {
    lines.push(
      <li key="why" className="plan-warning">
        {outcome.reason}
      </li>
    );
  } else {
    const f = outcome.figures;
    // What of a life event is left out, and why.
    for (const n of f.itemNotes) {
      const item = f.items[n.at];
      if (!item || !asEvent(item)) continue;
      lines.push(
        <li key={`n${n.at}:${n.part}`}>
          {item.label}: {EVENT_PART_TEXT[n.part]}
        </li>
      );
    }
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

/** The sheet's levels past its list. A plan's own (rename, duplicate,
 *  delete) go back to that plan's level. */
type Level =
  | { kind: 'plan'; id: string }
  | { kind: 'new' }
  | { kind: 'rename'; id: string }
  | { kind: 'duplicate'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'delete-unreadable'; id: string }
  | { kind: 'compare' };

const TITLES: Record<Exclude<Level['kind'], 'plan'>, string> = {
  new: 'New copy',
  rename: 'Rename',
  duplicate: 'Duplicate',
  delete: 'Delete',
  'delete-unreadable': 'Delete',
  compare: 'Compare',
};

/** The list's button that opened a level, which focus goes back to. */
const openerOf = (l: Level): string => (l.kind === 'new' || l.kind === 'compare' ? l.kind : l.kind === 'delete-unreadable' ? `unreadable:${l.id}` : `plan:${l.id}`);

/** The Plans sheet. It stays mounted while closed (only the sheet's body
 *  goes), so the plans picked for Compare last for the visit. */
export function PlansSheet({
  open,
  onClose,
  state,
  plans,
  measuring,
  planState,
  whyNot,
  openId,
  onOpen,
  onCreate,
  onRename,
  onDelete,
  onMakeMain,
  onRetry,
  run,
  cache,
  method,
  money,
  today,
}: {
  open: boolean;
  onClose: () => void;
  state: PlansState;
  /** Every plan that reads, yours first: empty until your plan and the list
   *  have both loaded. */
  plans: SheetPlan[];
  /** What Nya measures is still loading: each row's FI age waits. */
  measuring: boolean;
  /** How your plan's load went: until it has loaded nothing is compared or
   *  said, since figures over the defaults would be about a plan nobody
   *  made. */
  planState: 'loading' | 'ready' | 'error';
  /** Why plans can't be opened or changed now, when they can't. */
  whyNot: string | null;
  /** The copy open, if any. */
  openId: string | null;
  /** Opens a copy, or your plan (null). */
  onOpen: (id: string | null) => void;
  /** Makes a copy of `from` named `name`; once made, with `open` (New
   *  copy), closes this sheet and opens it, in one commit. */
  onCreate: (from: string, name: string, open: boolean) => Promise<true | string>;
  onRename: (id: string, name: string) => Promise<true | string>;
  onDelete: (id: string, unreadable: boolean) => Promise<true | string>;
  onMakeMain: (id: string) => Promise<true | string>;
  /** Loads the list again, after it failed. */
  onRetry: () => void;
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
  const [said, setSaid] = useState('');
  const go = (l: Level) => {
    setOpened((n) => n + 1);
    setLevel(l);
    setError('');
  };
  // Opened again: the list, not a level left behind, from its first frame.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setLevel(null);
      setSaid('');
    }
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
  // The rows are placeholders while your plan is read again (after Make
  // this your plan): focus waits for them.
  const rowsLoading = planState === 'loading' || (state.status === 'loading' && plans.length === 0);
  useEffect(() => {
    if (!returnTo.current || (open && level)) return;
    // Only into an open sheet: a write that ends as it slides out leaves
    // focus where the sheet gave it back.
    if (open) {
      const to = returnTo.current.map((key) => listButtons.current.get(key)).find((b) => b && !b.disabled);
      if (!to && rowsLoading) return;
      to?.focus({ preventScroll: true });
    }
    returnTo.current = null;
  }, [level, open, rowsLoading]);
  const back = () => {
    if (!level) return;
    if (level.kind === 'rename' || level.kind === 'duplicate' || level.kind === 'delete') go({ kind: 'plan', id: level.id });
    else toList([openerOf(level)]);
  };

  const ready = state.status === 'ready';
  const busy = state.saving;
  const changeable = ready && whyNot === null && !busy;
  const count = countOf(state);
  const full = count >= MAX_FIRE_PLANS;
  const byId = (id: string) => plans.find((p) => p.id === id) ?? null;
  const names = state.list.map((r) => ({ id: r.id, name: r.name }));
  const main = plans.find((p) => p.isMain) ?? null;
  // How each copy differs from your plan, in words, written here with the
  // sheet's own money, so hidden amounts stay hidden.
  const partsOf = (p: SheetPlan): string[] => (p.isMain || !main ? [] : copyDiffParts(main.plan, p.plan, money));
  const mainWhen = main ? fiWhen(main.outcome.kind === 'figures' ? main.outcome.figures : null) : null;
  /** Where focus goes once a copy is deleted: the next row, else the one
   *  before, else New copy. */
  const afterDelete = (gone: string): string[] => {
    const rows = [...plans.map((p) => `plan:${p.id}`), ...state.unreadable.map((id) => `unreadable:${id}`)];
    const at = rows.indexOf(gone);
    return [rows[at + 1], rows[at - 1], 'new'].filter((k): k is string => !!k && k !== gone);
  };

  // Which plans are compared: the first four, until the person chooses; two
  // to four at once.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const ids = plans.map((p) => p.id);
  const picked = (chosen ?? ids.slice(0, 4)).filter((id) => ids.includes(id));
  const selected = picked.length >= 2 ? picked : ids.slice(0, Math.min(4, ids.length));
  const toggle = (id: string) => {
    const now = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    setChosen(ids.filter((x) => now.includes(x)));
  };
  // Worked out each render, as the plans are (their differences in words
  // follow hide amounts); the jobs are keyed by what they run.
  const columns = plans.filter((p) => selected.includes(p.id)).map((p) => ({ column: { id: p.id, name: p.isMain ? 'Your plan' : p.name, isPlan: p.isMain }, plan: p }));
  const comparing = open && level?.kind === 'compare' && planState === 'ready';
  const { answers, retry } = useAnswers(
    comparing
      ? compareJobs(
          columns.map((c) => c.plan.outcome),
          method
        )
      : [],
    run,
    cache
  );
  const compared: CompareColumn[] = columns.map(({ column, plan }) => {
    if (plan.outcome.kind === 'not-run') return { ...column, outcome: plan.outcome };
    const f = plan.outcome.figures;
    if (!('sim' in f.engine)) return { ...column, outcome: { kind: 'figures', figures: f, result: { missing: f.engine.missing } } };
    return { ...column, outcome: { kind: 'figures', figures: f, result: answers.get(jobKey(method, f.engine.sim)) ?? 'pending' } };
  });
  const failed = compared.some((c) => c.outcome.kind === 'figures' && typeof c.outcome.result === 'object' && 'error' in c.outcome.result);

  const listBody =
    rowsLoading ? (
      // Until your plan and the list have loaded, no row and no FI age over
      // the defaults: the rows as placeholders.
      <>
        {whyNot && <p className="helper">{whyNot}</p>}
        <PlanRowsSkeleton count={ready ? state.list.length : 2} status="Loading your plans" />
      </>
    ) : (
      <div className="stack">
        <p className="helper">Each plan is whole: a copy starts as your plan, and changes you make in it stay in it.</p>
        {whyNot && <p className="helper">{whyNot}</p>}
        {state.status === 'error' && (
          <div className="stack tight">
            <Notice level="critical" role="alert">
              {state.error}
            </Notice>
            <button type="button" className="btn secondary" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
        {plans.length > 0 && (
          <ul className="card list-rows" aria-label="Your plans">
            {plans.map((p) => {
              const when = fiWhen(p.outcome.kind === 'figures' ? p.outcome.figures : null);
              return (
                <li key={p.id}>
                  <button type="button" className="list-row" ref={keep(`plan:${p.id}`)} aria-haspopup="dialog" onClick={() => go({ kind: 'plan', id: p.id })}>
                    <span className="list-row-text">
                      <span className="list-row-title">{p.name}</span>
                      {measuring ? (
                        <span className="skeleton rows-skeleton-sub" />
                      ) : (
                        <span className="list-row-sub">
                          <Masked>{p.isMain ? rowText(when, null, []) : rowText(when, mainWhen ?? { kind: 'none' }, partsOf(p))}</Masked>
                        </span>
                      )}
                    </span>
                    {p.isMain && <span className="badge accent">Your plan</span>}
                    {chevron(RIGHT)}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {ready && state.missing && main && <p className="helper">Your plan wasn’t found, so “{main.name}” is shown as yours.</p>}
        {ready && full && <p className="helper">You have {MAX_FIRE_PLANS} plans, the most Nya keeps: delete one to make another.</p>}
        {state.unreadable.map((id) => (
          <div key={id} className="stack tight">
            <Notice level="critical">A saved plan couldn’t be read: its stored data is damaged.</Notice>
            <button type="button" className="btn secondary" ref={keep(`unreadable:${id}`)} onClick={() => go({ kind: 'delete-unreadable', id })} disabled={busy}>
              Delete it
            </button>
          </div>
        ))}
        {state.unrecognised.length > 0 && (
          <p className="helper">
            {state.unrecognised.length === 1 ? 'A plan was' : `${state.unrecognised.length} plans were`} saved by a newer version of Nya: kept, and not shown here.
          </p>
        )}
        <div className="visually-hidden" role="status">
          {said}
        </div>
      </div>
    );

  const shown = level && level.kind !== 'new' && level.kind !== 'compare' ? byId(level.id) : null;
  const planLevel = level?.kind === 'plan' && shown && (
    <div className="stack">
      {!shown.isMain && (
        <p className="helper">
          <Masked>{diffText(partsOf(shown), Infinity)}</Masked>
        </p>
      )}
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
      <ActionRows
        rows={[
          {
            key: 'open',
            title: 'Open it',
            onSelect: () => {
              if (busy || whyNot !== null) return setError(whyNot ?? 'Still saving the last change. Try again in a moment.');
              // In one commit, so the sheet's focus going back loses to the
              // Plan's heading, which takes it as the plan opens.
              onClose();
              onOpen(shown.isMain ? null : shown.id);
            },
          },
          ...(shown.isMain
            ? []
            : [
                {
                  key: 'main',
                  title: 'Make this your plan',
                  sub: 'Your plan now stays, as a copy.',
                  onSelect: async () => {
                    if (!changeable) return setError(whyNot ?? 'Still saving the last change. Try again in a moment.');
                    const r = await onMakeMain(shown.id);
                    if (r !== true) return setError(r);
                    setSaid(`“${shown.name}” is your plan now.`);
                    toList([`plan:${shown.id}`]);
                  },
                },
              ]),
          { key: 'rename', title: 'Rename', opens: true, onSelect: () => (changeable ? go({ kind: 'rename', id: shown.id }) : setError(whyNot ?? 'Still saving the last change. Try again in a moment.')) },
          {
            key: 'duplicate',
            title: 'Duplicate',
            opens: true,
            onSelect: () => (!changeable ? setError(whyNot ?? 'Still saving the last change. Try again in a moment.') : full ? setError(`You have ${MAX_FIRE_PLANS} plans, the most Nya keeps: delete one to make another.`) : go({ kind: 'duplicate', id: shown.id })),
          },
          ...(shown.isMain ? [] : [{ key: 'delete', title: 'Delete', sub: 'Asks before it deletes', opens: true, neg: true, onSelect: () => (busy ? undefined : go({ kind: 'delete', id: shown.id })) }]),
        ]}
      />
      {shown.isMain && <p className="helper">Your plan can’t be deleted: make another your plan first.</p>}
    </div>
  );

  const deleting = level?.kind === 'delete' || level?.kind === 'delete-unreadable';
  const confirmDelete = async () => {
    if (!level || (level.kind !== 'delete' && level.kind !== 'delete-unreadable')) return;
    const r = await onDelete(level.id, level.kind === 'delete-unreadable');
    if (r !== true) return setError(r);
    toList(afterDelete(level.kind === 'delete' ? `plan:${level.id}` : `unreadable:${level.id}`));
  };

  const compareLevel = level?.kind === 'compare' && (
    <div className="stack">
      <p className="helper" id="plan-compare-note">
        Choose two to four plans.
      </p>
      {/* Chips, since more than one is chosen. One that would leave fewer
          than two or more than four stays focusable and says why (the
          note), rather than dropping out of the tab order. */}
      <div className="chip-row plan-compare-pick" role="group" aria-label="Plans to compare">
        {plans.map((p) => {
          const on = selected.includes(p.id);
          const locked = on ? selected.length <= 2 : selected.length >= 4;
          return (
            <button
              key={p.id}
              type="button"
              className="chip"
              aria-pressed={on}
              aria-disabled={locked || undefined}
              aria-describedby={locked ? 'plan-compare-note' : undefined}
              onClick={locked ? undefined : () => toggle(p.id)}
            >
              {p.isMain ? 'Your plan' : p.name}
            </button>
          );
        })}
      </div>
      <PlanCompare
        columns={compared}
        method={method}
        money={money}
        today={today}
        details={Object.fromEntries(columns.map((c, i) => [c.column.id, <PlanDetails key={c.column.id} plan={c.plan} parts={partsOf(c.plan)} outcome={compared[i].outcome} money={money} />]))}
      />
      {failed && (
        <button type="button" className="btn secondary" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );

  const footer = !level ? (
    <div className="btn-row">
      <button type="button" className="btn secondary" ref={keep('compare')} onClick={() => go({ kind: 'compare' })} disabled={planState !== 'ready' || plans.length < 2}>
        Compare
      </button>
      <button type="button" className="btn" ref={keep('new')} onClick={() => go({ kind: 'new' })} disabled={!changeable || full}>
        New copy
      </button>
    </div>
  ) : deleting ? (
    <div className="btn-row">
      <button type="button" className="btn secondary" onClick={back} disabled={busy}>
        Cancel
      </button>
      <button type="button" className="btn danger" onClick={() => void confirmDelete()} disabled={busy}>
        Delete
      </button>
    </div>
  ) : undefined;

  // A plan's level is titled with its name, as listed.
  const levelName = level?.kind === 'plan' ? (state.list.find((r) => r.id === level.id)?.name ?? '') : '';

  return (
    <Sheet
      open={open}
      title={level ? (level.kind === 'plan' ? levelName : TITLES[level.kind]) : 'Plans'}
      onClose={onClose}
      onBack={level ? back : undefined}
      level={level ? `${level.kind}:${'id' in level ? level.id : ''}` : 'list'}
      footer={footer}
    >
      {!level && listBody}
      {planLevel}
      {level?.kind === 'new' && main && (
        <NameForm
          key={opened}
          initial=""
          names={names}
          exceptId={null}
          busy={busy}
          saveText="Make it"
          onCancel={back}
          intro="A copy starts as your plan. Open it, and every change you make there is saved to it, never to your plan."
          onSave={(name) => onCreate(main.id, name, true)}
        />
      )}
      {level?.kind === 'rename' && shown && (
        <NameForm
          key={opened}
          initial={shown.name}
          names={names}
          exceptId={shown.id}
          busy={busy}
          onCancel={back}
          onSave={async (name) => {
            const r = await onRename(shown.id, name);
            if (r === true) go({ kind: 'plan', id: shown.id });
            return r;
          }}
        />
      )}
      {level?.kind === 'duplicate' && shown && (
        <NameForm
          key={opened}
          initial={`${shown.name} (copy)`.slice(0, SCENARIO_NAME_MAX)}
          names={names}
          exceptId={null}
          busy={busy}
          saveText="Make it"
          onCancel={back}
          intro={`A copy of “${shown.name}” as it is now, under a new name.`}
          onSave={async (name) => {
            const r = await onCreate(shown.id, name, false);
            if (r === true) toList([`plan:${shown.id}`]);
            return r;
          }}
        />
      )}
      {deleting && level && (
        <div className="stack">
          <p className="helper">
            {level.kind === 'delete' && shown
              ? `Delete “${shown.name}”? Your plan isn’t changed. This can’t be undone.`
              : 'Delete the plan that couldn’t be read? What it held can’t be recovered from here, and this can’t be undone.'}
          </p>
          {error && (
            <Notice level="critical" role="alert">
              {error}
            </Notice>
          )}
        </div>
      )}
      {compareLevel}
    </Sheet>
  );
}

function NameForm({
  initial,
  names,
  exceptId,
  busy,
  intro,
  saveText = 'Save',
  onSave,
  onCancel,
}: {
  initial: string;
  names: readonly { id: string; name: string }[];
  exceptId: string | null;
  busy: boolean;
  intro?: string;
  saveText?: string;
  onSave: (name: string) => Promise<true | string>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState('');
  return (
    <div className="stack">
      {intro && <p className="helper">{intro}</p>}
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={SCENARIO_NAME_MAX} disabled={busy} />
        </label>
        <p className="helper">{SCENARIO_NAME_MAX} characters at most.</p>
      </div>
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
      <div className="btn-row">
        <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            const n = name.trim();
            if (!n) return setError('Give it a name.');
            if (nameTaken(names, n, exceptId)) return setError('Another plan has that name: choose another, so they can be told apart.');
            const r = await onSave(n);
            if (r !== true) setError(r);
          }}
        >
          {busy ? 'Saving…' : saveText}
        </button>
      </div>
    </div>
  );
}

/** The open copy's card, under the Plan's bar on every segment. It has no
 *  heading of its own: the bar's names the copy. */
export function CopyCard({
  parts,
  other,
  currencyLine,
  confirmWhyNot,
  planCurrency,
  problem,
  repair,
  notice,
  editable,
  onRelabel,
  onMakeMain,
  plansCount,
  onPlans,
}: {
  /** How it differs from your plan (components/plan-diff.ts). */
  parts: string[];
  /** The currency its amounts were typed in, when it isn't your plan's now. */
  other: string | null;
  /** That said, in words (components/plan-scenario-text.ts currencyText). */
  currencyLine: string | null;
  /** Why "They're in" isn't offered now, or null. */
  confirmWhyNot: string | null;
  planCurrency: string | null;
  /** Why it isn't worked out, other than its currency. */
  problem: string | null;
  /** Values it holds that don't fit your plan as it is now (your age moved
   *  past its stop age, say), in words, and Save it this way; null when
   *  there are none. */
  repair: { text: string; onSave: () => Promise<true | string> } | null;
  /** What a save said that has no form left to say it in. */
  notice: string | null;
  editable: boolean;
  /** Its amounts are in your plan's currency: the person's answer. */
  onRelabel: () => Promise<true | string>;
  onMakeMain: () => Promise<true | string>;
  plansCount: number | null;
  onPlans: () => void;
}) {
  const [error, setError] = useState('');
  const act = async (f: () => Promise<true | string>) => {
    const r = await f();
    setError(r === true ? '' : r);
  };
  return (
    <section className="card stack tight plan-copy-card" aria-label="This copy">
      <p className="helper">
        <Masked>{diffText(parts)}</Masked>
      </p>
      {other && currencyLine && (
        <>
          <Notice level="critical" role="alert">
            {currencyLine}
          </Notice>
          {confirmWhyNot ? (
            <p className="helper">{confirmWhyNot}</p>
          ) : (
            <div>
              <button type="button" className="btn secondary" disabled={!editable} onClick={() => void act(onRelabel)}>
                They’re in {planCurrency}
              </button>
            </div>
          )}
        </>
      )}
      {notice && (
        <Notice level="critical" role="alert">
          {notice}
        </Notice>
      )}
      {problem && (
        <Notice level="critical" role="alert">
          {problem}
        </Notice>
      )}
      {repair && (
        <>
          <Notice level="critical" role="alert">
            <Masked>{repair.text}</Masked>
          </Notice>
          <div>
            <button type="button" className="btn secondary" disabled={!editable} onClick={() => void act(repair.onSave)}>
              Save it this way
            </button>
          </div>
        </>
      )}
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
      <div className="btn-row">
        <button type="button" className="btn ghost" disabled={!editable} onClick={() => void act(onMakeMain)}>
          Make this your plan
        </button>
        <button type="button" className="btn ghost" aria-haspopup="dialog" onClick={onPlans}>
          {plansText(plansCount)}
        </button>
      </div>
    </section>
  );
}
