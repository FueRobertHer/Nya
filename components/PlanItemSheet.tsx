'use client';

// The Timeline's item sheet (the tax plan's E2, timeline.md "The item
// sheet"): one form for every kind of item, its fields from the kind as
// lib/fire/items.ts FIELDS has them, and its Starts and Ends as rows that
// open a level of their own (AnchorLevel). Add to your Timeline's templates
// (TemplateList), and what is possible as it is typed (ItemPreview, its
// words in components/plan-items.ts previewLines). The draft is strings while
// typed and lives with the Timeline's sheet (components/PlanTimeline.tsx), so
// Starts, Ends and back keep what was typed. Every amount and length is the
// person's own: nothing is filled in but the item's name, no field holds an
// example, and nothing suggests what something "usually" costs.

import type { Ref } from 'react';
import RadioRows, { type RadioOption } from './RadioRows';
import { Segmented } from './Segmented';
import { Masked, NO_EXAMPLE } from './HideAmounts';
import { Notice } from './TotalCaveats';
import { chevron, RIGHT } from './MonthStepper';
import { ITEM_TEMPLATES, TEMPLATE_GROUPS, TEMPLATE_HELP, itemRuleText, type ItemTemplate, type PreviewLines } from './plan-items';
import { INCOME_KINDS, ONCE_KINDS, parseItem, withItem, type ItemKind, type PlanItem, type When } from '@/lib/fire/items';
import { LIMITS } from '@/lib/fire/plan';
import { parsePlanV2, type FirePlanV2 } from '@/lib/fire/plan-v2';

type Money = (n: number) => string;

export type StartPick = 'age' | 'stop' | 'fi' | 'item' | 'balance';
export type EndPick = StartPick | 'good' | 'years';

/** A start or an end as typed: what is picked, and each pick's own fields,
 *  kept while another is picked so going back to it finds them. */
export type WhenDraft = {
  pick: EndPick;
  age: string;
  /** Years either side of the stop, FI or another item, or after a balance. */
  years: string;
  before: boolean;
  item: string;
  edge: 'start' | 'end';
  amount: string;
  /** For how many years. */
  span: string;
};

export type ItemDraft = {
  id: string;
  kind: ItemKind;
  /** The template it is shown with (a career break is pay down). */
  template: string;
  label: string;
  once: string;
  yearly: string;
  less: boolean;
  replaces: string;
  repeats: boolean;
  every: string;
  times: string;
  inflationAdjusted: boolean;
  owner: 'you' | 'partner' | null;
  beforeTax: boolean;
  from: WhenDraft;
  until: WhenDraft;
};

/** The draft as it would be saved, or why it can't be: `missing` when a
 *  field is empty, else one is out of range or breaks a rule between items. */
export type Checked = { ok: PlanItem } | { error: string; missing?: true };

const asText = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
const read = (t: string): number | null => (t.trim() === '' ? null : Number(t));
export const templateById = (id: string) => ITEM_TEMPLATES.find((t) => t.id === id) ?? ITEM_TEMPLATES[0];

/** A switch with its words over it, as a field's label is (the words are
 *  its name for a screen reader too). */
