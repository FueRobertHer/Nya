import { describe, expect, test } from 'bun:test';
import { mapCategories, sourceKey } from '@/lib/migration/categories';
import { sourceAccounts } from '@/lib/migration/plan';
import { readMigrationMeta } from '@/lib/migration/request';
import { isMigrationEntry } from '@/lib/migration/store';
import { readAppFile } from '@/lib/import/apps/read';
import { seedTaxonomy, NAME_MAX } from '@/lib/categories';

// The pure parts of importing another app's export (lib/migration/): the
// app's categories named as the person's set allows, however many share a
// name; answers by the keys a file writes, never inherited ones; and the
// record Undo reads, refused when a later release wrote more into it.

describe('naming the app’s categories', () => {
  test('a thousand of one long name in groups that differ past what a name keeps each get a name of their own, at once', () => {
    let i = 0;
    const t = seedTaxonomy([], () => `id${i++}`);
    const sources = Array.from({ length: 1001 }, (_, k) => {
      const s = { group: `${'G'.repeat(70)}${k}`, name: 'M'.repeat(60), kind: null, from: null, rows: 1 };
      return { ...s, key: sourceKey(s) };
    });
    const started = performance.now();
    const plan = mapCategories(sources, t, {});
    expect(performance.now() - started).toBeLessThan(5000);
    const names = plan.mappings.map((m) => m.target.name);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(1001);
    expect(names.every((n) => n.length <= NAME_MAX)).toBe(true);
    expect(names).toContain(`${'M'.repeat(NAME_MAX - ' (1001)'.length)} (1001)`);
  });
});

describe('answers by the keys a file writes', () => {
  test('an account called "constructor" or "toString" is unanswered until answered, and "__proto__" is only ever its own', () => {
    const file = ['Account,Date,Payee,Notes,Category,Amount,Split_Amount,Cleared', 'constructor,2026-09-01,Shop,,Food,-5,0,Cleared', 'toString,2026-09-01,Shop,,Food,-6,0,Cleared', '__proto__,2026-09-01,Shop,,Food,-7,0,Cleared'].join('\n');
    const r = readAppFile(file, { options: {}, thisYear: 2026 });
    if (r.status !== 'ready') throw new Error(r.status);
    const none = readMigrationMeta({ action: 'preview', accounts: {} });
    if (typeof none === 'string') throw new Error(none);
    expect(sourceAccounts(r.parsed.txns, none.answers.accounts).map((a) => [a.key, a.choice])).toEqual([
      ['constructor', null],
      ['toString', null],
      ['__proto__', null],
    ]);
    const meta = readMigrationMeta(JSON.parse('{"action":"preview","accounts":{"__proto__":{"to":"skip"}},"carry":false}'));
    if (typeof meta === 'string') throw new Error(meta);
    expect(Object.getPrototypeOf(meta.answers.accounts)).toBeNull();
    expect(Object.hasOwn(meta.answers.accounts, '__proto__')).toBe(true);
    expect(meta.answers.carry).toBe(false);
    expect(sourceAccounts(r.parsed.txns, meta.answers.accounts).find((a) => a.key === '__proto__')!.choice).toEqual({ to: 'skip' });
    expect(readMigrationMeta({ action: 'preview', carry: 'no' })).toBe('Invalid request');
  });
});

describe('the record Undo reads', () => {
  const entry = {
    version: 1,
    app: 'ynab',
    variant: 'register',
    file_name: 'x.csv',
    entry: null,
    file_bytes: 10,
    started_at: '2026-10-01T00:00:00.000Z',
    status: 'done',
    finished_at: '2026-10-01T00:00:01.000Z',
    imports: [{ account_id: 'manual_a', kind: 'manual', type: 'depository', import_id: 'import:x', name: 'Checking', sources: ['Checking'] }],
    made: { accounts: [{ id: 'manual_a', name: 'Checking' }], categories: [], groups: [], tags: [] },
    counts: { rows: 1, imported: 1, duplicates: 0, present: 0, unreadable: 0, splits: 0, tagged: 0 },
  };
  test('is this shape, and nothing more: one a later release wrote more into is never undone without it', () => {
    expect(isMigrationEntry(entry)).toBe(true);
    expect(isMigrationEntry({ ...entry, made: { ...entry.made, rules: ['r1'] } })).toBe(false);
    expect(isMigrationEntry({ ...entry, extra: 1 })).toBe(false);
    expect(isMigrationEntry({ ...entry, imports: [{ ...entry.imports[0], more: true }] })).toBe(false);
    expect(isMigrationEntry({ ...entry, counts: { ...entry.counts, later: 1 } })).toBe(false);
  });
});
