'use client';

// The rule drawer (#36): a rule being made or edited (components/rules-state.ts
// holds which), opened from the Rules screen under Manage, from "Create a rule
// from this" on a transaction, or from the offer after a transaction is given
// another category. When a transaction's name, amount, account,
// institution, category or source match every condition, then: file it under
// a category, show it under another name, add tags, or leave it out of
// budgets and reports (still listed). Before it is saved, it says how many of
// your stored transactions it matches, of any date, with the newest few
// (app/api/rules/preview), and how many keep a category or name you chose
// for them, since a choice made on one transaction always wins over a rule.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import CategoryPicker from './CategoryPicker';
import { signedMoney } from '@/lib/format';
import { MAX_CONDITIONS, RULE_NAME_MAX, RULE_TEXT_MAX, sortedRules, type RuleField } from '@/lib/rules';
import type { Taxonomy } from '@/lib/categories';
import { shownColor, type Tag } from '@/lib/tags';
import { blankCondition, draftComplete, draftInput, type DraftCondition, type RuleDraft, type RulesState } from './rules-state';

const FIELD_LABEL: Record<RuleField, string> = {
  name: 'Name',
  amount: 'Amount',
  account: 'Account',
  institution: 'Institution',
  category: 'Category',
  source: 'Source',
};
const OPS: Partial<Record<RuleField, [string, string][]>> = {
  name: [
    ['contains', 'contains'],
    ['equals', 'is'],
    ['starts_with', 'starts with'],
  ],
  amount: [
    ['gt', 'more than'],
    ['lt', 'less than'],
    ['between', 'between'],
  ],
};
const SOURCES: [string, string][] = [
  ['plaid', 'from a bank'],
  ['manual', 'entered by hand'],
  ['import', 'imported from a file'],
  ['simplefin', 'from SimpleFIN'],
];

type Preview = { matches: number; keep_category: number; keep_name: number; keep_approved?: number; samples: { transaction_id: string; date: string; name: string; amount: number; currency: string | null; account_name: string }[] };

/** How long the form rests before it is previewed. */
const PREVIEW_MS = 400;

