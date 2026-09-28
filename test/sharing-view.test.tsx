import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SharingSettingsView, SharedWithMeView } from '@/components/Sharing';

const noop = () => {};
const settings = (data: any, draft: Record<string, any> = {}, invite: any = null, error = '') =>
  renderToStaticMarkup(
    <SharingSettingsView
      data={data}
      selected="c1"
      draft={draft}
      labelDraft="Pat"
      invite={invite}
      busy={false}
      error={error}
      notice=""
      onSelect={noop}
      onChoose={noop}
      onLabel={noop}
      onInvite={noop}
      onSave={noop}
      onRemove={noop}
    />
  );

describe('the sharing settings', () => {
  test('show a load error rather than nothing', () => {
    expect(settings(null, {}, null, 'Could not load sharing.')).toContain('Could not load sharing.');
  });

  test('render nothing with the shared password', () => {
    expect(settings(null)).toBe('');
    expect(settings({ enabled: false })).toBe('');
  });

  test('with no connections: only the way to invite someone, and nobody listed', () => {
    const html = settings({ enabled: true, connections: [], blocked: [], accounts: [{ id: 'a', label: 'Checking' }] });
    expect(html).toContain('Make an invite link');
    expect(html).toContain('No connections yet.');
    expect(html).not.toContain('Checking');
  });

  test('a new link, to send yourself, with when it stops working', () => {
    const html = settings({ enabled: true, connections: [], accounts: [] }, {}, { url: 'https://nya.test/connect/abc', expires_at: '2026-10-01T00:00:00Z' });
    expect(html).toContain('value="https://nya.test/connect/abc"');
    expect(html).toContain('It works once, until');
  });

  test('a connection: what they see about me, each account with its level, remove and block', () => {
    const html = settings(
      { enabled: true, connections: [{ id: 'c1', label: 'Pat', introduced_as: 'Patricia', since: '2026-09-28', sharing: { a: 'exists', hidden_one: 'balance' } }], blocked: [{ id: 'c9', label: 'Ex' }], accounts: [{ id: 'a', label: 'Chase Checking ••1111' }] },
      { a: 'exists' }
    );
    expect(html).toContain('Pat can see 1 of your accounts'); // a paused share on a hidden account isn't counted
    expect(html).toContain('They introduced themselves as “Patricia”. Connected 2026-09-28.');
    expect(html).toContain('Chase Checking ••1111');
    expect(html).toContain('<option value="exists" selected="">That it exists</option>');
    expect(html).toContain('>Remove<');
    expect(html).toContain('>Block<');
    expect(html).toContain('Ex');
    expect(html).toContain('>Unblock<');
  });

  test('says when a connection sees nothing of mine', () => {
    const html = settings({ enabled: true, connections: [{ id: 'c1', label: 'Pat', introduced_as: null, since: '2026-09-28', sharing: {} }], accounts: [] });
    expect(html).toContain('Pat can’t see any of your accounts.');
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
              connection: 'c1',
              label: 'Olive',
              accounts: [
                { id: 'a', label: 'Joint ••1111', level: 'transactions', balance: 500, as_of: '2026-09-27', debt: false, transactions: [{ date: '2026-09-25', name: 'Blue Bottle', amount: 12, pending: false }] },
                { id: 'b', label: 'House', level: 'balance', balance: null, as_of: null, debt: false },
                { id: 'c', label: 'Visa ••9999', level: 'balance', balance: 250, as_of: '2026-09-26', debt: true },
                { id: 'd', label: 'Savings', level: 'exists', balance: null, as_of: null, debt: false },
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
    expect(html).toContain('Balance not shared');
    expect(html).not.toMatch(/500\.00 owed/);
  });
});
