'use client';

// Starter category templates (lib/category-templates.ts), on the Categories
// screen and in the one-time offer (components/TemplateOffer.tsx): the sets to
// choose from, then what one would change, worked out by the server on your
// categories, budgets and what uses them (app/api/categories/templates):
// what it adds, renames, moves into its groups and archives, what it leaves
// as it is and why, and how your transactions and budgets file afterwards.
// Applying it is a second, deliberate tap, and Undo is offered right after,
// until you leave this screen. When your categories changed since the
// preview, the apply is refused and the preview worked out again.

import { useState } from 'react';
import { displayName, MAX_CATEGORIES } from '@/lib/categories';
import {
  TEMPLATE_IDS,
  TEMPLATES,
  type KeptCategory,
  type KeptGroup,
  type PlannedCategory,
  type TemplateId,
  type TemplatePlan,
  type TemplateUndo,
  type UndoKept,
} from '@/lib/category-templates';
import { Notice } from './TotalCaveats';

/** A plan as the route sends it: without the set it would make. */
export type ShownPlan = Omit<TemplatePlan, 'taxonomy' | 'signature'> & { basis: string };

export type Step =
  | { at: 'list' }
  | { at: 'preview'; template: TemplateId; plan: ShownPlan | null }
  | { at: 'applied'; template: TemplateId; plan: ShownPlan; undo: TemplateUndo }
  | { at: 'undone'; template: TemplateId; kept: UndoKept[] };

type Answer = { ok: true; data: Record<string, unknown> } | { ok: false; error: string; changed: boolean };
type Send = (body: Record<string, unknown>) => Promise<Answer>;

/** Sends one action; the answer, or why there is none (`changed`: what the
 *  apply would do changed since the preview). */
async function send(body: Record<string, unknown>): Promise<Answer> {
  try {
    const res = await fetch('/api/categories/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (res.ok && data) return { ok: true, data };
    return { ok: false, error: typeof data?.error === 'string' ? data.error : 'That couldn’t be done. Try again.', changed: data?.changed === true };
  } catch {
    return { ok: false, error: 'Nya could not be reached. Check your connection and try again.', changed: false };
  }
}

/**
 * Applies what was previewed, and answers what the screen shows next: the
 * set applied; or, when it would now do something else (changed since, on
 * another device), the preview worked out again on the set as it is, with
 * why, so Apply applies what is shown; or the preview, with what went wrong.
 */
export async function applyTemplate(template: TemplateId, plan: ShownPlan, post: Send = send): Promise<{ step: Step; error: string | null; categories?: unknown }> {
  const r = await post({ action: 'apply', template, basis: plan.basis });
  if (r.ok) return { step: { at: 'applied', template, plan: r.data.applied as ShownPlan, undo: r.data.undo as TemplateUndo }, error: null, categories: r.data.categories };
  if (!r.changed) return { step: { at: 'preview', template, plan }, error: r.error };
  const again = await post({ action: 'preview', template });
  if (!again.ok) return { step: { at: 'preview', template, plan: null }, error: again.error };
  return { step: { at: 'preview', template, plan: again.data.preview as ShownPlan }, error: `${r.error} Here is what it would do now.` };
}

const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** What it does to one category, in a line, as the app shows names (with a
 *  capital first letter); null for a change the app doesn't show (a name
 *  that only changes its capitals, "income" to "Income"). */
