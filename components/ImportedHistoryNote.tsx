'use client';

// Under the net-worth chart: which stretch of the estimated history comes
// from transactions imported into linked accounts rather than from the bank,
// and what imported history isn't drawn and why (#52; the words are
// lib/history-import/view.ts importedHistoryLines). The chart draws the whole
// estimated region dashed already; this says what that part is made of.

import { importedHistoryLines, type ImportedHistoryView } from '@/lib/history-import/view';
import { formatDay } from '@/lib/format';

type Named = { institution_name: string; accounts: { account_id: string; name: string }[] };

/** A calendar day as the viewer reads one mid sentence: "today", "Sep 3",
 *  "Sep 3, 2025" (lib/format.ts formatDay). */
const fmtDay = (day: string) => formatDay(day, { sentence: true });

export default function ImportedHistoryNote({ view, institutions }: { view: ImportedHistoryView; institutions: Named[] }) {
  const names = new Map<string, string>();
  for (const inst of institutions) for (const a of inst.accounts) names.set(a.account_id, inst.institution_name && inst.institution_name !== a.name ? `${inst.institution_name} ${a.name}` : a.name);
  const lines = importedHistoryLines(view, (id) => names.get(id) ?? 'an account no longer shown', fmtDay);
  if (lines.length === 0) return null;
  return (
    <div className="imported-history-note">
      {lines.map((line) => (
        <p key={line} className="panel-note">
          {line}
        </p>
      ))}
    </div>
  );
}
