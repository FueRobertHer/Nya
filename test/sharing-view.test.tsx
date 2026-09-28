import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SharingSettingsView, SharedWithMeView } from '@/components/Sharing';

const noop = () => {};
const settings = (data: any, draft: Record<string, any> = {}) =>
  renderToStaticMarkup(
    <SharingSettingsView data={data} person="user_partner" draft={draft} busy={false} error="" notice="" onPerson={noop} onChoose={noop} onSave={noop} />
  );

describe('the sharing settings', () => {
  test('show a load error rather than nothing', () => {
    const html = renderToStaticMarkup(
      <SharingSettingsView data={null} person="" draft={{}} busy={false} error="Could not load sharing." notice="" onPerson={noop} onChoose={noop} onSave={noop} />
    );
    expect(html).toContain('Could not load sharing.');
  });

  test('render nothing with the shared password', () => {
    expect(settings(null)).toBe('');
    expect(settings({ enabled: false })).toBe('');
  });

  test('say so when nobody else uses the app', () => {
    expect(settings({ enabled: true, people: [], accounts: [] })).toContain('Nobody else uses the app yet');
  });

  test('offer each of my accounts with its current choice', () => {
    const html = settings(
      { enabled: true, people: [{ id: 'user_partner', name: 'Pat' }], accounts: [{ id: 'a', label: 'Chase Checking ••1111' }] },
      { a: 'balance' }
    );
    expect(html).toContain('With Pat:');
    expect(html).toContain('Chase Checking ••1111');
    expect(html).toContain('<option value="balance" selected="">Balance</option>');
  });
});

describe('what others share with me', () => {
  test('renders nothing when nothing is shared', () => {
    expect(renderToStaticMarkup(<SharedWithMeView data={{ shared: [] }} />)).toBe('');
  });

  test('shows whose it is, each account and its balance, and transactions only behind a tap', () => {
    const html = renderToStaticMarkup(
      <SharedWithMeView
        data={{
          shared: [
            {
              from: 'user_owner',
              name: 'Olive',
              accounts: [
                { id: 'a', label: 'Joint ••1111', level: 'transactions', balance: 500, as_of: '2026-09-27', debt: false, transactions: [{ date: '2026-09-25', name: 'Blue Bottle', amount: 12, pending: false }] },
                { id: 'b', label: 'House', level: 'balance', balance: null, as_of: null, debt: false },
                { id: 'c', label: 'Visa ••9999', level: 'balance', balance: 250, as_of: '2026-09-26', debt: true },
              ],
            },
          ],
        }}
      />
    );
    expect(html).toContain('Shared by Olive');
    expect(html).toContain('Joint ••1111');
    expect(html).toContain('No balance yet');
    expect(html).toContain('Recent transactions (1)');
    expect(html).not.toContain('Blue Bottle');
    expect(html).toContain('as of 2026-09-27');
    expect(html).toMatch(/250\.00 owed/);
    expect(html).not.toMatch(/500\.00 owed/);
  });
});
