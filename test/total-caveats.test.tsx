import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { totalCaveats, type TotalNoteInstitution } from '@/components/total-notes';
import TotalCaveats, { summaryText, type Caveat } from '@/components/TotalCaveats';
import { severityOf } from '@/lib/accounts-status';
import { CAUSES, type Cause, type ConnectionHealth } from '@/lib/connection-state';
import type { ConnectorIssue } from '@/lib/connectors/types';

// What qualifies the Home total (rollout phase 4a): each note's color, from
// the institutions it names as their cards have it, and the line that
// gathers the lesser ones.

const day = { snapshot: (d: string) => `snap ${d}`, instant: (iso: string) => `day ${iso.slice(5, 10)}` };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

const plaid = (cause: Cause): ConnectionHealth => ({ ...CAUSES[cause], cause, side: 'bank', last_ok_at: '2026-09-12T12:00:00Z' });
const connector = (issue: ConnectorIssue): ConnectionHealth => ({
  state: issue === 'waiting' ? 'partial' : 'needs_reauth',
  cause: 'connector',
  side: 'connector',
  action: 'none',
  last_ok_at: null,
  detail: { connector: 'simplefin', label: 'SimpleFIN', host: null, connection_id: 'c1', issue, messages: [], accounts: [] },
});

type Inst = TotalNoteInstitution & { item_id: string; connector?: string; accounts: NonNullable<TotalNoteInstitution['accounts']>; health?: ConnectionHealth };
const inst = (name: string, over: Partial<Inst> = {}): Inst => ({
  institution_name: name,
  item_id: name,
  error: null,
  needs_reauth: false,
  accounts: [{ balance: 100 }],
  ...over,
});
const caveats = (list: Inst[], hold?: Parameters<typeof totalCaveats>[2]) => totalCaveats(list, day, hold, severityOf).map((n) => [n.severity, n.summary]);

describe('each note’s color, from its institutions’ cards', () => {
  test('recovered balances: amber when it only couldn’t refresh, red when the person must act', () => {
    expect(caveats([inst('Chase', { error: 'Down', stale_as_of: '2026-09-12', health: plaid('institution_down') })])).toEqual([['caution', 'last known balances at Chase']]);
    expect(caveats([inst('Chase', { error: 'Login', needs_reauth: true, stale_as_of: '2026-09-12', health: plaid('login') })])).toEqual([['critical', 'last known balances at Chase']]);
  });

  test('a connection that must be connected again says only "couldn’t refresh", but is red, as its card', () => {
    const relink = inst('Chase', { error: 'Gone', stale_as_of: '2026-09-12', health: plaid('revoked') });
    const paying = inst('Bank', { manual: true, connector: 'simplefin', error: 'Pay SimpleFIN', stale_as_of: '2026-09-12', health: connector('payment') });
    expect(totalCaveats([relink], day, null, severityOf)[0]).toMatchObject({ text: "Chase couldn't refresh; its balances are from snap 2026-09-12", severity: 'critical' });
    expect(caveats([paying])).toEqual([['critical', 'last known balances at Bank']]);
  });

  test('several at once take the worst of them', () => {
    const down = inst('Ally', { error: 'Down', stale_as_of: '2026-09-12', health: plaid('institution_down') });
    const login = inst('Chase', { error: 'Login', needs_reauth: true, stale_as_of: '2026-09-12', health: plaid('login') });
    expect(caveats([down, login])).toEqual([['critical', 'last known balances at Ally and Chase']]);
  });

  test('a short total is red whatever: rows not shown, an account held with no balance', () => {
    expect(caveats([inst('Chase', { error: 'Down', stale_as_of: '2026-09-12', stale_missing: 2, health: plaid('institution_down') })])).toEqual([
      // Its card is red for the rows it can't show, so its other note is too.
      ['critical', 'last known balances at Chase'],
      ['critical', '2 accounts not shown'],
    ]);
    const held = inst('Ally', { unconfirmed_missing: 1, accounts: [{ balance: null, held: { as_of: null } }] });
    expect(caveats([held])).toEqual([['critical', '1 account stopped reporting']]);
    const heldAt = inst('Ally', { unconfirmed_missing: 1, accounts: [{ balance: 40, held: { as_of: '2026-09-01' } }] });
    expect(caveats([heldAt])).toEqual([['caution', '1 account stopped reporting']]);
    // Held at its last known balance, at a bank whose card is red because only
    // the person can fix it: red here too.
    const heldAtLogin = inst('Ally', { unconfirmed_missing: 1, health: plaid('login'), accounts: [{ balance: 40, held: { as_of: '2026-09-01' } }] });
    expect(severityOf(heldAtLogin)).toBe('critical');
    expect(caveats([heldAtLogin])).toEqual([['critical', '1 account stopped reporting']]);
  });

  test('not counted at all: red, but a new connection waiting for its first answer is amber, as on its card', () => {
    expect(caveats([inst('Chase', { error: 'Down', health: plaid('institution_down') })])).toEqual([['critical', 'Chase not counted']]);
    const waiting = inst('Bank', { manual: true, connector: 'simplefin', error: 'Waiting for SimpleFIN’s answer', accounts: [{ balance: null }], health: connector('waiting') });
    expect(caveats([waiting])).toEqual([['caution', 'Bank not counted']]);
  });

  test('a restore: a bank not connected is missing from the total, red; one not finished or unreadable, amber', () => {
    expect(caveats([], { unfinished: true, waiting: [{ institution_name: 'Chase', last: null }], unreadable: true })).toEqual([
      ['caution', 'a restore not finished'],
      ['critical', 'Chase not connected after a restore'],
      ['caution', "a restore can't be read"],
    ]);
  });
});

