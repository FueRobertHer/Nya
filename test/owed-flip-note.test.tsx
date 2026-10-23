import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import OwedFlipNote, { crossesOwed } from '@/components/OwedFlipNote';
import { MANUAL_TYPES } from '@/lib/manual';
import { isOwedType } from '@/lib/balance';

// What the Update form says in place of saving a type across money held and
// money owed (components/OwedFlipNote.tsx), which the server refuses
// (lib/manual-account-writes.ts OWED_FLIP).

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the Update form, asked to change an account between money held and money owed', () => {
  test('crosses only between the two sides, and never for a new account', () => {
    for (const from of MANUAL_TYPES) {
      for (const to of MANUAL_TYPES) expect([from, to, crossesOwed(from, to)]).toEqual([from, to, isOwedType(from) !== isOwedType(to)]);
    }
    expect(crossesOwed(null, 'credit')).toBe(false);
    expect(crossesOwed(undefined, 'credit')).toBe(false);
  });

  test('says why, either way, and offers to close the account instead', () => {
    const toOwed = text(renderToStaticMarkup(<OwedFlipNote toOwed onClose={() => {}} />));
    expect(toOwed).toBe(
      'This account counts as money held, and a card or a loan as money owed. Changing it between them would change how every past balance of it counts, so it can’t be saved. Instead, close this account and add a new one of the type you chose: every earlier day stays as it was, and the new one counts from the day you add it. Close this account…'
    );
    const toHeld = text(renderToStaticMarkup(<OwedFlipNote toOwed={false} onClose={() => {}} />));
    expect(toHeld.startsWith('This account counts as money owed, and the type you chose as money held.')).toBe(true);
    expect(renderToStaticMarkup(<OwedFlipNote toOwed onClose={() => {}} disabled />)).toContain('disabled');
  });
});
