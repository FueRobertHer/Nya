import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MASK, setAmountsHidden } from '@/lib/format';
import { InventoryView, figures, encryptionText, keyText, sizeText, backupText, type Inventory, type InventoryRow } from '@/components/DataInventory';
import { AdminStorageView, sortContainers, itemState, ofCeiling, utcDay, SORTS, type AdminContainer, type AdminPage } from '@/components/AdminStorage';
import InventoryEntry from '@/components/InventoryEntry';

// The pages of Your data and of storage across accounts, drawn: figures in
// words, what couldn't be read said in place of a number, the kinds with
// nothing stored folded away, sorting, and hide amounts leaving counts and
// sizes alone, since they are no amounts.

/** The page as text: tags dropped, the entities React writes decoded, spaces collapsed. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

/** As in a browser's page: only there can amounts be hidden. */
function inBrowser<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const none = g.window === undefined;
  if (none) g.window = {};
  try {
    return fn();
  } finally {
    setAmountsHidden(false);
    if (none) delete g.window;
  }
}

const base: InventoryRow = {
  id: 'history:net-worth',
  name: 'Your net worth, one total for each day Nya recorded it',
  about: null,
  where: 'yours',
  status: 'read',
  count: 1234,
  unit: ['day', 'days'],
  chars: 3 * 1024 * 1024 + 200_000,
  encryption: { kind: 'encrypted', own: 0, shared: 1234, unclear: 0, not_ciphertext: 0, unchecked: 0 },
  download: { included: true, text: 'In your download, under net_worth_history (recorded).' },
  backed_up: true,
  kept: ['Your data'],
  kept_detail: null,
  seen: ['Programs you give an API token to'],
  plain: 'The days with a balance, as field names.',
};
const row = (over: Partial<InventoryRow>): InventoryRow => ({ ...base, ...over });

const inv: Inventory = {
  as_of: '2026-10-22T12:00:00.000Z',
  key: { own: true, since: '2026-02-01T00:00:00.000Z', moved: null },
  measured: true,
  backups: 'kept',
  groups: [
    {
      id: 'history',
      title: 'Balances and history',
      rows: [
        base,
        row({ id: 'history:accounts', name: 'Each account’s balance on each recorded day', status: 'unreadable', count: null, chars: null }),
        row({ id: 'holdings:history', name: 'Your holdings on each recorded day', count: 0, chars: 0 }),
        row({ id: 'timeline-notes', name: 'Notes on your timeline', count: 0, chars: 0 }),
      ],
    },
  ],
  unknown: { keys: 2, chars: 5 },
  elsewhere: [row({ id: 'ratelimit:', name: 'Failed sign-ins', where: 'environment', status: 'not-counted', count: null, chars: null, encryption: { kind: 'plain' } })],
};