function Switch<T extends string>({ text, options, value, onChange, disabled }: { text: string; options: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void; disabled: boolean }) {
  return (
    <div className="field">
      <span aria-hidden="true">{text}</span>
      <Segmented label={text} options={options} value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

const EMPTY_WHEN: WhenDraft = { pick: 'age', age: '', years: '', before: false, item: '', edge: 'start', amount: '', span: '' };

/** Kinds whose amount says whose it is. */
const OWNED: readonly ItemKind[] = [...INCOME_KINDS, 'pay'];
const REPEATS: readonly ItemKind[] = ['car', 'one-off'];

function whenDraft(w: When | { years: number } | null): WhenDraft {
  if (w === null) return { ...EMPTY_WHEN, pick: 'good' };
  if ('years' in w) return { ...EMPTY_WHEN, pick: 'years', span: String(w.years) };
  const a = w.anchor;
  const off = { years: w.offset === 0 ? '' : String(Math.abs(w.offset)), before: w.offset < 0 };
  switch (a.at) {
    case 'age':
      // An age and an offset are one age.
      return { ...EMPTY_WHEN, pick: 'age', age: String(a.age + w.offset) };
    case 'stop':
    case 'fi':
      return { ...EMPTY_WHEN, ...off, pick: a.at };
    case 'item':
      return { ...EMPTY_WHEN, ...off, pick: 'item', item: a.id, edge: a.edge };
    case 'balance':
      return { ...EMPTY_WHEN, ...off, pick: 'balance', amount: String(a.amount) };
  }
}

/** A new item's draft from its template, or one there as it is. */
export function draftOf(x: PlanItem | null, t: ItemTemplate): ItemDraft {
  if (x) {
    return {
      id: x.id,
      kind: x.kind,
      template: t.id,
      label: x.label,
      once: asText(x.once),
      yearly: asText(x.yearly === null ? null : Math.abs(x.yearly)),
      less: x.yearly !== null && x.yearly < 0,
      replaces: asText(x.replaces),
      repeats: x.every !== null,
      every: asText(x.every),
      times: x.every !== null ? asText(x.times) : '',
      inflationAdjusted: x.inflationAdjusted,
      owner: x.owner,
      beforeTax: x.beforeTax,
      from: whenDraft(x.from),
      until: ONCE_KINDS.includes(x.kind) || x.kind === 'loan-end' ? { ...EMPTY_WHEN, pick: 'good' } : whenDraft(x.until),
    };
  }
  const end: EndPick = t.kind === 'part-time' ? 'age' : t.kind === 'child' || t.less ? 'years' : 'good';
  return {
    id: crypto.randomUUID(),
    kind: t.kind,
    template: t.id,
    label: t.name,
    once: '',
    yearly: '',
    less: !!t.less,
    replaces: '',
    repeats: false,
    every: '',
    times: '',
    inflationAdjusted: true,
    owner: null,
    // Statements quote income before tax.
    beforeTax: INCOME_KINDS.includes(t.kind),
    from: { ...EMPTY_WHEN },
    until: { ...EMPTY_WHEN, pick: end },
  };
}

/** Whether the draft has an end to set: not for what happens once, a loan
 *  paid off (for good), or a home that changes no spending. */
export function hasEnds(d: Pick<ItemDraft, 'kind' | 'yearly'>): boolean {
  if (ONCE_KINDS.includes(d.kind) || d.kind === 'loan-end') return false;
  if (d.kind === 'home') return (read(d.yearly) ?? 0) !== 0;
  return true;
}

/** Ends' choices for the kind: part-time work and a child always end. */
export function endPicks(kind: ItemKind): EndPick[] {
  const all: EndPick[] = ['age', 'stop', 'fi', 'item', 'balance', 'good', 'years'];
  return kind === 'part-time' || kind === 'child' ? all.filter((p) => p !== 'good') : all;
}

class Missing extends Error {}

const need = (t: string, what: string) => {
  const n = read(t);
  if (n === null) throw new Missing(`Fill in ${what}.`);
  return n;
};

function whenOf(w: WhenDraft, what: 'starts' | 'stops'): When {
  const offset = (read(w.years) ?? 0) * (w.before ? -1 : 1);
  switch (w.pick) {
    case 'age':
      return { anchor: { at: 'age', age: need(w.age, `the age it ${what}`) }, offset: 0 };
    case 'stop':
    case 'fi':
      return { anchor: { at: w.pick }, offset };
    case 'item':
      if (!w.item) throw new Missing(`Pick the item it ${what} by.`);
      return { anchor: { at: 'item', id: w.item, edge: w.edge }, offset };
    case 'balance':
      return { anchor: { at: 'balance', amount: need(w.amount, 'the balance invested assets reach') }, offset: read(w.years) ?? 0 };
    default:
      throw new Missing(`Pick when it ${what}.`);
  }
}

/** The draft as an item, or Missing naming an empty field. */
function buildItem(d: ItemDraft): PlanItem {
  const k = d.kind;
  const yearlyOf = (what: string) => need(d.yearly, what) * (d.less ? -1 : 1);
  let once: number | null = null;
  let yearly: number | null = null;
  switch (k) {
    case 'home':
      once = need(d.once, 'what is paid from your investments (0 for nothing)');
      yearly = read(d.yearly) === null ? 0 : yearlyOf('the change');
      break;
    case 'car':
      once = need(d.once, 'what each car takes from your investments');
      break;
    case 'one-off':
    case 'windfall':
      once = need(d.once, 'the amount');
      break;
    case 'child':
      yearly = need(d.yearly, 'the spending a year');
      break;
    case 'loan-end':
      yearly = need(d.yearly, 'how much less you would spend a year');
      break;
    case 'spending':
    case 'pay':
      yearly = yearlyOf(d.template === 'career-break' ? 'how much less you would save a year' : 'the change a year');
      break;
    default:
      yearly = need(d.yearly, 'the income a year');
  }
  const until = !hasEnds(d) ? null : d.until.pick === 'good' ? null : d.until.pick === 'years' ? { years: need(d.until.span, 'for how many years') } : whenOf(d.until, 'stops');
  const repeat = REPEATS.includes(k) && d.repeats;
  return {
    id: d.id,
    label: d.label,
    kind: k,
    from: whenOf(d.from, 'starts'),
    until,
    once,
    yearly,
    replaces: k === 'part-time' ? read(d.replaces) : null,
    every: repeat ? need(d.every, 'every how many years') : null,
    times: repeat ? need(d.times, 'how many in all') : k === 'car' ? 1 : null,
    inflationAdjusted: INCOME_KINDS.includes(k) ? d.inflationAdjusted : true,
    owner: OWNED.includes(k) ? d.owner : null,
    beforeTax: INCOME_KINDS.includes(k) ? d.beforeTax : false,
  };
}

/** The draft as it would be saved in `plan` (in place of the item with its
 *  id, else added), or why it can't be: its own ranges first, then the
 *  plan's rules between items, each said with the items' names. */
export function checkDraft(d: ItemDraft, plan: FirePlanV2): Checked {
  let built: PlanItem;
  try {
    built = buildItem(d);
  } catch (err) {
    if (!(err instanceof Missing)) throw err;
    return { error: err.message, missing: true };
  }
  const parsed = parseItem(built, 'This item');
  if ('error' in parsed) return { error: `${parsed.error.replace(/^This item: /, '').replace(/^./, (c) => c.toUpperCase())}.` };
  const next = withItem(plan, parsed.ok);
  const whole = parsePlanV2(next);
  if ('error' in whole) return { error: itemRuleText(whole.error, next) };
  return parsed;
}

/** Starts' or Ends' row: what is picked, in words. */
export function pickWords(w: WhenDraft, plan: FirePlanV2, money: Money, stop: number | null): string {
  const n = read(w.years) ?? 0;
  const by = (what: string) => (n === 0 ? null : `${n} year${n === 1 ? '' : 's'} ${w.before ? 'before' : 'after'} ${what}`);
  switch (w.pick) {
    case 'age':
      return read(w.age) === null ? 'At an age' : `At ${w.age}`;
    case 'stop':
      return `${by('you stop') ?? 'When you stop'}${!plan.stopAtFi && stop !== null ? ` · at ${stop}, your stop age` : ''}`;
    case 'fi':
      return by('FI') ?? 'When you reach FI';
    case 'item': {
      const other = plan.items.find((x) => x.id === w.item);
      if (!other) return 'When another item starts or ends';
      const edge = `${other.label} ${w.edge === 'start' ? 'starts' : 'ends'}`;
      return by(edge) ?? `When ${edge}`;
    }
    case 'balance': {
      const amount = read(w.amount);
      const reach = amount === null ? 'When invested assets reach a figure' : `When invested assets reach ${money(amount)}`;
      return n === 0 ? reach : `${reach}, ${n} year${n === 1 ? '' : 's'} after`;
    }
    case 'good':
      return 'For good';
    case 'years':
      return read(w.span) === null ? 'After some years' : `For ${w.span} year${w.span.trim() === '1' ? '' : 's'}`;
  }
}

/** The figures of the item sheet: the kind's helper, its name, whose, its
 *  amounts and tax, and its Starts and Ends rows. */
export function ItemFields({
  draft,
  set,
  plan,
  money,
  stop,
  saving,
  where,
  onStarts,
  onEnds,
  startsRef,
  endsRef,
}: {
  draft: ItemDraft;
  set: (next: Partial<ItemDraft>) => void;
  /** The plan it goes in. */
  plan: FirePlanV2;
  money: Money;
  /** The stop as resolved (an age, or under stop when I reach FI the FI age). */
  stop: number | null;
  saving: boolean;
  /** Where Save puts it, after the helper. */
  where: string;
  onStarts: () => void;
  onEnds: () => void;
  startsRef?: Ref<HTMLButtonElement>;
  endsRef?: Ref<HTMLButtonElement>;
}) {
  const d = draft;
  const k = d.kind;
  const income = INCOME_KINDS.includes(k);
  const whose = OWNED.includes(k) && (plan.partnerAge !== null || d.owner === 'partner');
  const field = (text: string, value: string, onChange: (v: string) => void, amount = false) => (
    <label className="field">
      {text}
      <input type="number" inputMode={amount ? 'decimal' : 'numeric'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={amount ? NO_EXAMPLE : undefined} disabled={saving} />
    </label>
  );
  const direction = (text: string) => (
    <Switch text={text} options={[['more', 'More'], ['less', 'Less']] as const} value={d.less ? 'less' : 'more'} onChange={(v) => set({ less: v === 'less' })} disabled={saving} />
  );
  const repeats = (
    <>
      <Switch text="How often" options={[['once', 'Once'], ['repeats', 'Every few years']] as const} value={d.repeats ? 'repeats' : 'once'} onChange={(v) => set({ repeats: v === 'repeats' })} disabled={saving} />
      {d.repeats && (
        <>
          {field('Every how many years', d.every, (v) => set({ every: v }))}
          {field('How many in all', d.times, (v) => set({ times: v }))}
        </>
      )}
    </>
  );
  return (
    <>
      <p className="helper">
        {TEMPLATE_HELP[d.template] ?? TEMPLATE_HELP[k]} Your own figures: Nya suggests none. {where}
      </p>
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={d.label} onChange={(e) => set({ label: e.target.value })} maxLength={LIMITS.label} disabled={saving} />
        </label>
        {whose && <Switch text="Whose" options={[['you', 'You'], ['partner', 'Your partner']] as const} value={d.owner === 'partner' ? 'partner' : 'you'} onChange={(v) => set({ owner: v })} disabled={saving} />}
        {k === 'home' && (
          <>
            {field('Paid from your investments', d.once, (v) => set({ once: v }), true)}
            {field('Change in yearly spending from then', d.yearly, (v) => set({ yearly: v }), true)}
            {direction('Spending from then')}
          </>
        )}
        {k === 'child' && field('More spending a year', d.yearly, (v) => set({ yearly: v }), true)}
        {k === 'car' && (
          <>
            {field('Paid from your investments, each', d.once, (v) => set({ once: v }), true)}
            {repeats}
          </>
        )}
        {k === 'one-off' && (
          <>
            {field('The amount', d.once, (v) => set({ once: v }), true)}
            {repeats}
          </>
        )}
        {k === 'windfall' && field('Amount, after tax', d.once, (v) => set({ once: v }), true)}
        {k === 'loan-end' && field('Spending less a year', d.yearly, (v) => set({ yearly: v }), true)}
        {k === 'spending' && (
          <>
            {field('Change a year', d.yearly, (v) => set({ yearly: v }), true)}
            {direction('Spending')}
          </>
        )}
        {k === 'pay' &&
          (d.template === 'career-break' ? (
            field('Saved less a year', d.yearly, (v) => set({ yearly: v }), true)
          ) : (
            <>
              {direction('Your take-home')}
              {field('By, a year', d.yearly, (v) => set({ yearly: v }), true)}
            </>
          ))}
        {income && (
          <>
            {field('A year', d.yearly, (v) => set({ yearly: v }), true)}
            <Switch text="The amount is" options={[['before', 'Before tax'], ['after', 'After tax']] as const} value={d.beforeTax ? 'before' : 'after'} onChange={(v) => set({ beforeTax: v === 'before' })} disabled={saving} />
          </>
        )}
        {k === 'part-time' && (
          <>
            {field('The take-home it replaces, a year', d.replaces, (v) => set({ replaces: v }), true)}
            <p className="helper">What your job pays you a year that it takes the place of, after tax: 0 for work on the side. Left empty, its years before you stop don’t count in your FI date.</p>
          </>
        )}
      </div>
      {income && (
        <>
          <label className="plan-check">
            <input type="checkbox" checked={d.inflationAdjusted} onChange={(e) => set({ inflationAdjusted: e.target.checked })} disabled={saving} />
            Rises with inflation (Social Security does; many pensions don&apos;t)
          </label>
          {!d.inflationAdjusted && (
            <p className="helper">
              Enter what it will pay in today&apos;s dollars. A pension quoted as a future amount is worth less by all the inflation until it starts, so scale it down first; from then on the plan takes inflation off it every year.
            </p>
          )}
        </>
      )}
      <ul className="card list-rows">
        <li>
          <button type="button" className="list-row" ref={startsRef} onClick={onStarts} disabled={saving}>
            <span className="list-row-text">
              <span className="list-row-title">Starts</span>
              <span className="list-row-sub">
                <Masked>{pickWords(d.from, plan, money, stop)}</Masked>
              </span>
            </span>
            {chevron(RIGHT)}
          </button>
        </li>
        {hasEnds(d) && (
          <li>
            <button type="button" className="list-row" ref={endsRef} onClick={onEnds} disabled={saving}>
              <span className="list-row-text">
                <span className="list-row-title">Ends</span>
                <span className="list-row-sub">
                  <Masked>{pickWords(d.until, plan, money, stop)}</Masked>
                </span>
              </span>
              {chevron(RIGHT)}
            </button>
          </li>
        )}
      </ul>
      {d.from.pick === 'age' && (
        <div className="sheet-form">
          {field(d.owner === 'partner' ? 'Starts at your partner’s age' : 'Starts at age', d.from.age, (v) => set({ from: { ...d.from, age: v } }))}
        </div>
      )}
    </>
  );
}

/** Starts or Ends: where the item's edge is, as radio rows, the picked one's
 *  fields under it. A pick changes the draft; only the item's Save saves. */
export function AnchorLevel({
  side,
  draft,
  set,
  plan,
  stop,
  fiAge,
  saving,
}: {
  side: 'starts' | 'ends';
  draft: ItemDraft;
  set: (next: Partial<ItemDraft>) => void;
  plan: FirePlanV2;
  /** The stop as an age, null while it isn't set. */
  stop: number | null;
  /** FI on the steady path with the draft in, as the answer rounds it. */
  fiAge: number | null;
  saving: boolean;
}) {
  const key = side === 'starts' ? 'from' : 'until';
  const w = draft[key];
  const put = (next: Partial<WhenDraft>) => set({ [key]: { ...w, ...next } } as Partial<ItemDraft>);
  const others = plan.items.filter((x) => x.id !== draft.id);
  const noStop = stop === null && !plan.stopAtFi;
  const field = (text: string, value: string, onChange: (v: string) => void, amount = false) => (
    <label className="field">
      {text}
      <input type="number" inputMode={amount ? 'decimal' : 'numeric'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={amount ? NO_EXAMPLE : undefined} disabled={saving} />
    </label>
  );
  const offset = (
    <>
      {field('Years', w.years, (v) => put({ years: v }))}
      <Switch text="Before or after" options={[['before', 'Before'], ['after', 'After']] as const} value={w.before ? 'before' : 'after'} onChange={(v) => put({ before: v === 'before' })} disabled={saving} />
    </>
  );
  const sameAtFi = plan.stopAtFi ? 'The same year while you stop at FI' : undefined;
  const options: RadioOption[] = [
    { value: 'age', name: 'At an age', detail: field(draft.owner === 'partner' ? 'Your partner’s age' : 'Age', w.age, (v) => put({ age: v })) },
    { value: 'stop', name: 'When you stop', note: sameAtFi ?? (stop !== null ? `At ${stop}` : undefined), disabled: noStop, detail: offset },
    { value: 'fi', name: 'When you reach FI', note: sameAtFi ?? (fiAge !== null ? `Around ${fiAge}` : undefined), detail: offset },
    {
      value: 'item',
      name: 'When another item starts or ends',
      disabled: others.length === 0,
      detail: (
        <>
          <label className="field">
            Item
            <select value={w.item} onChange={(e) => put({ item: e.target.value })} disabled={saving}>
              <option value="">Pick one</option>
              {others.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          <Switch text="Its start or end" options={[['start', 'Starts'], ['end', 'Ends']] as const} value={w.edge} onChange={(v) => put({ edge: v })} disabled={saving} />
          {offset}
        </>
      ),
    },
    {
      value: 'balance',
      name: 'When invested assets reach…',
      note: 'Checked each year on your steady path',
      detail: (
        <>
          {field('Invested assets', w.amount, (v) => put({ amount: v }), true)}
          {field('Years after', w.years, (v) => put({ years: v, before: false }))}
        </>
      ),
    },
  ];
  if (side === 'ends') {
    options.push({ value: 'good', name: 'For good' }, { value: 'years', name: 'After some years', detail: field('For how many years', w.span, (v) => put({ span: v })) });
  }
  const picks = side === 'ends' ? endPicks(draft.kind) : (['age', 'stop', 'fi', 'item', 'balance'] as EndPick[]);
  const reasons = [noStop && 'Set when you stop in Household first.', others.length === 0 && 'To time it by another item, add that one first.'].filter(Boolean).join(' ');
  return (
    <RadioRows
      legend={side === 'starts' ? 'It starts' : 'It ends'}
      name={`item-${side}`}
      options={options.filter((o) => picks.includes(o.value as EndPick))}
      value={w.pick}
      onChange={(v) => put({ pick: v as EndPick })}
      disabled={saving}
      helper={reasons || undefined}
    />
  );
}

/** What is possible: the rows, the line that moves as it is typed, the rest,
 *  and the Honesty table's cautions. */
export function ItemPreview({ lines, id }: { lines: PreviewLines; id: string }) {
  const [first, ...rest] = lines.lines;
  return (
    <section className="stack" aria-labelledby={id}>
      <h3 className="section-label" id={id}>
        What’s possible
      </h3>
      {lines.rows.length > 0 && (
        <dl className="txn-detail">
          {lines.rows.map((r) => (
            <div className="txn-detail-row" key={r.key}>
              <dt>
                <Masked>{r.key}</Masked>
              </dt>
              <dd>
                <Masked>{r.value}</Masked>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {/* Only the first line is said as it changes. */}
      <p className="helper" role="status">
        <Masked>{first ?? ''}</Masked>
      </p>
      {rest.map((l) => (
        <p key={l} className="helper">
          <Masked>{l}</Masked>
        </p>
      ))}
      {lines.cautions.map((c) => (
        <Notice key={c} level="caution">
          <Masked>{c}</Masked>
        </Notice>
      ))}
    </section>
  );
}

/** Add to your Timeline: the templates in their three groups. */
export function TemplateList({ onPick, disabled, refFor }: { onPick: (t: ItemTemplate) => void; disabled: boolean; refFor?: (id: string) => Ref<HTMLButtonElement> | undefined }) {
  return (
    <>
      {TEMPLATE_GROUPS.map((g) => (
        <section key={g.id} className="stack tight" aria-labelledby={`add-${g.id}`}>
          <h3 className="section-label" id={`add-${g.id}`}>
            {g.name}
          </h3>
          <ul className="card list-rows">
            {ITEM_TEMPLATES.filter((t) => t.group === g.id).map((t) => (
              <li key={t.id}>
                <button type="button" className="list-row" ref={refFor?.(t.id)} onClick={() => !disabled && onPick(t)} aria-disabled={disabled || undefined}>
                  <span className="list-row-text">
                    <span className="list-row-title">{t.label}</span>
                  </span>
                  {chevron(RIGHT)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

