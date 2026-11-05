import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, FakeElement, FakeNode } from './mini-dom';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import type { LawPart, PartialLaw } from '@/lib/fire/tax/law/types';
import { lawAttention, lawCard, lawDue, taxCalculatorDue } from '@/lib/law-card';

// The tax law tables by date: the admin page's Tax law card, its row in Needs
// attention, and what the weekly upkeep issue lists. The dates are the tests':
// the real tables gain parts as they come out, so each date's answer here comes
// from tables made for it.

const dom = installDom();
afterAll(() => dom.uninstall());
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { act } = await import('react');
const { TaxLaw } = await import('@/components/AdminPage');

/** A year's table, lacking these parts, each with the day its window opens. */
function table(year: number, missing: Partial<Record<LawPart, string>> = {}): PartialLaw {
  const law = { ...LAW_2026, year, sources: { ...LAW_2026.sources } } as PartialLaw;
  for (const [part, opens] of Object.entries(missing) as [LawPart, string][]) {
    delete law[part];
    law.sources[part] = { source: `The ${part} notice`, published: null, due: `Late ${year - 1}`, opens };
  }
  return law;
}

const ON_THEIR_WAY = { brackets: '2026-10-01', medicare: '2026-11-01', medicaidPoverty: '2027-01-01' };
const YEARS = [table(2026), table(2027, ON_THEIR_WAY)];
const JANUARY_ONLY = [table(2026), table(2027, { medicaidPoverty: '2027-01-01' })];
const row = (card: ReturnType<typeof lawCard>, year: number) => card.years.find((y) => y.year === year)!;