describe('Your data, in words', () => {
  test('a count and a size, or why there is none: never a zero for what couldn’t be read', () => {
    expect(figures(base)).toBe('1,234 days, 3.2 MB');
    expect(figures(row({ count: 1, chars: 1 }))).toBe('1 day, 1 byte');
    expect(figures(row({ count: 0, chars: 0 }))).toBe('0 days, 0 bytes');
    expect(figures(row({ status: 'unreadable', count: null, chars: null }))).toBe('Couldn’t be read just now');
    expect(figures(row({ status: 'not-counted', count: null, chars: null }))).toBe('Not counted here');
    expect(figures(row({ where: 'environment', count: 3, chars: null }))).toBe('3 days');
    expect([sizeText(1023), sizeText(2048), sizeText(5 * 1024 * 1024)]).toEqual(['1,023 bytes', '2 KB', '5.0 MB']);
  });

  test('which key, as each value claims it', () => {
    expect(encryptionText(row({ encryption: { kind: 'plain' } }))).toBe('No: kept as plain text.');
    expect(encryptionText(row({ encryption: { kind: 'token' } }))).toContain('The token that reaches each bank is encrypted');
    expect(encryptionText(row({ encryption: { kind: 'wrapped' } }))).toContain('locked by the master key');
    expect(encryptionText(row({ encryption: { kind: 'encrypted', own: 0, shared: 0, unclear: 0, not_ciphertext: 0, unchecked: 0 } }))).toBe('Yes, whenever any is stored.');
    expect(encryptionText(row({ encryption: { kind: 'encrypted', own: 4, shared: 0, unclear: 0, not_ciphertext: 0, unchecked: 0 } }))).toBe('Yes, with your account’s own key.');
    expect(encryptionText(base)).toBe('Yes, with a key this copy of Nya shares between accounts.');
    expect(encryptionText(row({ encryption: { kind: 'encrypted', own: 3, shared: 0, unclear: 0, not_ciphertext: 0, unchecked: 2 } }))).toBe(
      'Yes: 3 with your account’s own key; 2 not looked at here, for their size.'
    );
    expect(encryptionText(row({ encryption: { kind: 'encrypted', own: 2, shared: 1, unclear: 1, not_ciphertext: 1, unchecked: 0 } }))).toBe(
      'Yes: 2 with your account’s own key; 1 with a key this copy of Nya shares; 1 with a key whose id can’t be read; 1 that don’t look encrypted, so can’t be read.'
    );
  });

  test('the nightly backups, as this copy keeps them', () => {
    expect(backupText(base, 'kept')).toBe('Copied into each one, as it is stored.');
    expect(backupText(row({ backed_up: false }), 'kept')).toBe('Left out of them.');
    expect(backupText(base, 'none')).toBeNull();
    expect(backupText(base, 'invalid')).toContain('retention setting is not valid');
    expect(text(renderToStaticMarkup(<InventoryView inv={{ ...inv, backups: 'none' }} />))).toContain('This copy of Nya takes no nightly backups.');
    expect(text(renderToStaticMarkup(<InventoryView inv={{ ...inv, backups: 'none' }} />))).not.toContain('Nightly backups Copied');
    // Vercel stores backups only where they are taken.
    expect(text(renderToStaticMarkup(<InventoryView inv={inv} />))).toContain('keeps the app’s logs, and stores the nightly backups.');
    expect(text(renderToStaticMarkup(<InventoryView inv={{ ...inv, backups: 'none' }} />))).toContain('keeps the app’s logs. The Security page');
  });

  test('the data key', () => {
    expect(keyText(null)).toContain('couldn’t be read just now');
    expect(keyText({ own: false, since: null, moved: null })).toContain('doesn’t have a key of its own');
    expect(keyText({ own: true, since: '2026-02-01T00:00:00.000Z', moved: '2026-03-01T00:00:00.000Z' })).toContain('has been under it since');
    expect(keyText({ own: true, since: '2026-02-01T00:00:00.000Z', moved: null })).toContain('may still be under a key this copy of Nya shares');
  });

  test('every kind is drawn: what holds something at once, what holds nothing folded away, and what couldn’t be read said so', () => {
    const page = text(renderToStaticMarkup(<InventoryView inv={inv} />));
    expect(page).toContain('Your net worth, one total for each day Nya recorded it 1,234 days, 3.2 MB');
    expect(page).toContain('Each account’s balance on each recorded day Couldn’t be read just now');
    expect(page).toContain('Nothing stored of 2 more kinds');
    expect(page).toContain('Your holdings on each recorded day 0 days, 0 bytes');
    expect(page).toContain('As the Privacy page says under “Your data”.');
    expect(page).toContain('2 keys, 5 bytes, that none of the kinds above is');
    expect(page).toContain('Failed sign-ins Not counted here');
    expect(page).not.toContain('Couldn’t be read just now, so none of it is counted');
  });

  test('a container that couldn’t be walked says so above it all', () => {
    const page = text(renderToStaticMarkup(<InventoryView inv={{ ...inv, measured: false }} />));
    expect(page).toContain('What is stored in your account couldn’t be read just now, so none of it is counted below.');
  });

  test('hide amounts leaves counts and sizes alone: they are no amounts', () => {
    const shown = renderToStaticMarkup(<InventoryView inv={inv} />);
    const hidden = inBrowser(() => {
      setAmountsHidden(true);
      return renderToStaticMarkup(<InventoryView inv={inv} />);
    });
    expect(hidden).toBe(shown);
    expect(hidden).not.toContain(MASK);
  });

  test('the entry in Settings: the admin alone is shown the way to storage across accounts', () => {
    expect(renderToStaticMarkup(<InventoryEntry />)).toContain('href="/your-data"');
    expect(renderToStaticMarkup(<InventoryEntry />)).not.toContain('/admin/storage');
    expect(renderToStaticMarkup(<InventoryEntry admin />)).toContain('href="/admin/storage"');
  });
});

