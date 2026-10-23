import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import OwedFlipNote, { crossesOwed, OWED_FLIP_REASON } from '@/components/OwedFlipNote';
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

  test('says why, either way, and offers to close the account or to hide it, saying what each does', () => {
    const none = () => {};
    const toOwed = text(renderToStaticMarkup(<OwedFlipNote crossing toOwed onClose={none} onHide={none} />));
    expect(toOwed).toBe(
      'This account counts as money held, and a card or a loan as money owed. Its type can’t change between them, so this can’t be saved: every past balance of it would count the other way. Instead, add a new one of the type you chose (it is recorded from the day you add it), and: if the account itself changed, close this one: every day before it closed keeps it as it was. Close this account… if it was entered as the wrong type from the start, hide this one: hiding takes it out of every day, earlier ones too, so no day counts it the wrong way, and Unhide brings it back. Hide this account'
    );
    const toHeld = text(renderToStaticMarkup(<OwedFlipNote crossing toOwed={false} onClose={none} onHide={none} />));
    expect(toHeld.startsWith('This account counts as money owed, and the type you chose as money held.')).toBe(true);
    expect(renderToStaticMarkup(<OwedFlipNote crossing toOwed onClose={none} onHide={none} disabled />).match(/disabled=""/g)).toHaveLength(2);
  });

  test('is said in a live region that is always there, under the id the type and Save point at', () => {
    const none = () => {};
    // Not crossing: the region alone, empty, so what comes into it is announced.
    expect(renderToStaticMarkup(<OwedFlipNote crossing={false} toOwed onClose={none} onHide={none} />)).toBe('<div aria-live="polite"></div>');
    const html = renderToStaticMarkup(<OwedFlipNote crossing toOwed onClose={none} onHide={none} />);
    expect(html.startsWith('<div aria-live="polite"><div class="panel-note owed-flip-note" id="' + OWED_FLIP_REASON + '">')).toBe(true);
    expect(html).toContain('aria-haspopup="dialog"');
  });

  test('the Update form points its type and Save at it while it shows', async () => {
    const source = await Bun.file(new URL('../components/Dashboard.tsx', import.meta.url)).text();
    expect(source.match(/aria-describedby=\{manualCrossing \? OWED_FLIP_REASON : undefined\}/g)).toHaveLength(2);
    expect(source).toMatch(/<OwedFlipNote\s+crossing=\{manualCrossing\}/);
  });
});
