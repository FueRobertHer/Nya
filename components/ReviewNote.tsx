'use client';

// What a transaction's detail on the Activity tab says of its review and its
// merchant's default (lib/review-layer.ts marks), with what can be done about
// each: approve it, put it back in the queue, take a category a rule, a
// default or the bank offers an approved one, clear the default that filed
// it. Mounted in the expanded row (components/MonthBreakdown.tsx), on a
// transaction whole (a split one with its parts, one of a group's on its
// own), or on a group's row, whose transactions are approved each.

import { useState } from 'react';
import type { Txn } from './MonthBreakdown';
import type { ReviewControls } from './review-state';
import { categoryById, displayName, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import { Masked } from './HideAmounts';
import { changedSinceWords, defaultWords, suggestionWords } from './review-text';
import { Notice } from './TotalCaveats';

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ReviewNote({
  t,
  taxonomy,
  review,
  onChanged,
}: {
  t: Txn;
  taxonomy: Taxonomy | null;
  review: ReviewControls;
  /** After a default is cleared: the list read again. */
  onChanged: () => void;
}) {
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ix = taxonomy ? indexTaxonomy(taxonomy) : null;
  const nameOf = (id: string) => {
    const c = ix ? categoryById(ix, id) : null;
    return c ? displayName(c.name) : 'another category';
  };

  // A group's row: its transactions are reviewed each.
  if (t.group_members) {
    const waiting = t.group_members.filter((m) => m.needs_review);
    if (waiting.length === 0) return null;
    return (
      <div className="review-note">
        <span>
          {waiting.length === 1 ? '1 of its transactions needs review.' : `${waiting.length} of its transactions need review.`}
        </span>
        <button className="secondary" onClick={() => void review.approve(waiting)}>
          {waiting.length === 1 ? 'Approve it' : 'Approve them'}
        </button>
      </div>
    );
  }

  const clearDefault = async (id: string) => {
    setClearing(true);
    setError(null);
    try {
      const res = await fetch('/api/vendor-defaults', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (!res.ok && res.status !== 404) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'Could not clear the default. Please try again.');
      }
      onChanged();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setClearing(false);
    }
  };

  const lines: React.ReactNode[] = [];
  // A split transaction's parts are filed by their own categories, never by a
  // default or a rule: what would file the whole files nothing that counts.
  const whole = !t.split_parts;
  if (t.filed_by_default && whole) {
    const id = t.filed_by_default.id;
    lines.push(
      <div className="review-note" key="default">
        <span>{defaultWords(t.name, t.filed_by_default.agree, t.filed_by_default.earlier === true)}.</span>
        <button className="secondary" disabled={clearing} onClick={() => void clearDefault(id)}>
          Clear default
        </button>
      </div>
    );
  }
  if (t.needs_review) {
    lines.push(
      <div className="review-note" key="needs">
        {/* Beside the row's own note when it stands for a row imported at
            the amount approved (components/MonthBreakdown.tsx), so the change
            is said once. */}
        <span>
          <Masked>{t.review_changed ? changedSinceWords(t.review_changed, t, true) : 'Waiting for you to approve it as it is.'}</Masked>
        </span>
        <button className="secondary" onClick={() => void review.approve([t])}>
          Approve
        </button>
      </div>
    );
  } else if (t.reviewed_at) {
    lines.push(
      <div className="review-note" key="approved">
        <span>
          Approved {day(t.reviewed_at)}
          {t.approved_name !== undefined ? `, as “${t.approved_name}”` : ''}. Its category stays as you approved it until you change it.
        </span>
        <button className="secondary" onClick={() => void review.unapprove(t)}>
          Review again
        </button>
      </div>
    );
  } else if (t.review_changed) {
    // Changed since it was approved, before the queue's first day: said, not queued.
    lines.push(
      <div className="rename-hint" key="changed">
        <Masked>{changedSinceWords(t.review_changed, t, true)}</Masked>
      </div>
    );
  }
  // Offered while it stays filed where it was approved: approved, or back in
  // the queue since the bank changed its amount.
  if (t.review_suggestion && whole) {
    const s = t.review_suggestion;
    lines.push(
      <div className="review-note" key="suggestion">
        <span>{suggestionWords(s, nameOf(s.category_id), t.name)}</span>
        <button
          className="secondary"
          onClick={async () => {
            // Approved again as it would be filed now; read again to show it there.
            if (await review.approve([{ ...t, category_id: s.category_id }])) onChanged();
          }}
        >
          Use {nameOf(s.category_id)}
        </button>
      </div>
    );
  }
  if (t.review_unknown) {
    lines.push(
      <div className="rename-hint" key="unknown">
        Whether you approved this couldn&apos;t be read, so it shows as it is filed now.
      </div>
    );
  }
  if (lines.length === 0) return null;
  return (
    <>
      {lines}
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
    </>
  );
}
