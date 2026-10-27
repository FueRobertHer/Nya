import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DemoDataView, shownScenario, type DemoInfo } from '@/components/DemoDataCard';

const noop = () => {};
const INFO: Extract<DemoInfo, { demo: true }> = {
  demo: true,
  scenarios: [
    { id: 'single-renter', title: 'Single renter', description: 'One income and a rented flat.' },
    { id: 'household', title: 'Two-income household', description: 'Two incomes and a child.' },
  ],
  default: 'household',
  last: null,
  next_in_seconds: 0,
  window_minutes: 10,
};
const view = (info: DemoInfo | null, more: Partial<{ chosen: string | null; busy: boolean; error: string | null; done: string | null }> = {}) =>
  renderToStaticMarkup(<DemoDataView info={info} chosen={null} busy={false} error={null} done={null} onChoose={noop} onAsk={noop} {...more} />);

describe('DemoDataView', () => {
  test('nothing for anyone but a demo account, nor before the route has said', () => {
    expect(view(null)).toBe('');
    expect(view({ demo: false })).toBe('');
  });

  test('says why, offers the scenarios with the account’s own chosen, and the reset', () => {
    const html = view(INFO);
    expect(html).toContain('<h2>Demo data</h2>');
    expect(html).toContain('can’t bring a download back');
    expect(html).toContain('<option value="household" selected="">Two-income household</option>');
    expect(html).toContain('Two incomes and a child.');
    expect(html).toMatch(/<button type="button" class="btn secondary">Reset demo data<\/button>/);
    expect(html).not.toContain('notice');
  });

  test('shows the scenario picked, else the last reset’s', () => {
    expect(shownScenario(INFO, 'single-renter').id).toBe('single-renter');
    expect(shownScenario({ ...INFO, last: { scenario: 'single-renter', at: 'x', phase: 'finished' } }, null).id).toBe('single-renter');
    expect(shownScenario({ ...INFO, default: 'gone' }, null).id).toBe('single-renter');
  });

  test('a reset that stopped part way is a caution, until another runs', () => {
    const stopped = { ...INFO, last: { scenario: 'household', at: 'x', phase: 'stopped' as const } };
    const html = view(stopped);
    expect(html).toContain('notice caution');
    expect(html).toContain('The last reset stopped part way, so some of this account may be missing. Reset it again to finish.');
    expect(view(stopped, { busy: true })).not.toContain('stopped part way');
  });

  test('inside the window it says when, and the reset waits', () => {
    const html = view({ ...INFO, next_in_seconds: 61 });
    expect(html).toContain('Demo accounts can be reset once every 10 minutes. This one can be reset again in 2 minutes.');
    expect(html).toMatch(/<button type="button" class="btn secondary" disabled="">Reset demo data<\/button>/);
    expect(view({ ...INFO, next_in_seconds: 30 })).toContain('This one can be reset again in 1 minute.');
  });

  test('a reset someone else is running is said, not taken for one that stopped', () => {
    const html = view({ ...INFO, last: { scenario: 'household', at: 'x', phase: 'running' }, next_in_seconds: 590 });
    expect(html).toContain('notice info');
    expect(html).toContain('This account is being reset now, so some of it may be missing. Load the page again in a minute.');
    expect(html).not.toContain('stopped part way');
    expect(html).not.toContain('can be reset again in');
    expect(html).toMatch(/class="btn secondary" disabled="">Reset demo data/);
  });

  test('why it can’t be reset, when it can’t', () => {
    const html = view({ ...INFO, refused: 'Alex’s data belongs to another sign-in too, so it isn’t replaced.' });
    expect(html).toContain('notice caution');
    expect(html).toContain('belongs to another sign-in too');
    expect(html).toMatch(/class="btn secondary" disabled="">Reset demo data/);
  });

  test('says what happened: done, or why not', () => {
    expect(view(INFO, { done: 'Reset to Two-income household.' })).toContain('notice done');
    const html = view(INFO, { error: 'This demo account was reset in the last 10 minutes. Try again in 4 minutes.' });
    expect(html).toContain('notice critical');
    expect(html).toContain('Try again in 4 minutes.');
  });

  test('nothing can be changed while a reset runs', () => {
    const html = view(INFO, { busy: true });
    expect(html).toContain('<select disabled="">');
    expect(html).toMatch(/class="btn secondary" disabled="">Reset demo data/);
  });
});