export function changeLine(c: PlannedCategory): string | null {
  const name = displayName(c.name);
  const renamed = c.was !== null && displayName(c.was) !== name;
  const archived = c.archive === 'archive' ? ' Archived, since nothing uses it.' : c.archive === 'unarchive' ? ' Shown again in the lists to choose from.' : '';
  if (c.id === null) return `Adds ${name}, in ${c.group}.`;
  if (renamed && c.from !== null) return `${displayName(c.was!)} becomes ${name}, in ${c.group}.${archived}`;
  if (renamed) return `${displayName(c.was!)} becomes ${name}.${archived}`;
  if (c.from !== null) return `${name} moves from ${c.from} to ${c.group}.${archived}`;
  if (c.archive === 'archive') return `${name} is archived, since nothing uses it.`;
  if (c.archive === 'unarchive') return `${name} is shown again in the lists to choose from.`;
  return null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why it leaves one as it is, in a line. */
export function keptLine(k: KeptCategory, template: string): string {
  const name = displayName(k.name);
  switch (k.why) {
    case 'holds':
      return `${name} isn’t archived: ${displayName(k.holds ?? '')} was merged into it before, and ${template} keeps that in its lists.`;
    case 'used': {
      const u = k.uses;
      const what = u
        ? [
            ...(u.transactions > 0 ? [`${plural(u.transactions, 'transaction is', 'transactions are')} filed under it`] : []),
            ...(u.budget ? ['it has a budget'] : []),
            ...(u.rules > 0 ? [`${plural(u.rules, 'rule uses', 'rules use')} it`] : []),
          ]
        : [];
      return `${name} isn’t archived: ${what.length > 0 ? list(what) : 'what uses it couldn’t be counted'}.`;
    }
    case 'group-budget':
      return `${name} stays where it is: ${k.group} has a budget of its own, so what it holds stays the same.`;
    case 'kind':
      return k.id === null
        ? `${name} isn’t added: your group called ${k.group} counts its transactions another way than ${template}’s group of that name.`
        : `${name} stays where it is: ${template}’s group for it counts its transactions another way, which would change your totals.`;
    case 'name-taken':
      return k.id === null ? `${name} isn’t added: another category has that name.` : `${name} keeps its name: another category is called ${displayName(k.wanted ?? '')}.`;
    case 'full':
      return `${name} isn’t added: you have ${MAX_CATEGORIES} categories, the most there can be.`;
  }
}

/** Why a group left empty stays, in a line. */
export function keptGroupLine(g: KeptGroup): string {
  return g.why === 'yours'
    ? `${g.name} is left empty and stays: it is a group of yours. Delete it on the Categories screen if you don’t need it.`
    : `${g.name} is left empty and stays: it had a budget in past months, which those months keep.`;
}

/** What undo couldn't put back, in a line. */
export function undoKeptLine(k: UndoKept): string {
  const name = displayName(k.name);
  switch (k.why) {
    case 'gone':
      return `${name} was deleted since, so it isn’t back.`;
    case 'changed':
      return `${k.group ? `The group ${name}` : name} was changed since, so it stays as it is now.`;
    case 'group-name-taken':
      return `The group ${name} isn’t back, as another group has its name, so what it held stays where it is.`;
    case 'group-full':
      return `The group ${name} isn’t back, as you have the most groups there can be, so what it held stays where it is.`;
    case 'used':
      return `${name} stays: something uses it now.`;
    case 'name-taken':
      return `${name} keeps its name: another category has the one it had.`;
    case 'group-budget':
      return `${name} stays where it is: a group it would move between has a budget of its own now.`;
    case 'kind':
      return `${name} stays where it is: its group counts its transactions another way now.`;
    case 'not-empty':
      return `The group ${name} stays: it holds categories, or has a budget of its own.`;
  }
}

/** The preview, as it reads (shown before applying, and after). */
export function PlanView({ plan }: { plan: ShownPlan }) {
  const name = TEMPLATES[plan.template].name;
  if (plan.unchanged) return <p className="panel-note">Your categories already match {name}: it would change nothing.</p>;
  const lines = plan.categories.flatMap((c) => {
    const line = changeLine(c);
    return line === null ? [] : [[`${c.id ?? 'new'}:${c.name}`, line] as const];
  });
  return (
    <>
      {(plan.groups.added.length > 0 || plan.groups.removed.length > 0 || plan.groups.kept.length > 0 || plan.groups.reordered) && (
        <div className="panel-section">
          <div className="section-label">Groups</div>
          {plan.groups.added.length > 0 && <p className="panel-note">Adds {list(plan.groups.added)}.</p>}
          {plan.groups.removed.length > 0 && <p className="panel-note">Removes {list(plan.groups.removed)}, left empty.</p>}
          {plan.groups.kept.map((g) => (
            <p className="panel-note" key={`kept:${g.name}`}>
              {keptGroupLine(g)}
            </p>
          ))}
          {plan.groups.reordered && <p className="panel-note">Puts your groups in {name}’s order, its own first.</p>}
        </div>
      )}
      {lines.length > 0 && (
        <div className="panel-section">
          <div className="section-label">Categories</div>
          <ul className="template-changes">
            {lines.map(([key, line]) => (
              <li key={key}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {(plan.kept.length > 0 || plan.merged.length > 0) && (
        <div className="panel-section">
          <div className="section-label">Left as they are</div>
          <ul className="template-changes">
            {plan.kept.map((k) => (
              <li key={`${k.id ?? k.name}:${k.why}`}>{keptLine(k, name)}</li>
            ))}
            {plan.merged.map((m) => (
              <li key={`merged:${m.name}`}>
                {displayName(m.name)} was merged into {displayName(m.into)} before, so it files there and isn’t a category of its own here.
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="panel-section">
        <div className="section-label">Your transactions and budgets</div>
        <p className="panel-note">
          Every transaction stays in its category: a category renamed shows its new name on its transactions, one moved counts in its new group, and none
          counts differently, since no category changes kind. An archived category still files its transactions; it is only left out of the lists to
          choose from. Nothing is deleted or merged.
        </p>
        <p className="panel-note">
          {plan.budgets.length > 0
            ? `Budgets stay with their categories: ${list(plan.budgets.map((b) => `${displayName(b.name)}’s, in ${b.group}`))}. `
            : 'Budgets stay with their categories, wherever they move. '}
          A group with a budget of its own keeps the categories it has, so its budget covers what it did.
        </p>
      </div>
    </>
  );
}

export default function CategoryTemplates({ onTaxonomy }: { onTaxonomy: (t: unknown) => void }) {
  const [step, setStep] = useState<Step>({ at: 'list' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function preview(template: TemplateId) {
    setStep({ at: 'preview', template, plan: null });
    setError(null);
    setBusy(true);
    const r = await send({ action: 'preview', template });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else setStep({ at: 'preview', template, plan: r.data.preview as ShownPlan });
  }
  async function apply(template: TemplateId, plan: ShownPlan) {
    setError(null);
    setBusy(true);
    const next = await applyTemplate(template, plan);
    setBusy(false);
    if (next.categories !== undefined) onTaxonomy(next.categories);
    setStep(next.step);
    setError(next.error);
  }
  async function undo(template: TemplateId, payload: TemplateUndo) {
    setError(null);
    setBusy(true);
    const r = await send({ action: 'undo', undo: payload });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onTaxonomy(r.data.categories);
    setStep({ at: 'undone', template, kept: (r.data.kept as UndoKept[]) ?? [] });
  }

  return (
    <CategoryTemplatesView
      step={step}
      busy={busy}
      error={error}
      onPreview={(t) => void preview(t)}
      onApply={(t, p) => void apply(t, p)}
      onUndo={(t, u) => void undo(t, u)}
      onList={() => {
        setStep({ at: 'list' });
        setError(null);
      }}
    />
  );
}

/** The screen for each step, from what it is given. */
export function CategoryTemplatesView({
  step,
  busy,
  error,
  onPreview,
  onApply,
  onUndo,
  onList,
}: {
  step: Step;
  busy: boolean;
  error: string | null;
  onPreview: (t: TemplateId) => void;
  onApply: (t: TemplateId, plan: ShownPlan) => void;
  onUndo: (t: TemplateId, undo: TemplateUndo) => void;
  onList: () => void;
}) {
  const failed = error && (
    <Notice level="critical" role="alert">
      {error}
    </Notice>
  );
  if (step.at === 'list') {
    return (
      <div className="sheet-form">
        <p className="panel-note" style={{ marginTop: 0 }}>
          A starter set of categories and groups. You see what one would change first, and can undo it right after. It renames and regroups the
          categories Nya started you with, adds its own, and archives the ones it has no place for while nothing uses them; it never deletes or merges
          one, and your own categories stay as they are.
        </p>
        {TEMPLATE_IDS.map((id) => (
          <div className="template-option" key={id}>
            <div className="template-option-text">
              <span className="inst-name">{TEMPLATES[id].name}</span>
              <span className="panel-note">{TEMPLATES[id].summary}</span>
            </div>
            <button className="secondary" onClick={() => onPreview(id)} disabled={busy}>
              See what {TEMPLATES[id].name} changes
            </button>
          </div>
        ))}
        {failed}
      </div>
    );
  }
  const name = TEMPLATES[step.template].name;
  if (step.at === 'preview') {
    return (
      <div className="sheet-form">
        <div className="inst-name">{name}</div>
        <p className="panel-note">{TEMPLATES[step.template].summary}</p>
        {step.plan ? <PlanView plan={step.plan} /> : !error && <p className="empty-note">Working out what {name} would change…</p>}
        {failed}
        <div className="button-pair" style={{ marginTop: 16 }}>
          <button className="secondary" onClick={onList} disabled={busy}>
            Back
          </button>
          {step.plan && !step.plan.unchanged && (
            <button onClick={() => onApply(step.template, step.plan!)} disabled={busy}>
              {busy ? 'Applying…' : `Apply ${name}`}
            </button>
          )}
        </div>
      </div>
    );
  }
  if (step.at === 'applied') {
    return (
      <div className="sheet-form">
        <p className="panel-note" style={{ marginTop: 0 }} role="status">
          {name} is applied.{step.plan.unchanged ? ' It changed nothing.' : ' Your transactions and budgets show it on their next load.'}
        </p>
        {!step.plan.unchanged && (
          <button className="secondary" onClick={() => onUndo(step.template, step.undo)} disabled={busy}>
            {busy ? 'Undoing…' : 'Undo'}
          </button>
        )}
        {failed}
        <PlanView plan={step.plan} />
      </div>
    );
  }
  return (
    <div className="sheet-form">
      <p className="panel-note" style={{ marginTop: 0 }} role="status">
        {step.kept.length === 0 ? `What ${name} changed is back as it was.` : `What ${name} changed is back as it was, but for:`}
      </p>
      {step.kept.length > 0 && (
        <ul className="template-changes">
          {step.kept.map((k) => (
            <li key={`${k.name}:${k.why}`}>{undoKeptLine(k)}</li>
          ))}
        </ul>
      )}
      <button className="secondary" style={{ marginTop: 12 }} onClick={onList}>
        Back to the starter sets
      </button>
    </div>
  );
}
