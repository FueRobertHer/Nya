'use client';

// Your rules, in Settings, Transactions (#36): each in a sentence, in
// the order they run (the first to set a category or a name decides it),
// with a switch to turn it off (its transactions go back as they were, and
// the rule is kept), arrows to move it up or down, and Edit, which opens the
// rule drawer (components/RuleSheet.tsx). A rule that can't work (a category
// it names was deleted) says so. Each change is sent on its own
// (app/api/rules) and the list shown is the server's answer; the
// transactions are read again after it (`onChanged`), since rules apply on
// every read.

import { useMemo, useState } from 'react';
import { indexTaxonomy, type Taxonomy } from '@/lib/categories';
import { ruleSentence, sortedRules, type Rule } from '@/lib/rules';
import type { Tag } from '@/lib/tags';
import { draftFromRule, newDraft, type RulesState } from './rules-state';
import { hiddenFigure } from '@/lib/format';
import { Masked } from './HideAmounts';
import { Notice } from './TotalCaveats';

/** An amount in a rule: a size, in whatever currency the transaction is
 *  (hidden while amounts are, lib/format.ts). */
const size = (n: number) => hiddenFigure(n.toLocaleString(undefined, { maximumFractionDigits: 8 }));

export default function RulesCard({
  rules,
  taxonomy,
  tags,
  accounts,
  onChanged,
}: {
  rules: RulesState;
  taxonomy: Taxonomy | null;
  tags: readonly Tag[];
  accounts: readonly { id: string; label: string }[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = sortedRules(rules.set);
  const names = useMemo(
    () => ({
      ix: taxonomy ? indexTaxonomy(taxonomy) : null,
      tags: { version: 1 as const, tags: [...tags] },
      account: (id: string) => accounts.find((a) => a.id === id)?.label ?? null,
      money: size,
    }),
    [taxonomy, tags, accounts]
  );

  async function send(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/rules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : 'That change couldn’t be made. Try again.');
        if (res.status === 404 || res.status === 409) void rules.load();
        return;
      }
      rules.accept(data);
      onChanged();
    } catch {
      setError('Nya could not be reached. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const move = (r: Rule, by: -1 | 1) => {
    const ids = list.map((x) => x.id);
    const i = ids.indexOf(r.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void send({ action: 'order', ids });
  };

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Rules</div>
      </div>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {list.length === 0
          ? 'A rule files, renames, tags or hides every transaction that matches it, past and future. Make one from a transaction’s detail on the Activity tab, or here.'
          : `${list.length} rule${list.length === 1 ? '' : 's'}, in the order they run: when two set a transaction’s category or name, the higher one decides. What you set on one transaction always wins over a rule.`}
      </p>
      {rules.error ? (
        <>
          <p className="stale-note">{rules.error}</p>
          <button className="secondary" style={{ marginTop: 12 }} onClick={() => void rules.load()}>
            Try again
          </button>
        </>
      ) : (
        <>
          <div className="stack">
            <button className="secondary" style={{ marginTop: 12 }} onClick={() => rules.open(newDraft())} disabled={!rules.set}>
              New rule
            </button>
            {error && (
              <Notice level="critical" role="alert">
                {error}
              </Notice>
            )}
          </div>
          {list.length > 0 && (
            <ol className="rule-list">
              {list.map((r, i) => (
                <li key={r.id} className={`rule-row${r.enabled ? '' : ' off'}`}>
                  {/* Each control names the rule it acts on: its number, and
                      its sentence as the description. */}
                  <div className="rule-sentence" id={`rule-${r.id}`}>
                    <Masked>{ruleSentence(r, names)}</Masked>
                  </div>
                  {rules.problems[r.id] && <div className="stale-note">{rules.problems[r.id]}</div>}
                  <div className="rule-row-actions">
                    <label>
                      <input
                        type="checkbox"
                        checked={r.enabled}
                        onChange={(e) => void send({ action: 'enable', id: r.id, enabled: e.target.checked })}
                        disabled={busy}
                        aria-label={`Rule ${i + 1} on`}
                        aria-describedby={`rule-${r.id}`}
                      />
                      On
                    </label>
                    <button className="link-btn" onClick={() => move(r, -1)} disabled={busy || i === 0} aria-label={`Run rule ${i + 1} earlier`} aria-describedby={`rule-${r.id}`}>
                      Up
                    </button>
                    <button
                      className="link-btn"
                      onClick={() => move(r, 1)}
                      disabled={busy || i === list.length - 1}
                      aria-label={`Run rule ${i + 1} later`}
                      aria-describedby={`rule-${r.id}`}
                    >
                      Down
                    </button>
                    <button className="link-btn" onClick={() => rules.open(draftFromRule(r))} disabled={busy} aria-label={`Edit rule ${i + 1}`} aria-describedby={`rule-${r.id}`}>
                      Edit
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
