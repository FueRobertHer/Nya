'use client';

// Merchants' default categories, in Settings, Transactions (lib/vendor-defaults.ts): each
// merchant with one, the category, since when it files its new transactions,
// and how many of its last three categorizations agree; with a way to clear
// one. A default is set by the person's own categorizations, two of the last
// three agreeing, never here. When they can't be read, it says so, and offers
// to remove them only if their bytes are damaged, once confirmed.

import { useCallback, useEffect, useState } from 'react';
import { categoryById, displayName, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import { defaultListWords } from './review-text';
import { VendorDefaultsSkeleton } from './LoadingSkeletons';
import { formatDay } from '@/lib/format';

type Shown = { id: string; name: string; category_id: string; since: string; agree: number; set_at: string };

/** A calendar day mid sentence: "today", "Oct 5", "Oct 5, 2025". */
function day(iso: string): string {
  return formatDay(iso, { sentence: true });
}

export default function VendorDefaultsCard({ taxonomy, onChanged }: { taxonomy: Taxonomy | null; onChanged: () => void }) {
  const [defaults, setDefaults] = useState<Shown[] | null>(null);
  const [problem, setProblem] = useState<{ error: string; repairable: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A load that failed (not a 409, which says what it couldn't read): said,
  // with a way to try again, never a spinner left turning.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/vendor-defaults');
      const data = await res.json().catch(() => null);
      if (res.ok && Array.isArray(data?.defaults)) {
        setDefaults(data.defaults);
        setProblem(null);
        setLoadError(null);
      } else if (res.status === 409) {
        setProblem({ error: data?.error ?? 'Your merchants’ default categories could not be read.', repairable: data?.repairable === true });
        setLoadError(null);
      } else setLoadError(data?.error ?? 'Could not load your defaults.');
    } catch {
      setLoadError('Could not reach the server.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const call = async (method: 'DELETE' | 'POST', body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/vendor-defaults', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'Could not change your defaults. Please try again.');
      }
      setConfirming(false);
      await load();
      onChanged();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  const ix = taxonomy ? indexTaxonomy(taxonomy) : null;
  const nameOf = (id: string) => {
    const c = ix ? categoryById(ix, id) : null;
    return c ? displayName(c.name) : 'a category that no longer exists';
  };

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Defaults</div>
        {defaults && defaults.length > 0 && <div className="inst-total">{defaults.length}</div>}
      </div>
      {problem ? (
        <>
          <p className="stale-note">{problem.error} None files a transaction until they can be.</p>
          {problem.repairable &&
            (confirming ? (
              <div className="button-pair">
                <button disabled={busy} onClick={() => void call('POST', { action: 'repair', confirm: true })}>
                  Remove them
                </button>
                <button className="secondary" onClick={() => setConfirming(false)}>
                  Keep them
                </button>
              </div>
            ) : (
              <button className="secondary" onClick={() => setConfirming(true)}>
                Remove the damaged defaults…
              </button>
            ))}
        </>
      ) : defaults === null ? (
        loadError ? (
          <>
            <p className="stale-note">{loadError}</p>
            <button className="secondary" onClick={() => void load()}>
              Try again
            </button>
          </>
        ) : (
          <VendorDefaultsSkeleton />
        )
      ) : defaults.length === 0 ? (
        <p className="empty-note">
          No defaults yet. When two of your last three categorizations of a merchant agree, Nya files its new transactions under that category, unless a rule or you give one another.
        </p>
      ) : (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            Each files a merchant’s new transactions that a rule or you haven’t given a category. It changes when two of your last three categorizations agree on another, from that day on: what it
            filed before stays. Clearing one puts what it filed back where your rules and the bank file it.
          </p>
          <ul className="vendor-defaults">
            {defaults.map((d) => (
              <li key={d.id}>
                <div>
                  <div className="inst-name">
                    {d.name || 'A merchant'} → {nameOf(d.category_id)}
                  </div>
                  <div className="rename-hint">{defaultListWords(d, day)}</div>
                </div>
                <button className="secondary" disabled={busy} onClick={() => void call('DELETE', { id: d.id })} aria-label={`Clear the default for ${d.name || 'this merchant'}`}>
                  Clear
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