const account = (over: Partial<AdminContainer>): AdminContainer => ({
  container: '0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b',
  you: false,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  storage: { keys: 10, total_chars: 1000, largest_chars: 500, unmeasured: 0 },
  items: [],
  orphaned: [],
  connectors: { connections: 0, with_credential: 0, accounts: 0 },
  snapshot: { date: '2026-10-21', status: 'recorded', at: '2026-10-21T08:00:00.000Z', attempts: 1 },
  snapshot_unreadable: false,
  ...over,
});
const item = (over: Partial<NonNullable<AdminContainer['items']>[number]>) => ({
  item_id: 'item1',
  institution_name: 'Chase',
  transactions_billed: true,
  txns_chars: 0,
  invtxns_chars: 0,
  blocked: false,
  unsaved: false,
  usage: { flagged: null, refused_since: null, hidden_since: null, checked_at: '2026-10-21T08:00:00.000Z' },
  usage_unreadable: false,
  ...over,
});

describe('storage across accounts, in words', () => {
  const a = account({ container: 'a0000000-0000-4000-8000-000000000001', storage: { keys: 3, total_chars: 300, largest_chars: 100, unmeasured: 0 }, created_at: '2026-03-01T00:00:00.000Z', items: [item({ txns_chars: 900 })] });
  const b = account({ container: 'b0000000-0000-4000-8000-000000000002', storage: { keys: 9, total_chars: 9000, largest_chars: 50, unmeasured: 0 }, snapshot: null, connectors: { connections: 2, with_credential: 1, accounts: 4 } });
  const c = account({ container: 'c0000000-0000-4000-8000-000000000003', storage: null, items: null, orphaned: null, connectors: null, snapshot_unreadable: true, snapshot: null });
  const d = account({ container: 'd0000000-0000-4000-8000-000000000004', items: [item({}), item({ item_id: 'item2' })], orphaned: [{ item_id: 'gone', txns_chars: 5000, invtxns_chars: 0 }], snapshot: { date: '2026-09-01', status: 'failed', at: '2026-09-01T08:00:00.000Z', attempts: 2 } });
  const ids = (list: AdminContainer[]) => list.map((x) => x.container[0]);

  test('sorts by each measure, what couldn’t be read last', () => {
    expect(SORTS.map(([s]) => s)).toEqual(['stored', 'ceiling', 'items', 'connectors', 'snapshot', 'made']);
    expect(ids(sortContainers([a, b, c, d], 'stored'))).toEqual(['b', 'd', 'a', 'c']);
    expect(ids(sortContainers([a, b, c, d], 'ceiling'))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(sortContainers([a, b, c, d], 'items'))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(sortContainers([a, b, c, d], 'connectors'))).toEqual(['b', 'a', 'd', 'c']);
    // Never snapshotted first, then the oldest.
    expect(ids(sortContainers([a, b, c, d], 'snapshot'))).toEqual(['b', 'd', 'a', 'c']);
    expect(ids(sortContainers([a, b, c, d], 'made'))).toEqual(['a', 'b', 'c', 'd']);
  });

  test('an Item’s state, and the share of the ceiling, never rounded up to it', () => {
    expect(itemState(item({}))).toEqual([]);
    expect(itemState(item({ blocked: true, unsaved: true, transactions_billed: false }))).toEqual([
      'a save of its transactions was refused for its size',
      'its last save of transactions failed',
      'Plaid wasn’t billing Transactions when it was linked',
    ]);
    expect(itemState(item({ usage: { flagged: 'refused', refused_since: '2026-08-02T00:00:00.000Z', hidden_since: null, checked_at: null } }))).toEqual([
      'flagged as unused: Plaid has refused it for long enough',
    ]);
    expect(itemState(item({ usage: null }))).toEqual(['not checked yet']);
    expect(itemState(item({ usage: null, usage_unreadable: true }))).toEqual(['its last check couldn’t be read']);
    // A day as recorded, whatever the viewer's time zone.
    expect(utcDay('2026-10-21')).toBe(new Date(Date.UTC(2026, 9, 21)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
    expect(utcDay('2026-10-21')).toContain('21');
    expect([ofCeiling(999, 1000), ofCeiling(1000, 1000), ofCeiling(0, 1000), ofCeiling(5, 0)]).toEqual([99, 100, 0, 0]);
  });

  test('drawn: each account by its id, never a person’s name or address, what couldn’t be read said, and the same with amounts hidden', () => {
    const page: AdminPage = { as_of: '2026-10-22T12:00:00.000Z', ceiling_chars: 8_388_608, total: 5, next: d.container, containers: [a, b, c, { ...d, you: true }] };
    const html = renderToStaticMarkup(<AdminStorageView pages={page} sort="stored" onSort={() => {}} />);
    const t = text(html);
    expect(t).toContain('4 of 5 accounts, sorted among those loaded. The limit of one save is 8.0 MB.');
    expect(t).toContain('Account a0000000');
    expect(t).toContain('You');
    expect(t).not.toMatch(/@/);
    expect(t).toContain('Its keys couldn’t be walked just now.');
    expect(t).toContain('Couldn’t be counted just now.');
    expect(t).toContain('Its newest record couldn’t be read just now.');
    expect(t).toContain('2 connections, 1 still holding the access it was given, keeping 4 accounts up to date.');
    expect(t).toContain('1 store of transactions whose connection is gone, costing the same: 5 KB.');
    // An account that couldn't be measured: its blobs unknown, never 0 bytes.
    const unknown = account({ container: 'e0000000-0000-4000-8000-000000000005', storage: null, orphaned: null, connectors: null, items: [item({ txns_chars: null, invtxns_chars: null, blocked: null, unsaved: null })] });
    const u = text(renderToStaticMarkup(<AdminStorageView pages={{ ...page, containers: [unknown] }} sort="ceiling" onSort={() => {}} />));
    expect(u).toContain('Chase : its stored transactions couldn’t be measured');
    expect(u).not.toMatch(/0 bytes|0% of the limit/);
    expect(ids(sortContainers([unknown, a, b], 'ceiling'))).toEqual(['a', 'b', 'e']);
    // One Item unmeasured: the account's largest blob isn't known either.
    const partly = account({ container: 'f0000000-0000-4000-8000-000000000006', items: [item({ txns_chars: 900 }), item({ item_id: 'item2', txns_chars: null, invtxns_chars: null, blocked: null, unsaved: null })] });
    expect(ids(sortContainers([partly, a], 'ceiling'))).toEqual(['a', 'f']);
    const hidden = inBrowser(() => {
      setAmountsHidden(true);
      return renderToStaticMarkup(<AdminStorageView pages={page} sort="stored" onSort={() => {}} />);
    });
    expect(hidden).toBe(html);
  });
});