describe('the card', () => {
  test('the year in use, then one on its way, a neutral badge until December 1', () => {
    const card = lawCard('2026-11-04', YEARS);
    expect(card.years.map((y) => y.year)).toEqual([2026, 2027]);
    expect(row(card, 2026)).toMatchObject({ title: '2026 tax law', sub: 'In use · every part in, each with its source', badge: null });
    expect(row(card, 2027)).toMatchObject({ title: '2027 tax law', sub: '8 of 11 parts in · still to come: brackets, Medicaid’s poverty guidelines and Medicare', badge: { text: 'Due by Jan 1', caution: false } });
    expect(card.attention).toBeNull();
  });

  test('on December 1 the badge turns to a caution and Needs attention says so, naming only what was due by then', () => {
    expect(row(lawCard('2026-11-30', YEARS), 2027).badge).toEqual({ text: 'Due by Jan 1', caution: false });
    expect(lawAttention('2026-11-30', YEARS)).toBeNull();
    const card = lawCard('2026-12-01', YEARS);
    expect(row(card, 2027).badge).toEqual({ text: 'Due by Jan 1', caution: true });
    expect(card.attention).toEqual({ title: '2027 tax law is due by January 1', sub: 'Still to come: brackets and Medicare. Worked-out tax stays on 2026’s until every part is in.' });
  });

  test('Medicaid’s poverty guidelines come out in January, so they alone don’t make it late', () => {
    const card = lawCard('2026-12-15', JANUARY_ONLY);
    expect(row(card, 2027).badge).toEqual({ text: 'Due in January', caution: false });
    expect(card.attention).toBeNull();
  });

  test('a year begun with its table not whole is behind, and the law in use stays the last whole one', () => {
    const card = lawCard('2027-01-02', JANUARY_ONLY);
    expect(row(card, 2026).sub).toStartWith('In use');
    expect(row(card, 2027).badge).toEqual({ text: 'Behind', caution: true });
    expect(card.attention).toEqual({ title: '2027 tax law isn’t all in', sub: 'Still to come: Medicaid’s poverty guidelines. Worked-out tax stays on 2026’s until every part is in.' });
  });

  test('a whole year before it begins, and in use once it has, the one before then gone', () => {
    const whole = [table(2026), table(2027)];
    const autumn = lawCard('2026-11-04', whole);
    expect(row(autumn, 2027)).toMatchObject({ sub: 'Every part in, each with its source · in use from January 1, 2027', badge: null });
    expect(autumn.attention).toBeNull();
    const after = lawCard('2027-01-02', whole);
    expect(after.years.map((y) => y.year)).toEqual([2027]);
    expect(row(after, 2027).sub).toStartWith('In use');
  });

  test('from about July a year wants a table: a row with nothing to open, a caution on December 1', () => {
    const only = [table(2026)];
    expect(lawCard('2026-06-30', only).years.map((y) => y.year)).toEqual([2026]);
    const july = row(lawCard('2026-07-01', only), 2027);
    expect(july).toEqual({ year: 2027, title: '2027 tax law', sub: 'No table yet', badge: { text: 'Due by Jan 1', caution: false }, parts: [] });
    expect(row(lawCard('2026-12-01', only), 2027).badge).toEqual({ text: 'Due by Jan 1', caution: true });
    expect(lawAttention('2026-12-01', only)).toEqual({ title: '2027 tax law is due by January 1', sub: 'No table yet. Worked-out tax stays on 2026’s until every part is in.' });
    expect(lawAttention('2027-01-02', only)).toEqual({ title: 'No 2027 tax law table', sub: 'Worked-out tax stays on 2026’s until every part is in.' });
  });

  test('a year’s parts: those to come first, with when, the rest with their source and date', () => {
    const parts = row(lawCard('2026-11-04', YEARS), 2027).parts;
    expect(parts).toHaveLength(11);
    expect(parts.slice(0, 3).map((p) => p.part)).toEqual(['brackets', 'medicaidPoverty', 'medicare']);
    expect(parts[0]).toEqual({ part: 'brackets', name: 'Brackets, standard deduction and gains bands', source: 'The brackets notice', when: 'Expected Late 2026' });
    expect(parts.find((p) => p.part === 'aca')).toEqual({ part: 'aca', name: 'ACA applicable percentages', source: 'Rev. Proc. 2025-25, sec. 3.01', when: 'Published Jul 18, 2025' });
  });

  test('the real tables say the same of the year in use', () => {
    const card = lawCard('2026-11-04');
    expect(row(card, 2026).sub).toBe('In use · every part in, each with its source');
    expect(row(card, 2027).parts).toHaveLength(11);
  });
});

describe('what the upkeep issue lists', () => {
  const keys = (today: string, years: readonly PartialLaw[] = YEARS) => lawDue(today, years).map((d) => d.key);

  test('a part once its window has opened, not before', () => {
    expect(keys('2026-09-30')).toEqual([]);
    expect(keys('2026-10-01')).toEqual(['law-2027-brackets']);
    expect(keys('2026-11-01')).toEqual(['law-2027-brackets', 'law-2027-medicare']);
    expect(lawDue('2026-10-01', YEARS)[0]).toEqual({ key: 'law-2027-brackets', name: '2027: Brackets, standard deduction and gains bands', about: 'Expected Late 2026, from The brackets notice.' });
  });

  test('a law year needed by January 1 and not complete by December 1, once', () => {
    expect(keys('2026-12-01')).toEqual(['law-2027-brackets', 'law-2027-medicare', 'law-year']);
    expect(keys('2026-12-01', JANUARY_ONLY)).toEqual([]);
    expect(keys('2027-01-01', JANUARY_ONLY)).toEqual(['law-2027-medicaidPoverty', 'law-year']);
  });

  test('a year with no table, from about July', () => {
    expect(keys('2026-06-30', [table(2026)])).toEqual([]);
    expect(keys('2026-07-01', [table(2026)])).toEqual(['law-2027-table']);
    expect(lawDue('2026-07-01', [table(2026)])[0].about).toContain('lib/fire/tax/law/2027.ts');
  });

  test('the health growth default from June after the projections it rests on', () => {
    const whole = [table(2026), table(2027)];
    expect(LAW_2026.sources.healthGrowth.published).toStartWith('2026-');
    expect(keys('2027-05-31', whole)).not.toContain('law-health-growth');
    expect(keys('2027-06-01', whole)).toContain('law-health-growth');
    const newer = table(2027);
    newer.sources.healthGrowth = { ...newer.sources.healthGrowth, published: '2027-06-17' };
    expect(keys('2027-06-20', [table(2026), newer])).not.toContain('law-health-growth');
    expect(keys('2028-06-01', [table(2026), newer])).toContain('law-health-growth');
  });

  test('Tax-Calculator’s pin once a complete year passes it, not for one still lacking parts', () => {
    expect(taxCalculatorDue(2026, YEARS)).toBeNull();
    expect(taxCalculatorDue(2027, [table(2026), table(2027)])).toBeNull();
    expect(taxCalculatorDue(2026, [table(2026), table(2027)])).toMatchObject({ key: 'law-tax-calculator', about: expect.stringContaining('2027') });
  });

  test('its words have no day of the run in them', () => {
    const a = lawDue('2026-12-01', YEARS);
    const b = lawDue('2026-12-08', YEARS);
    expect(b).toEqual(a);
    for (const d of a) expect(`${d.name} ${d.about}`).not.toMatch(/[–—]/);
  });
});