describe('the caveat line', () => {
  const c = (key: string, severity: Caveat['severity'], summary: string): Caveat => ({ key, severity, summary, body: `${summary}, said in full.` });

  test('nothing to say: nothing on the page', () => {
    expect(renderToStaticMarkup(<TotalCaveats items={[]} />)).toBe('');
  });

  test('critical ones in full, in red, never gathered; one lesser one in full in its color', () => {
    const html = renderToStaticMarkup(<TotalCaveats items={[c('a', 'critical', 'Chase not counted'), c('b', 'critical', '2 accounts not shown'), c('c', 'info', 'converted into USD')]} />);
    expect(html.match(/class="notice critical"/g)).toHaveLength(2);
    expect(html).toContain('<div class="notice info">');
    expect(html).not.toContain('<details');
    expect(text(html)).toContain('Chase not counted, said in full.');
  });

  test('two or more lesser ones: one line with how many and of what, in the worst color, every one still in the page', () => {
    const html = renderToStaticMarkup(<TotalCaveats items={[c('a', 'info', 'converted into USD'), c('b', 'caution', 'history paused'), c('c', 'info', 'accounts with no currency')]} />);
    expect(html).toContain('<details class="notice-summary"><summary class="notice caution">');
    // The worst kind named first (rollout.md "Decided in 4c"), so an amber line names what made it amber.
    expect(text(html)).toContain('3 notes: history paused, converted into USD and accounts with no currency');
    for (const s of ['converted into USD', 'history paused', 'accounts with no currency']) expect(text(html)).toContain(`${s}, said in full.`);
    // Each in its own color inside.
    expect(html).toContain('<div class="notice info">');
    expect(html).toContain('<div class="notice caution">');
  });

  test('a note that explains itself keeps one line, the rest behind Why?, alone or gathered with others', () => {
    const accrued: Caveat = { ...c('a', 'info', 'accrued interest left out'), body: 'Leaves out $612.40 of accrued interest on a student loan.', why: 'Plaid reports it apart.' };
    const alone = renderToStaticMarkup(<TotalCaveats items={[accrued]} />);
    expect(alone).toContain('Leaves out $612.40 of accrued interest on a student loan.<details class="why"><summary>Why?</summary><div class="why-body">Plaid reports it apart.</div></details>');
    const gathered = renderToStaticMarkup(<TotalCaveats items={[accrued, c('b', 'caution', 'history paused')]} />);
    expect(gathered).toContain('<details class="why"><summary>Why?</summary><div class="why-body">Plaid reports it apart.</div></details>');
    // One without its own Why says it all in its body, as before.
    expect(gathered.match(/class="why"/g)).toHaveLength(1);
  });

  test('only neutral ones: the line is neutral too', () => {
    const html = renderToStaticMarkup(<TotalCaveats items={[c('a', 'info', 'converted into USD'), c('b', 'info', 'accrued interest left out')]} />);
    expect(html).toContain('<summary class="notice info">');
  });

  test('the same kind twice is named once, the count still every note', () => {
    expect(summaryText([c('a', 'caution', 'accrued interest not known'), c('b', 'caution', 'accrued interest not known'), c('c', 'caution', 'old exchange rates')])).toBe(
      '3 notes: accrued interest not known and old exchange rates'
    );
  });

  test('more than three kinds: the first three and how many more', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((k) => c(k, 'caution', `kind ${k}`));
    expect(summaryText(items)).toBe('5 notes: kind a, kind b, kind c and 2 more');
  });
});
