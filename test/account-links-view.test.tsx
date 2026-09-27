import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountLinksView, type AccountLinksPayload } from '@/components/AccountLinks';

const noop = () => {};
const view = (data: AccountLinksPayload | null, picked: Record<string, string> = {}) =>
  renderToStaticMarkup(
    <AccountLinksView data={data} busy={false} error="" preview={null} picked={picked} onPreview={noop} onPick={noop} onAct={noop} />
  );

describe('AccountLinksView', () => {
  test('renders nothing when there is nothing to decide or undo', () => {
    expect(view(null)).toBe('');
    expect(view({ suggestions: [], unclaimed: [], links: [] })).toBe('');
  });

  test('shows a suggestion with its evidence and both choices', () => {
    const html = view({
      suggestions: [
        {
          old: 'A7',
          to: 'A19',
          old_label: 'Capital One Quicksilver ••1234',
          to_label: 'Capital One Quicksilver ••1234',
          evidence: { persistent_match: false, old_last: '2026-07-16', old_last_balance: 850, new_first: '2026-07-17', new_first_balance: 860 },
        },
      ],
      unclaimed: [],
      links: [],
    });
    expect(html).toContain('Same account?');
    expect(html).toContain('Last balance $850.00, first balance $860.00.');
    expect(html).toContain('Link history');
    expect(html).toContain('Not the same');
  });

  test('offers balance-only history with a choice of account, and lists links with Unlink', () => {
    const html = view({
      suggestions: [],
      unclaimed: [{ old: 'A7', old_label: null, first: '2026-07-12', last: '2026-07-16', last_balance: 850, candidates: [{ id: 'A19', label: 'Capital One Quicksilver ••1234' }] }],
      links: [{ old: 'A11', to: 'A15', linked_at: 'x', old_label: 'A11', to_label: 'Vanguard IRA ••1111', conflict: true }],
    });
    expect(html).toContain('isn&#x27;t attached to any current account');
    expect(html).toContain('None of these');
    expect(html).toContain('<option value="A19"');
    expect(html).toContain('Unlink');
    expect(html).toContain('this link is paused');
  });

  // A pick that is no longer offered (after Not this one) must not be what
  // the buttons act on while the dropdown shows another account.
  test('falls back to an offered account when the pick is no longer offered', () => {
    const html = view(
      {
        suggestions: [],
        unclaimed: [{ old: 'A7', old_label: null, first: '2026-07-12', last: '2026-07-16', last_balance: 850, candidates: [{ id: 'A19', label: 'Card' }] }],
        links: [],
      },
      { A7: 'dismissed-one' }
    );
    expect(html).toContain('<option value="A19" selected="">');
  });

  // Collapsed until asked for: it lists every earlier account, so it must not
  // nag the way an offer does.
  test('offers linking by hand, collapsed, and shows what a link carried over', () => {
    const html = view({
      suggestions: [],
      unclaimed: [],
      manual: [{ old: 'A7', old_label: 'Chase Checking ••4821', first: '2024-01-01', last: '2025-06-30', last_balance: 10, candidates: [{ id: 'A19', label: 'Chase Checking ••4821' }] }],
      links: [
        { old: 'A11', to: 'A15', linked_at: 'x', old_label: 'Old', to_label: 'New', conflict: false, categories: { total: 431, carried: 412 } },
        { old: 'A12', to: 'A16', linked_at: 'x', old_label: 'Old2', to_label: 'New2', conflict: false, categories: { total: 1, carried: 1 } },
      ],
    });
    expect(html).toContain('Link an earlier account by hand');
    expect(html).not.toContain('Same account as');
    expect(html).toContain('412 of 431 categorized transactions carried over so far');
    expect(html).toContain('1 of 1 categorized transaction carried over<');
  });

  test('shows the card for linking by hand alone', () => {
    expect(view({ suggestions: [], unclaimed: [], links: [], manual: [] })).toBe('');
    expect(view({ suggestions: [], unclaimed: [], links: [], manual: [{ old: 'A7', old_label: null, first: 'x', last: 'y', last_balance: null, candidates: [{ id: 'A19', label: 'C' }] }] })).toContain('Reconnected accounts');
  });

  test('lists unreadable links with Remove', () => {
    const html = view({ suggestions: [], unclaimed: [], links: [], broken: ['A7'] });
    expect(html).toContain('can&#x27;t be read');
    expect(html).toContain('Remove');
  });
});