describe('the card, drawn', () => {
  const has = (e: FakeNode | null, cls: string) => e instanceof FakeElement && (e.getAttribute('class') ?? '').split(' ').includes(cls);
  const part = (el: FakeElement, cls: string) => el.findAll((e) => has(e, cls))[0] ?? null;

  async function mount(today: string, years: readonly PartialLaw[]) {
    const container = dom.document.createElement('div');
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(<TaxLaw law={lawCard(today, years)} />));
    const el = container as unknown as FakeElement;
    return { el, dialog: () => el.findAll((e) => e.getAttribute('role') === 'dialog')[0] ?? null, unmount: () => act(async () => root.unmount()) };
  }

  test('a year opens a sheet of its parts, its badge in its row', async () => {
    const tab = await mount('2026-12-01', YEARS);
    expect(tab.el.findAll((e) => e.tagName === 'SECTION')[0].getAttribute('id')).toBe('tax-law');
    expect(tab.dialog()).toBeNull();
    const rows = tab.el.findAll((e) => e.tagName === 'BUTTON' && has(e, 'list-row'));
    expect(rows.map((r) => part(r, 'list-row-title')!.textContent)).toEqual(['2026 tax law', '2027 tax law']);
    expect(part(rows[0], 'badge')).toBeNull();
    const badge = part(rows[1], 'badge')!;
    expect(badge.textContent).toBe('Due by Jan 1');
    expect(has(badge, 'warn')).toBe(true);
    await act(async () => {
      rows[1].focus();
      click(rows[1]);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const sheet = tab.dialog()!;
    expect(sheet.textContent).toContain('2027 tax law');
    expect(sheet.textContent).toContain('Brackets, standard deduction and gains bands');
    expect(sheet.textContent).toContain('The brackets notice · Expected Late 2026');
    expect(sheet.textContent).toContain('Published Jul 18, 2025');
    await tab.unmount();
  });

  test('neutral before December 1, and a year with no table has nothing to open', async () => {
    const quiet = await mount('2026-11-04', YEARS);
    expect(has(part(quiet.el.findAll((e) => e.tagName === 'BUTTON')[1], 'badge'), 'warn')).toBe(false);
    await quiet.unmount();
    const none = await mount('2026-07-01', [table(2026)]);
    expect(none.el.findAll((e) => e.tagName === 'BUTTON' && has(e, 'list-row'))).toHaveLength(1);
    expect(none.el.textContent).toContain('2027 tax law');
    expect(none.el.textContent).toContain('No table yet');
    await none.unmount();
  });
});
