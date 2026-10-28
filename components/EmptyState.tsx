'use client';

// What a card says while it has nothing in it yet (docs/design/design-system.md
// "Empty state"; the screen review after step 5): a heading, one line of
// helper text, and one primary action, the first step, so an empty screen
// leads somewhere. What must still be said there (an error, a note on the
// figures) goes between the line and the action, in its own words. The
// caller supplies the card around it, so it can stand alone (Budgets' empty
// month) or sit in a card that holds more (Goals, Shared expenses).

import type { ReactNode, Ref } from 'react';

export type EmptyAction = {
  label: string;
  onSelect: () => void;
  /** It opens a sheet (aria-haspopup). */
  opens?: boolean;
  /** Where a closing sheet can give focus back. */
  ref?: Ref<HTMLButtonElement>;
};

export default function EmptyState({
  title,
  line,
  action,
  heading = 'h3',
  id,
  children,
}: {
  title: string;
  /** One line of helper text: what it is for. */
  line: string;
  action: EmptyAction;
  /** h3 under a bar's heading (Budgets), h2 where the card's is the panel's
   *  first (Activity's Shared). */
  heading?: 'h2' | 'h3';
  /** The heading's id, for the card's aria-labelledby. */
  id?: string;
  /** What must still be said, between the line and the action. */
  children?: ReactNode;
}) {
  const Heading = heading;
  return (
    <div className="empty-state">
      <Heading id={id}>{title}</Heading>
      <p className="helper">{line}</p>
      {children}
      <button type="button" className="btn" ref={action.ref} aria-haspopup={action.opens ? 'dialog' : undefined} onClick={action.onSelect}>
        {action.label}
      </button>
    </div>
  );
}
