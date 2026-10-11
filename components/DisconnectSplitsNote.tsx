'use client';

// What disconnecting a connection takes that adding it back doesn't bring
// back (#39): the splits of its transactions and their places in groups
// (lib/disconnect-item.ts). Categories, exclusions, tags and notes carry
// across a re-link; splits and groups don't, so the disconnect confirmation
// asks how many there are (app/api/transaction-splits, GET) and says so
// before anything goes. Nothing while it asks; when the count can't be read,
// it says so without numbers.

import { useEffect, useState } from 'react';

type Counts = { split: number; grouped: number };

/** What the confirmation says of a connection's splits and groups, or null
 *  when it has none. `null` counts: they couldn't be read. */
export function disconnectSplitsText(counts: Counts | null): string | null {
  if (counts === null) return 'Splits of its transactions, and their places in groups, go with it, and adding it back later doesn’t bring them back.';
  const { split, grouped } = counts;
  if (split === 0 && grouped === 0) return null;
  const txns = (n: number) => `${n} of its transactions`;
  if (grouped === 0) {
    return `You split ${txns(split)}. Disconnecting removes ${split === 1 ? 'that split' : 'those splits'}, and adding it back later doesn’t bring ${split === 1 ? 'it' : 'them'} back.`;
  }
  if (split === 0) {
    const inGroups = grouped === 1 ? `${txns(1)} is in a group` : `${txns(grouped)} are in groups`;
    return `${inGroups}. Disconnecting takes ${grouped === 1 ? 'it' : 'them'} out, and adding it back later doesn’t put ${grouped === 1 ? 'it' : 'them'} back.`;
  }
  return `You split ${txns(split)}, and ${grouped} ${grouped === 1 ? 'is in a group' : 'are in groups'}. Disconnecting removes ${split === 1 ? 'the split' : 'the splits'} and takes ${
    grouped === 1 ? 'the grouped one out of its group' : 'the grouped ones out of their groups'
  }, and adding it back later doesn’t bring either back.`;
}

export default function DisconnectSplitsNote({ itemId }: { itemId: string }) {
  // undefined: still asking; null: couldn't be read.
  const [counts, setCounts] = useState<Counts | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setCounts(undefined);
    fetch(`/api/transaction-splits?item_id=${encodeURIComponent(itemId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!live) return;
        setCounts(body && typeof body.split === 'number' && typeof body.grouped === 'number' ? { split: body.split, grouped: body.grouped } : null);
      })
      .catch(() => live && setCounts(null));
    return () => {
      live = false;
    };
  }, [itemId]);

  const text = counts === undefined ? null : disconnectSplitsText(counts);
  return text ? <p className="panel-note">{text}</p> : null;
}