export default function RuleSheet({
  rules,
  taxonomy,
  tags,
  accounts,
  onChanged,
}: {
  rules: RulesState;
  taxonomy: Taxonomy | null;
  tags: readonly Tag[];
  /** The accounts a condition can name, as the Accounts tab labels them. */
  accounts: readonly { id: string; label: string }[];
  /** A rule saved or deleted: the transactions are read again. */
  onChanged: () => void;
}) {
  const open = rules.draft !== null;
  const [form, setForm] = useState<RuleDraft | null>(rules.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // A preview answered after a newer one was asked for is dropped.
  const asked = useRef(0);

  // A new draft opened: the form starts from it.
  useEffect(() => {
    if (rules.draft) {
      setForm(rules.draft);
      setError(null);
      setPreview(null);
      setPreviewError(null);
      setConfirmDelete(false);
    }
  }, [rules.draft]);

  const complete = form !== null && draftComplete(form);
  const input = useMemo(() => (form ? JSON.stringify(draftInput(form)) : ''), [form]);
  useEffect(() => {
    if (!open || !complete) {
      setPreview(null);
      return;
    }
    const n = ++asked.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/rules/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rule: JSON.parse(input) }) });
        const data = await res.json().catch(() => null);
        if (n !== asked.current) return;
        if (res.ok) {
          setPreview(data);
          setPreviewError(null);
        } else {
          setPreview(null);
          setPreviewError(typeof data?.error === 'string' ? data.error : 'It couldn’t be previewed.');
        }
      } catch {
        if (n === asked.current) setPreviewError('Nya could not be reached to preview it.');
      }
    }, PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [open, complete, input]);

  if (!form) return null;
  // Rules that run before this one: none for a new rule, which goes first.
  const before = form.id ? sortedRules(rules.set).findIndex((r) => r.id === form.id) : 0;
  const set = (patch: Partial<RuleDraft>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setCondition = (i: number, patch: Partial<DraftCondition>) =>
    setForm((f) => (f ? { ...f, conditions: f.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) } : f));

  async function send(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'That couldn’t be saved. Try again.');
        return;
      }
      rules.accept(data);
      rules.close();
      onChanged();
    } catch {
      setError('Nya could not be reached. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const save = () => send({ action: form.id ? 'edit' : 'add', ...(form.id ? { id: form.id } : {}), rule: draftInput(form) });

  const valueField = (c: DraftCondition, i: number) => {
    const label = `${FIELD_LABEL[c.field]} to match`;
    switch (c.field) {
      case 'name':
      case 'institution':
        return (
          <input
            className="text-input"
            value={c.value}
            maxLength={RULE_TEXT_MAX}
            onChange={(e) => setCondition(i, { value: e.target.value })}
            placeholder={c.field === 'name' ? 'e.g. AMZN' : 'e.g. Chase'}
            aria-label={label}
            disabled={busy}
          />
        );
      case 'amount':
        return (
          <>
            <select className="text-input" value={c.direction} onChange={(e) => setCondition(i, { direction: e.target.value })} aria-label="Money out or in" disabled={busy}>
              <option value="out">money out</option>
              <option value="in">money in</option>
              <option value="">either way</option>
            </select>
            <input className="text-input" inputMode="decimal" value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })} placeholder="0.00" aria-label="Amount" disabled={busy} />
            {c.op === 'between' && (
              <input className="text-input" inputMode="decimal" value={c.value2} onChange={(e) => setCondition(i, { value2: e.target.value })} placeholder="and" aria-label="Up to" disabled={busy} />
            )}
          </>
        );
      case 'account':
        return (
          <select className="text-input" value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })} aria-label={label} disabled={busy}>
            <option value="">Choose an account…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
            {c.value && !accounts.some((a) => a.id === c.value) && <option value={c.value}>An account no longer here</option>}
          </select>
        );
      case 'category':
        return taxonomy ? (
          <CategoryPicker taxonomy={taxonomy} value={c.value} none="Choose a category…" onChange={(v) => setCondition(i, { value: v })} label={label} disabled={busy} />
        ) : (
          <p className="panel-note">Your categories are loading.</p>
        );
      case 'source':
        return (
          <select className="text-input" value={c.value} onChange={(e) => setCondition(i, { value: e.target.value })} aria-label={label} disabled={busy}>
            <option value="">Choose…</option>
            {SOURCES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        );
    }
  };

  return (
    <Sheet open={open} title={form.id ? 'Edit rule' : 'New rule'} onClose={rules.close}>
      <div className="sheet-form rule-form">
        <div className="section-label">When a transaction’s</div>
        {form.conditions.map((c, i) => (
          <div className="rule-condition" key={i}>
            <div className="rule-condition-head">
              <select
                className="text-input"
                value={c.field}
                onChange={(e) => setCondition(i, blankCondition(e.target.value as RuleField))}
                aria-label="What to match"
                disabled={busy}
              >
                {Object.entries(FIELD_LABEL).map(([f, l]) => (
                  <option key={f} value={f}>
                    {l}
                  </option>
                ))}
              </select>
              {OPS[c.field] ? (
                <select className="text-input" value={c.op} onChange={(e) => setCondition(i, { op: e.target.value })} aria-label="How" disabled={busy}>
                  {OPS[c.field]!.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="rule-is">is</span>
              )}
              {form.conditions.length > 1 && (
                <button type="button" className="link-btn" onClick={() => set({ conditions: form.conditions.filter((_, j) => j !== i) })} disabled={busy} aria-label="Remove this condition">
                  Remove
                </button>
              )}
            </div>
            {valueField(c, i)}
          </div>
        ))}
        {form.conditions.length < MAX_CONDITIONS && (
          <button type="button" className="secondary" onClick={() => set({ conditions: [...form.conditions, blankCondition()] })} disabled={busy}>
            And another condition
          </button>
        )}
        <p className="panel-note">Every condition must match. Text is matched in any case; an amount is its size, money out or in.</p>

        <div className="section-label" style={{ marginTop: 16 }}>
          Then
        </div>
        {taxonomy && (
          <label className="field">
            File it under
            <CategoryPicker taxonomy={taxonomy} value={form.set_category} none="Leave its category" onChange={(v) => set({ set_category: v })} disabled={busy} />
          </label>
        )}
        <label className="field">
          Show it as
          <input value={form.set_name} maxLength={RULE_NAME_MAX} onChange={(e) => set({ set_name: e.target.value })} placeholder="Leave its name" disabled={busy} />
        </label>
        {tags.length > 0 && (
          <div className="field">
            Add tags
            <div className="tag-suggestions" role="group" aria-label="Tags to add">
              {tags.map((t) => {
                const on = form.add_tags.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    className={`tag-suggestion${on ? ` chosen tag-${shownColor(t.color)}` : ''}`}
                    aria-pressed={on}
                    onClick={() => set({ add_tags: on ? form.add_tags.filter((x) => x !== t.id) : [...form.add_tags, t.id] })}
                    disabled={busy}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <label className="quick-add-check">
          <input type="checkbox" checked={form.hide} onChange={(e) => set({ hide: e.target.checked })} disabled={busy} />
          Leave it out of budgets and reports (it stays listed)
        </label>
        {form.id && (
          <label className="quick-add-check">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={busy} />
            On (off puts its transactions back as they were, and keeps the rule)
          </label>
        )}

        <div className="rule-preview" aria-live="polite">
          {!complete ? (
            <p className="panel-note">Fill in each condition and choose what it does to see what it matches.</p>
          ) : previewError ? (
            <div className="error">{previewError}</div>
          ) : !preview ? (
            <p className="panel-note">Counting what it matches…</p>
          ) : (
            <>
              <p className="rule-matches">
                Matches {preview.matches.toLocaleString()} of your stored transaction{preview.matches === 1 ? '' : 's'}, of any date
              </p>
              {preview.matches > 0 && before > 0 && (form.set_category || form.set_name.trim()) && (
                <p className="panel-note">
                  Where a rule above this one in your list also matches and sets the category or the name, that rule decides it.
                </p>
              )}
              {preview.keep_category > 0 && (
                <p className="panel-note">
                  {preview.keep_category} keep{preview.keep_category === 1 ? 's' : ''} {preview.keep_category === 1 ? 'its' : 'their'} own category: one you chose (a choice made on
                  one transaction always wins), or a payment between your SimpleFIN accounts, which a rule never splits.
                </p>
              )}
              {(preview.keep_approved ?? 0) > 0 && (
                <p className="panel-note">
                  {preview.keep_approved} you approved stay{preview.keep_approved === 1 ? 's' : ''} where you approved {preview.keep_approved === 1 ? 'it' : 'them'}: the rule&apos;s category is
                  offered on {preview.keep_approved === 1 ? 'it' : 'each'}, never applied unasked.
                </p>
              )}
              {preview.keep_name > 0 && (
                <p className="panel-note">
                  {preview.keep_name} keep{preview.keep_name === 1 ? 's' : ''} {preview.keep_name === 1 ? 'its' : 'their'} own name: a merchant you renamed, one you
                  entered by hand, or an imported one you named yourself.
                </p>
              )}
              {preview.samples.length > 0 && (
                <ul className="rule-samples">
                  {preview.samples.map((s) => (
                    <li key={s.transaction_id}>
                      <span>
                        {s.date} {s.name} <span className="type-tag">· {s.account_name}</span>
                      </span>
                      <span className="num">{signedMoney(-s.amount, s.currency, { always: true })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {error && <div className="error">{error}</div>}
        <button onClick={save} disabled={busy || !complete} style={{ marginTop: 12 }}>
          {busy ? 'Saving…' : form.id ? 'Save rule' : 'Make rule'}
        </button>
        <p className="panel-note">
          A rule changes every matching transaction, past and future, without changing what is stored: turn it off or delete it and they are as they were. What you
          set on one transaction always wins over a rule.
        </p>
        {form.id && (
          <div className="panel-section">
            {confirmDelete ? (
              <div className="button-pair">
                <button className="danger" onClick={() => send({ action: 'delete', id: form.id })} disabled={busy}>
                  {busy ? 'Deleting…' : 'Delete rule'}
                </button>
                <button className="secondary" onClick={() => setConfirmDelete(false)} disabled={busy}>
                  Keep it
                </button>
              </div>
            ) : (
              <button className="danger-outline" onClick={() => setConfirmDelete(true)} disabled={busy}>
                Delete rule…
              </button>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
