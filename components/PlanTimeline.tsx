'use client';

// The Timeline card on Your path (the tax plan's E2, timeline.md): everything
// a plan holds, on the points in time that place it, in place of the Income
// and one-off expenses, What if… and Life events cards. Its one sheet has
// levels: Add to your Timeline, an item (components/PlanItemSheet.tsx), that
// item's Starts or Ends, and Remove's confirm. A new item goes in the plan
// shown, or in your plan's case can be tried in a copy instead. Every save
// goes through the tab's saver (components/plan-savers.ts `form`), by the
// `onSave` it is given. The words are in components/plan-items.ts.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { focusInsteadOf, Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { Notice } from './TotalCaveats';
import { chevron, RIGHT } from './MonthStepper';
import { CopyTag } from './CopyTag';
import ActionRows from './ActionRows';
import AlsoChange, { type AlsoChoice } from './AlsoChange';
import EmptyState from './EmptyState';
import { AnchorLevel, ItemFields, ItemPreview, TemplateList, checkDraft, draftOf, type ItemDraft } from './PlanItemSheet';
import { fiWhen } from './plan-fi-when';
import { askAgesText } from './plan-text';
import {
  CHIP_TEMPLATES,
  ITEMS_FULL_TEXT,
  copyNameFor,
  countsInFiDate,
  everyRunText,
  itemAmount,
  itemCautions,
  itemWarnings,
  itemTitle,
  itemsFull,
  onSteadyPath,
  previewLines,
  waitingStart,
  rowSub,
  templateOf,
  timelinePoints,
  unplacedText,
  whereItCountsText,
  type ItemTemplate,
} from './plan-items';
import type { Count } from '@/lib/fire/compile';
import { itemRules, withItem, withoutItem, type PlanItem } from '@/lib/fire/items';
import { planPath } from '@/lib/fire/path';
import { stopOf, type Measured } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import type { DetailedAnswer } from './plan-detailed';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import type { FiredResult, SimPlan } from '@/lib/fire/simulate';

type Money = (n: number) => string;

/** A new item, or a change to one, tried in a copy of your plan. */
export type TimelineTry = {
  /** Whether a copy can be made now. */
  can: boolean;
  /** Why not, said where the button is. */
  why: ReactNode;
  /** The plans there are, for the copy's name. */
  plans: readonly { id: string; name: string }[];
  /** Makes a copy of your plan with this item in it, and opens it. */
  onTry: (item: PlanItem, name: string) => Promise<true | string>;
};

type Level = { at: 'add' } | { at: 'item' } | { at: 'starts' } | { at: 'ends' } | { at: 'remove' };

/** The draft with its preview's figures, kept by what was checked. */
type Worked = { key: string; f: PlanFigures | 'refused'; without: PlanFigures | null; runsOutAt: number | null; most: { amount: number; age: number } | null; points: readonly { age: number; balance: number }[]; working: boolean; failed: boolean };

