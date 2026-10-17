'use client';

// The starter category templates (components/CategoryTemplates.tsx), offered
// once, on the Budgets tab, to someone whose categories are still the ones
// Nya made (lib/category-templates.ts isSeededSet): where a person setting up
// budgets sees them. Seeing the sets, or saying no, ends the offer on this
// device (kept in localStorage, a convenience: where it can't be kept, it is
// offered again on the next visit); applying one ends it anyway, since the
// set is no longer the one Nya made. The sets stay on the Categories screen,
// under Manage, for good.

import { useEffect, useState } from 'react';
import { Sheet } from './Sheet';
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

export default function TemplateOffer({ taxonomy, onTaxonomy }: { taxonomy: Taxonomy | null; onTaxonomy: (t: unknown) => void }) {
  // Read once, after the first render, so the server's page and the
  // browser's first render agree (no offer), and a choice made here ends it.
  const [done, setDone] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setDone(offeredHere()), []);

  const end = () => {
    markOffered();
    setDone(true);
  };
  // The sheet stays while open, whatever the set becomes: Undo is in it.
  const offered = !!taxonomy && done === false && isSeededSet(taxonomy);
  if (!offered && !open) return null;
  return (
    <>
      {offered && (
        <TemplateOfferCard
          onKeep={end}
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

/** The offer itself. */
export function TemplateOfferCard({ onKeep, onSee }: { onKeep: () => void; onSee: () => void }) {
  return (
    <div className="card template-offer">
      <div className="inst-header">
        <div className="inst-name">Categories that fit you</div>
      </div>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Your categories are the ones Nya started you with, one for each of Plaid’s. A starter set may suit you better: Simple, with about a dozen broad
        ones, or Freelancer, with your business income and expenses apart. You see what one changes before it does.
      </p>
      <div className="button-pair">
        <button className="secondary" onClick={onKeep}>
          Keep mine
        </button>
        <button onClick={onSee}>See starter sets</button>
      </div>
    </div>
  );
}
