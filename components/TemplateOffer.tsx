'use client';

// The starter category templates (components/CategoryTemplates.tsx), offered
// once, on the Budgets tab, to someone whose categories are still the ones
// Nya made (lib/category-templates.ts isSeededSet): where a person setting up
// budgets sees them. Seeing the sets, or saying no, ends the offer on this
// device (kept in localStorage, a convenience: where it can't be kept, it is
// offered again on the next visit); applying one ends it anyway, since the
// set is no longer the one Nya made. The sets stay on the Categories screen,
// in Settings, Transactions, for good.
//
// The offer is one row (the look and feel review's L11, again after the
// screen review: as a card its See starter sets was the screen's only filled
// button, over the month's own first step): the row opens the sets, and a
// bare × beside it, never inside it, keeps your categories. That × takes the
// row away with it, so focus goes where the caller says (Budgets: the month's
// heading, where its panel starts) rather than to nothing.

import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import { chevron, RIGHT } from './MonthStepper';
import CategoryTemplates from './CategoryTemplates';
import { isSeededSet } from '@/lib/category-templates';
import type { Taxonomy } from '@/lib/categories';

export const TEMPLATE_OFFER_KEY = 'nya:category-templates-offered';

/** LENIENT: whether this device has had the offer; no when it can't say. */
export function offeredHere(): boolean {
  try {
    return localStorage.getItem(TEMPLATE_OFFER_KEY) === '1';
  } catch {
    return false;
  }
}

function markOffered(): void {
  try {
    localStorage.setItem(TEMPLATE_OFFER_KEY, '1');
  } catch {
    // Not kept: offered again next time, which is all that is lost.
  }
}

export default function TemplateOffer({
  taxonomy,
  onTaxonomy,
  onKept,
}: {
  taxonomy: Taxonomy | null;
  onTaxonomy: (t: unknown) => void;
  /** After Keep my categories, once the row is gone: where focus goes. */
  onKept?: () => void;
}) {
  // Read once, after the first render, so the server's page and the
  // browser's first render agree (no offer), and a choice made here ends it.
  const [done, setDone] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setDone(offeredHere()), []);

  const end = () => {
    markOffered();
    setDone(true);
  };
  // Kept: the row (and the × pressed) goes, so focus is put where the
  // caller says, once it has.
  const [kept, setKept] = useState(false);
  useEffect(() => {
    if (kept) onKept?.();
    // Once, as the row goes: onKept may be new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kept]);
  // The sheet stays while open, whatever the set becomes: Undo is in it.
  const offered = !!taxonomy && done === false && isSeededSet(taxonomy);
  if (!offered && !open) return null;
  return (
    <>
      {offered && (
        <TemplateOfferCard
          onKeep={() => {
            end();
            setKept(true);
          }}
          onSee={() => {
            end();
            setOpen(true);
          }}
        />
      )}
      <Sheet open={open} title="Starter sets" onClose={() => setOpen(false)}>
        <CategoryTemplates onTaxonomy={onTaxonomy} />
      </Sheet>
    </>
  );
}

/** The offer itself: one row that opens the starter sets, and beside it a
 *  bare × that keeps your categories. The sets, their names and what one
 *  would change before it does are said in the sheet the row opens. */
export function TemplateOfferCard({ onKeep, onSee }: { onKeep: () => void; onSee: () => void }) {
  return (
    <ul className="card list-rows template-offer">
      <li>
        <button type="button" className="list-row" aria-haspopup="dialog" onClick={onSee}>
          <span className="list-row-text">
            <span className="list-row-title">Categories that fit you</span>
            <span className="list-row-sub">A starter set may suit you better</span>
          </span>
          {chevron(RIGHT)}
        </button>
        {/* Its name shows on hover too (as the header's icon buttons'), so
            it can be found by sight and asked for by voice. */}
        <button type="button" className="icon-btn" aria-label="Keep my categories" title="Keep my categories" onClick={onKeep}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </li>
    </ul>
  );
}