export function TimelineCard({
  plan,
  figures,
  refused = false,
  measured,
  count,
  figuresFor = null,
  searchVersion = 0,
  firedFor = null,
  copyName,
  version,
  editable,
  paused,
  money,
  planInWalk,
  savings,
  onSave,
  alsoFor,
  tryIt,
  onAskAge,
  askRef,
  firstRef,
  reloading = false,
}: {
  /** The plan shown. */
  plan: FirePlanV2;
  /** Its figures: null while it isn't worked out. */
  figures: PlanFigures | null;
  /** Lasting changes take its retirement spending below zero: its rows, to
   *  fix them, and nothing to add. */
  refused?: boolean;
  measured: Measured;
  count: Count;
  /** The Plan's flow for a draft's figures (components/plan-detailed.ts); left out,
   *  the flat ones. */
  figuresFor?: ((slot: string, plan: FirePlanV2) => DetailedAnswer) | null;
  /** Moves as a job's answer arrives, so the preview takes it. */
  searchVersion?: number;
  /** Runs a start that waits on a run's own balance through the runs, in the Plan's
   *  worker; null when it couldn't be run. */
  firedFor?: ((ask: { sim: SimPlan; trigger: number; offset: number }, signal: AbortSignal) => Promise<FiredResult | null>) | null;
  /** The open copy's name; null on your plan. */
  copyName: string | null;
  /** The plan's version: the sheet closes when it changes, and never saves
   *  over another. */
  version: string;
  /** Saves can go now. */
  editable: boolean;
  /** Why they can't for more than a moment, said in the sheet. */
  paused: string | null;
  money: Money;
  /** D15's switch. */
  planInWalk: boolean;
  /** Savings a year as the plan has them, for a change in pay. */
  savings: number | null;
  onSave: (next: FirePlanV2, also: readonly string[], before: FirePlanV2) => Promise<boolean | string>;
  /** The other plans an edit of this item can go to too. */
  alsoFor: (id: string) => AlsoChoice[];
  /** Your plan's Try it; null in a copy. */
  tryIt: TimelineTry | null;
  /** Opens the sheet with your age (the same as the answer's ask). */
  onAskAge: () => void;
  askRef?: (el: HTMLElement | null) => void;
  /** Where focus goes once the age is saved and the ask is gone. */
  firstRef?: (el: HTMLElement | null) => void;
  /** The plan is being read again: the asks do nothing meanwhile. */
  reloading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<Level>({ at: 'add' });
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [template, setTemplate] = useState<ItemTemplate | null>(null);
  const [editing, setEditing] = useState<PlanItem | null>(null);
  const [fromAdd, setFromAdd] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [alsoIn, setAlsoIn] = useState<string[]>([]);
  const [said, setSaid] = useState('');
  const [worked, setWorked] = useState<Worked | null>(null);

  const versionRef = useRef(version);
  versionRef.current = version;
  const openedOn = useRef(version);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const emptyRef = useRef<HTMLButtonElement | null>(null);
  const startsRef = useRef<HTMLButtonElement | null>(null);
  const endsRef = useRef<HTMLButtonElement | null>(null);
  const templateRows = useRef(new Map<string, HTMLButtonElement>());
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const removeRow = useRef<HTMLButtonElement | null>(null);
  /** A save of this sheet's is out, its plan on screen before the answer. */
  const savingNow = useRef(false);
  /** Where focus goes on going back a level, after the sheet's own. */
  const backTo = useRef<(() => HTMLElement | null) | null>(null);
  /** Where focus goes once the sheet has closed and the plan has the save. */
  const focusNext = useRef<{ row: string } | 'add' | null>(null);
  const previewId = useId();

  const reachable = (fn: () => HTMLElement | null) => (el: Element | null) => {
    if (el) focusInsteadOf(el, fn);
  };
  // The opener gone (the empty state's, or a removed item's row): the card's
  // Add, the empty state's, or its title.
  const fallback = reachable(() => addRef.current ?? emptyRef.current ?? titleRef.current);

  const begin = (next: Level, d: ItemDraft | null, t: ItemTemplate | null, x: PlanItem | null, viaAdd: boolean) => {
    openedOn.current = version;
    setLevel(next);
    setDraft(d);
    setTemplate(t);
    setEditing(x);
    setFromAdd(viaAdd);
    setError('');
    setSaid('');
    setAlsoIn([]);
    setWorked(null);
    setOpen(true);
  };
  const close = () => setOpen(false);
  const openAdd = (from: HTMLElement) => {
    fallback(from);
    begin({ at: 'add' }, null, null, null, false);
  };
  const openNew = (t: ItemTemplate, from: HTMLElement | null, viaAdd: boolean) => {
    if (from) fallback(from);
    begin({ at: 'item' }, draftOf(null, t), t, null, viaAdd);
  };
  const openItem = (x: PlanItem, from: HTMLElement) => {
    fallback(from);
    const t = templateOf(x);
    begin({ at: 'item' }, draftOf(x, t), t, x, false);
  };

  // The plan shown changed (on another device, or another plan opened): what
  // is open was for the one before. Not this sheet's own save, whose plan is
  // on screen before the answer: refused, it goes back, and the sheet stays
  // with what was typed and why.
  useEffect(() => {
    if (!savingNow.current && version !== openedOn.current) setOpen(false);
  }, [version]);

  // "Added to Copy: …" goes with the copy.
  useEffect(() => {
    setSaid('');
  }, [copyName]);

  // Going back a level: Sheet puts focus on its panel as its own effect, so
  // this one, the parent's, runs after it and wins.
  const levelKey = level.at;
  useEffect(() => {
    const to = backTo.current;
    backTo.current = null;
    to?.()?.focus({ preventScroll: true });
  }, [levelKey]);

  // After a save: to the new row, or the card's Add, as soon as it is there.
  useEffect(() => {
    const next = focusNext.current;
    if (!next || open) return;
    const el = next === 'add' ? addRef.current : (rows.current.get(next.row) ?? null);
    if (el?.isConnected) {
      focusNext.current = null;
      el.focus({ preventScroll: true });
    }
  });

  const set = (next: Partial<ItemDraft>) => setDraft((d) => (d ? { ...d, ...next } : d));
  const checked = draft ? checkDraft(draft, plan) : null;
  const checkedKey = JSON.stringify(checked);

  // What is possible waits for typing to rest, since a search can take 50ms.
  useEffect(() => {
    if (!checked || !('ok' in checked) || !open) return;
    const item = checked.ok;
    const timer = setTimeout(() => {
      const run = (slot: string, p: FirePlanV2): DetailedAnswer => figuresFor?.(slot, p) ?? { figures: planFigures(p, measured, { count }), working: false, failed: false };
      const answer = run('preview', withItem(plan, item));
      const f = answer.figures;
      if ('refused' in f) {
        setWorked({ key: checkedKey, f: 'refused', without: null, runsOutAt: null, most: null, points: [], working: false, failed: false });
        return;
      }
      const path = planPath(f);
      const points = [...(path?.points ?? []), ...(path?.after?.points ?? [])];
      const top = points.reduce<{ amount: number; age: number } | null>((m, p) => (m && m.amount >= p.balance ? m : { amount: p.balance, age: p.age }), null);
      const off = item.from.anchor.at === 'fi' ? run('preview-without', withoutItem(plan, item.id)).figures : null;
      setWorked({ key: checkedKey, f, without: off && !('refused' in off) ? off : null, runsOutAt: path?.after?.runsOutAt ?? null, most: top, points, working: answer.working, failed: answer.failed });
    }, 200);
    return () => clearTimeout(timer);
    // checkedKey stands for checked; measured is a new object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkedKey, plan, count, open, searchVersion]);

  // Across history, once the steady path's answer for this draft is in.
  const [across, setAcross] = useState<{ key: string; fired: FiredResult | null } | null>(null);
  const waiting = worked?.key === checkedKey && worked.f !== 'refused' && checked && 'ok' in checked ? waitingStart(worked.f, checked.ok.id) : null;
  useEffect(() => {
    if (!open || !firedFor || !waiting) return;
    let live = true;
    const stop = new AbortController();
    const key = checkedKey;
    void firedFor(waiting, stop.signal).then((fired) => {
      if (live) setAcross({ key, fired });
    });
    return () => {
      live = false;
      stop.abort();
    };
    // `worked` stands for what is run: it is new each time this draft is worked out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worked, open]);
  const acrossNow = !waiting || !firedFor ? null : across?.key !== checkedKey ? { working: true as const } : across.fired ? { fired: across.fired, startAge: waiting.startAge } : null;

  /** Saves on the version the sheet opened on, while saves can go. */
  const guarded = async (run: () => Promise<boolean | string>): Promise<boolean> => {
    if (openedOn.current !== versionRef.current) {
      setError('This plan changed since this was opened, so nothing was saved: open it again.');
      return false;
    }
    if (!editable) {
      setError(paused ?? 'It was not saved. Try again in a moment.');
      return false;
    }
    setError('');
    setSaving(true);
    savingNow.current = true;
    const r = await run();
    savingNow.current = false;
    setSaving(false);
    if (r !== true) {
      setError(typeof r === 'string' ? r : 'It was not saved. Try again in a moment.');
      return false;
    }
    return true;
  };

  const itemOr = (): PlanItem | null => {
    if (!checked) return null;
    if ('error' in checked) {
      setError(checked.error);
      return null;
    }
    return checked.ok;
  };

  const saveItem = async () => {
    const item = itemOr();
    if (!item) return;
    const first = plan.items.length === 0;
    const isNew = !editing;
    if (await guarded(() => onSave(withItem(plan, item), isNew ? [] : alsoIn, plan))) {
      if (isNew) {
        focusNext.current = first ? 'add' : { row: item.id };
        if (copyName) setSaid(`Added to Copy: ${copyName}`);
      }
      close();
    }
  };

  const tryItem = async () => {
    const item = itemOr();
    if (!item || !tryIt || !template) return;
    const name = copyNameFor(template, item, plan, tryIt.plans);
    if (await guarded(() => tryIt.onTry(item, name))) close();
  };

  const removeItem = async () => {
    if (!editing) return;
    if (await guarded(() => onSave(withoutItem(plan, editing.id), [], plan))) close();
  };

  // --- the card ---

  const full = itemsFull(plan);
  const noAge = plan.age === null;
  const stop = figures?.resolution.stop ?? stopOf(plan);
  const noStop = !plan.stopAtFi && stopOf(plan) === null;
  const engine = figures?.engine;
  const sim = engine && 'sim' in engine ? engine : null;
  const startAge = sim ? sim.startAge : null;
  const whose = copyName ? 'this copy' : 'your plan';
  const empty = plan.items.length === 0;
  const canAdd = !refused && !noAge && !full && !reloading;

  const notesOf = (x: PlanItem, i: number): { warn: string[]; caution: string[]; plain: string[] } => {
    const at = figures?.resolution.ages[i]?.start ?? null;
    const warn = figures ? itemWarnings(x, figures, i) : [];
    const plain: string[] = [];
    const perRun = !!figures?.resolution.perRun?.edges[i];
    if ((at !== null || perRun) && onSteadyPath(x, plan)) {
      const every = everyRunText(at, plan, perRun);
      if (every) plain.push(every);
    }
    const why = figures?.resolution.why[i] ?? null;
    if (why === 'no-years') plain.push('Ends before it starts, so it runs no years.');
    const caution = figures ? itemCautions(x, { start: at, stop, inFi: countsInFiDate(figures, i), taxRate: plan.taxRate, detailed: !!figures.detail && !('failed' in figures.detail) }) : [];
    return { warn, caution, plain };
  };

  const row = (i: number, unplaced: string | null = null, notReached = false) => {
    const x = plan.items[i];
    const v = itemAmount(x);
    const start = figures?.resolution.ages[i]?.start ?? null;
    const n = refused ? { warn: [], caution: [], plain: [] } : notesOf(x, i);
    const atMost = notReached ? nearest(figures, money) : null;
    const said = [...n.plain, ...(unplaced ? [unplaced] : []), ...(atMost ? [atMost] : [])];
    const noted = n.warn.length + n.caution.length + said.length > 0;
    return (
      <li key={x.id}>
        <button
          type="button"
          className="list-row"
          aria-haspopup="dialog"
          aria-disabled={reloading || undefined}
          ref={(el) => {
            if (el) rows.current.set(x.id, el);
            else rows.current.delete(x.id);
          }}
          onClick={(e) => {
            if (!reloading) openItem(x, e.currentTarget);
          }}
        >
          <span className="list-row-text">
            <span className="list-row-title">{itemTitle(x, plan)}</span>
            <span className="list-row-sub">
              <Masked>{rowSub(x, plan, money, { start, inWalk: figures ? countsInFiDate(figures, i) : false })}</Masked>
            </span>
          </span>
          <span className="list-row-value money plan-input-value">
            <span>
              <Masked>{money(v.amount)}</Masked>
            </span>
            <span className="plan-input-line">{v.line}</span>
          </span>
          {chevron(RIGHT)}
        </button>
        {noted && (
          <div className="row-notes">
            {said.map((t) => (
              <p key={t} className="helper">
                <Masked>{t}</Masked>
              </p>
            ))}
            {n.warn.map((t) => (
              <span key={t} className="plan-warning">
                {t}
              </span>
            ))}
            {n.caution.map((t) => (
              <Notice key={t} level="caution">
                {t}
              </Notice>
            ))}
          </div>
        )}
      </li>
    );
  };

  const ask = (text: string) => (
    <button
      type="button"
      className="btn ghost hero-ask"
      ref={askRef}
      aria-haspopup="dialog"
      aria-disabled={reloading ? 'true' : undefined}
      onClick={() => {
        if (!reloading) onAskAge();
      }}
    >
      {text}
    </button>
  );

  const layout = refused ? null : timelinePoints(plan, figures, money);

  const body = refused ? (
    <ul className="list-rows">{plan.items.map((_, i) => row(i))}</ul>
  ) : empty ? (
    noAge ? (
      <EmptyState
        heading="h4"
        title="Nothing on your Timeline yet"
        line="An item is placed by age."
        action={{
          label: askAgesText('age'),
          opens: true,
          held: reloading,
          ref: (el) => {
            askRef?.(el);
          },
          onSelect: onAskAge,
        }}
      />
    ) : (
      <EmptyState
        heading="h4"
        title="Nothing on your Timeline yet"
        line={copyName ? 'Add what you expect to this copy:' : 'Add what you expect, or try it in a copy:'}
        action={{
          label: 'Add',
          opens: true,
          held: reloading,
          ref: (el) => {
            emptyRef.current = el;
            firstRef?.(el);
          },
          onSelect: () => openAdd(emptyRef.current as HTMLElement),
        }}
      >
        <div className="chip-row" role="group" aria-label="Add an item">
          {CHIP_TEMPLATES.map((t) => (
            <button key={t.id} type="button" className="chip" aria-haspopup="dialog" aria-disabled={reloading || undefined} onClick={(e) => !reloading && openNew(t, e.currentTarget, false)}>
              {t.label}
            </button>
          ))}
        </div>
      </EmptyState>
    )
  ) : (
    <>
      <p className="helper">{whereItCountsText(startAge, planInWalk)}</p>
      {noAge && ask(askAgesText('age'))}
      {!noAge && noStop && ask(askAgesText('stop'))}
      {full && <p className="helper">{ITEMS_FULL_TEXT}</p>}
      {layout?.points.map((p) =>
        p.items.length === 0 ? (
          <p key={p.key} className="section-label">
            <Masked>{p.label}</Masked>
          </p>
        ) : (
          <div key={p.key} className="plan-timeline-point">
            <h4 className="section-label">
              <Masked>{p.label}</Masked>
            </h4>
            <ul className="list-rows">{p.items.map((i) => row(i))}</ul>
          </div>
        )
      )}
      {layout?.notReached.map((p) =>
        p.items.length === 0 ? (
          <p key={p.key} className="section-label">
            <Masked>{p.label}</Masked>
          </p>
        ) : (
          <div key={p.key} className="plan-timeline-point">
            <h4 className="section-label">
              <Masked>{p.label}</Masked>
            </h4>
            <ul className="list-rows">{p.items.map((i) => row(i, null, true))}</ul>
          </div>
        )
      )}
      {layout && layout.unplaced.length > 0 && (
        <div className="plan-timeline-point">
          <h4 className="section-label">Not placed yet</h4>
          <ul className="list-rows">{layout.unplaced.map((i) => row(i, unplacedText(plan.items[i], figures?.resolution.why[i] ?? (plan.age === null ? 'no-age' : null), plan)))}</ul>
        </div>
      )}
    </>
  );

  // --- the sheet ---

  const title =
    level.at === 'add'
      ? 'Add to your Timeline'
      : level.at === 'starts'
        ? 'Starts'
        : level.at === 'ends'
          ? 'Ends'
          : level.at === 'remove'
            ? `Remove ${editing?.label ?? ''}`
            : (editing?.label ?? template?.label ?? '');
  const itemName = editing?.label ?? template?.label ?? '';
  const onBack =
    level.at === 'starts' || level.at === 'ends'
      ? () => {
          const side = level.at;
          backTo.current = () => (side === 'starts' ? startsRef.current : endsRef.current);
          setLevel({ at: 'item' });
        }
      : level.at === 'remove'
        ? () => {
            backTo.current = () => removeRow.current;
            setLevel({ at: 'item' });
          }
        : level.at === 'item' && fromAdd
          ? () => {
              const id = template?.id ?? '';
              backTo.current = () => templateRows.current.get(id) ?? null;
              setLevel({ at: 'add' });
            }
          : undefined;
  const off = saving || !editable;
  const preview =
    draft && checked
      ? previewLines({
          draft: checked,
          before: figures,
          after: 'ok' in checked && worked?.key === checkedKey ? worked.f : null,
          working: worked?.key === checkedKey && worked.working,
          failed: worked?.key === checkedKey && worked.failed,
          without: 'ok' in checked && worked?.key === checkedKey ? worked.without : null,
          where: copyName ? 'copy' : 'plan',
          money,
          startAge,
          most: worked?.key === checkedKey ? worked.most : null,
          points: worked?.key === checkedKey ? worked.points : [],
          savings,
          runsOutAt: worked?.key === checkedKey ? worked.runsOutAt : null,
          across: acrossNow,
        })
      : null;
  const changed = !!(editing && checked && 'ok' in checked && JSON.stringify(checked.ok) !== JSON.stringify(editing));
  const dependents = editing ? plan.items.filter((y) => y.id !== editing.id && timedBy(y, editing.id)) : [];
  const removeRefused = editing ? itemRules(withoutItem(plan, editing.id)) !== null : false;

  const footer =
    level.at === 'item' ? (
      <div className="btn-row">
        {editing ? (
          <>
            <button type="button" className="btn secondary" onClick={close} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => void saveItem()} disabled={off}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <>
            {tryIt && (
              <button type="button" className="btn secondary" onClick={() => void tryItem()} disabled={off || !tryIt.can}>
                Try it in a copy
              </button>
            )}
            <button type="button" className="btn" onClick={() => void saveItem()} disabled={off}>
              {saving ? 'Adding…' : copyName ? 'Add to this copy' : 'Add to your plan'}
            </button>
          </>
        )}
      </div>
    ) : level.at === 'starts' || level.at === 'ends' ? (
      <div className="btn-row">
        <button type="button" className="btn" onClick={onBack}>
          Done
        </button>
      </div>
    ) : level.at === 'remove' ? (
      <div className="btn-row">
        <button type="button" className="btn secondary" onClick={onBack} disabled={saving}>
          {removeRefused ? 'Back' : 'Cancel'}
        </button>
        {!removeRefused && (
          <button type="button" className="btn danger" onClick={() => void removeItem()} disabled={off}>
            {saving ? 'Removing…' : 'Remove'}
          </button>
        )}
      </div>
    ) : undefined;

  const fiAge = (() => {
    const w = worked?.key === checkedKey && worked.f !== 'refused' ? fiWhen(worked.f) : fiWhen(figures);
    return w.kind === 'age' ? w.age : null;
  })();

  const errorNotice = error && (
    <Notice level="critical" role="alert">
      {error}
    </Notice>
  );
  const pausedLine = paused && <p className="helper plan-paused">{paused}</p>;

  return (
    <section className="card plan-timeline" aria-labelledby="plan-timeline-title">
      <CopyTag name={copyName} />
      <div className="card-header">
        <h3 id="plan-timeline-title" tabIndex={-1} ref={titleRef}>
          Timeline
        </h3>
        {!empty && !refused && (
          <button
            type="button"
            className="btn ghost"
            aria-haspopup="dialog"
            ref={(el) => {
              addRef.current = el;
              firstRef?.(el);
            }}
            aria-disabled={!canAdd || undefined}
            onClick={(e) => {
              if (canAdd) openAdd(e.currentTarget);
            }}
          >
            Add
          </button>
        )}
      </div>
      <div className="stack">
        {said && (
          <p className="helper" role="status">
            {said}
          </p>
        )}
        {body}
      </div>
      <Sheet
        open={open}
        title={title}
        onClose={close}
        onBack={onBack}
        backLabel={level.at === 'starts' || level.at === 'ends' || level.at === 'remove' ? `Back to ${itemName}` : level.at === 'item' && fromAdd ? 'Back to Add to your Timeline' : undefined}
        level={level.at}
        footer={footer}
      >
        {level.at === 'add' && (
          <div className="stack">
            <p className="helper">{copyName ? `Everything here goes in Copy: ${copyName}.` : 'What you expect goes in your plan; a choice you’re weighing, try it in a copy.'}</p>
            <CopyTag name={copyName} />
            <TemplateList
              disabled={!canAdd}
              onPick={(t) => openNew(t, null, true)}
              refFor={(id) => (el) => {
                if (el) templateRows.current.set(id, el);
                else templateRows.current.delete(id);
              }}
            />
          </div>
        )}
        {level.at === 'item' && draft && (
          <div className="stack">
            <CopyTag name={copyName} />
            <ItemFields
              draft={draft}
              set={set}
              plan={plan}
              money={money}
              stop={stop}
              planInWalk={planInWalk}
              saving={saving}
              where={copyName ? 'Saved to this copy, not your plan.' : `Saved to ${whose}.`}
              onStarts={() => setLevel({ at: 'starts' })}
              onEnds={() => setLevel({ at: 'ends' })}
              startsRef={startsRef}
              endsRef={endsRef}
            />
            {preview && <ItemPreview lines={preview} id={previewId} />}
            {!editing && tryIt && !tryIt.can && tryIt.why}
            {editing && <AlsoChange choices={alsoFor(editing.id)} checked={alsoIn} onChange={setAlsoIn} disabled={saving} />}
            {errorNotice}
            {pausedLine}
            {editing && (
              <ActionRows
                rows={[
                  ...(tryIt && changed && tryIt.can && editable
                    ? [
                        {
                          key: 'try',
                          title: 'Try this change in a copy',
                          sub: 'Your plan stays as it is.',
                          onSelect: () => void tryItem(),
                        },
                      ]
                    : []),
                  {
                    key: 'remove',
                    title: `Remove from ${whose}`,
                    sub: 'Asks first.',
                    opens: true,
                    neg: true,
                    ref: removeRow,
                    onSelect: () => {
                      setError('');
                      setLevel({ at: 'remove' });
                    },
                  },
                ]}
              />
            )}
          </div>
        )}
        {(level.at === 'starts' || level.at === 'ends') && draft && (
          <div className="stack">
            <AnchorLevel side={level.at} draft={draft} set={set} plan={plan} stop={stopOf(plan)} fiAge={fiAge} saving={saving} />
          </div>
        )}
        {level.at === 'remove' && editing && (
          <div className="stack">
            {removeRefused ? (
              <p>
                {dependents.length > 0
                  ? `${dependents.map((y) => `“${y.label}”`).join(' and ')} ${dependents.length === 1 ? 'is' : 'are'} timed by it. Change when ${dependents.length === 1 ? 'that starts or ends' : 'those start or end'} first.`
                  : 'Another item is timed by it. Change when that starts or ends first.'}
              </p>
            ) : (
              <p>
                It comes off {whose}, and nothing else changes{copyName ? ': your plan stays as it is' : ''}.
              </p>
            )}
            {errorNotice}
            {pausedLine}
          </div>
        )}
      </Sheet>
    </section>
  );
}

/** Whether `y` is timed by the item with this id. */
function timedBy(y: PlanItem, id: string): boolean {
  const on = (w: PlanItem['from']) => w.anchor.at === 'item' && w.anchor.id === id;
  return on(y.from) || (y.until !== null && !('years' in y.until) && on(y.until));
}

/** The nearest the steady path comes to a balance it never reaches, for a
 *  row under one: the highest balance, and its age. */
function nearest(figures: PlanFigures | null, money: Money): string | null {
  if (!figures) return null;
  const path = planPath(figures);
  const points = [...(path?.points ?? []), ...(path?.after?.points ?? [])];
  if (points.length === 0) return null;
  const top = points.reduce((m, p) => (p.balance > m.balance ? p : m));
  return `At most ${money(top.balance)}, at ${top.age}.`;
}
