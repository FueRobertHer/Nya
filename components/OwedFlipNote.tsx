'use client';

// What the Update form says in place of saving when the type chosen would
// move a manual account between money held and money owed, which the server
// refuses (lib/manual-account-writes.ts OWED_FLIP): why, and the way that
// keeps its past as it was recorded, closing it (the same sheet as its own
// Close… button) and adding a new one of the other kind.

import { isOwedType } from '@/lib/balance';

/** Whether the type chosen for an account crosses from the one it has. */
export function crossesOwed(stored: string | null | undefined, chosen: string): boolean {
  return !!stored && isOwedType(stored) !== isOwedType(chosen);
}

export default function OwedFlipNote({ toOwed, onClose, disabled }: { toOwed: boolean; onClose: () => void; disabled?: boolean }) {
  return (
    <div className="panel-note owed-flip-note" role="note">
      <p style={{ margin: 0 }}>
        This account counts as money {toOwed ? 'held, and a card or a loan as money owed' : 'owed, and the type you chose as money held'}.
        Changing it between them would change how every past balance of it counts, so it can’t be saved. Instead, close
        this account and add a new one of the type you chose: every earlier day stays as it was, and the new one counts
        from the day you add it.
      </p>
      <button className="link-btn" onClick={onClose} disabled={disabled} style={{ marginTop: 8 }}>
        Close this account…
      </button>
    </div>
  );
}
