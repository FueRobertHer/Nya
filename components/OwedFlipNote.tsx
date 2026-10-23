'use client';

// What the Update form says in place of saving when the type chosen would
// move a manual account between money held and money owed, which the server
// refuses (lib/manual-account-writes.ts OWED_FLIP): why, and the two ways
// that keep every day counted as it was recorded, each with what it does.
//
//   Close    for an account that itself changed: every day before its end
//            keeps it, and a new one of the other kind is added beside it
//            (the same sheet as the account's own Close… button).
//   Hide     for one entered as the wrong type from the start: hiding takes
//            it out of every day, earlier ones too, each by what it was
//            recorded as (its hidden entry keeps the type it had), so no day
//            counts it the wrong way.
//
// Said in a live region that is always there, so the reason is announced as
// soon as such a type is chosen; the form's type and Save point at it
// (aria-describedby, OWED_FLIP_REASON) while it shows.

import { isOwedType } from '@/lib/balance';

/** The note's id, for the controls it explains to point at. */
export const OWED_FLIP_REASON = 'owed-flip-reason';

/** Whether the type chosen for an account crosses from the one it has. */
export function crossesOwed(stored: string | null | undefined, chosen: string): boolean {
  return !!stored && isOwedType(stored) !== isOwedType(chosen);
}

export default function OwedFlipNote({
  crossing,
  toOwed,
  onClose,
  onHide,
  disabled,
}: {
  /** The type chosen crosses: the note shows. */
  crossing: boolean;
  toOwed: boolean;
  onClose: () => void;
  onHide: () => void;
  disabled?: boolean;
}) {
  return (
    <div aria-live="polite">
      {crossing && (
        <div className="panel-note owed-flip-note" id={OWED_FLIP_REASON}>
          <p style={{ margin: 0 }}>
            This account counts as money {toOwed ? 'held, and a card or a loan as money owed' : 'owed, and the type you chose as money held'}.
            Its type can’t change between them, so this can’t be saved: every past balance of it would count the other way.
            Instead, add a new one of the type you chose (it is recorded from the day you add it), and:
          </p>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            <li>
              if the account itself changed, close this one: every day before it closed keeps it as it was.{' '}
              <button className="link-btn" onClick={onClose} disabled={disabled} aria-haspopup="dialog">
                Close this account…
              </button>
            </li>
            <li style={{ marginTop: 6 }}>
              if it was entered as the wrong type from the start, hide this one: hiding takes it out of every day, earlier
              ones too, so no day counts it the wrong way, and Unhide brings it back.{' '}
              <button className="link-btn" onClick={onHide} disabled={disabled}>
                Hide this account
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
