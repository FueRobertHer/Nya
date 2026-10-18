import { describe, expect, test, mock } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

// The parts of a download as a restore knows them (lib/user-restore/parts.ts),
// for the page, which can't load the stores: kept equal to the stores declared
// (lib/stores.ts), so a store added later takes a side before a download that
// has it can be brought back.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { SEAM, CORE_PARTS, HEADER_PARTS, MAX_RESTORED_MANUAL_ACCOUNTS } = await import('@/lib/user-restore/parts');
const { declaredSections, SECTIONS } = await import('@/lib/user-export');
const { declaredStore } = await import('@/lib/stores');
const { MAX_CONNECTOR_ACCOUNTS, MAX_CONNECTIONS } = await import('@/lib/connectors/manage');
const { MAX_GOALS } = await import('@/lib/goal-model');
const { MAX_NOTES } = await import('@/lib/timeline-notes');
const { MAX_ANNOTATIONS } = await import('@/lib/txn-annotations');
const { MAX_APPROVALS } = await import('@/lib/review-store');
const { MAX_GROUPS } = await import('@/lib/groups');
const { MAX_SPLITS } = await import('@/lib/splits');
const { MAX_MANUAL_ACCOUNTS } = await import('@/lib/manual');

describe('the parts', () => {
  test('one for every store the download has a section for, of its kind', () => {
    expect(Object.keys(SEAM).sort()).toEqual(declaredSections().map((s) => s.key).sort());
    for (const [name, part] of Object.entries(SEAM)) expect([name, declaredStore(name)?.kind]).toEqual([name, part.kind]);
  });

  test('the core parts are the download’s own, in its order', () => {
    expect([...CORE_PARTS].filter((p) => SECTIONS.some((s) => s.key === p)) as string[]).toEqual(SECTIONS.map((s) => s.key));
    expect(HEADER_PARTS).toEqual(['format', 'version', 'exported_at', 'documentation', 'not_included', 'notes', 'problems']);
  });

  test('each bound is the store’s own', () => {
    expect(SEAM['connector-accounts'].max).toBe(MAX_CONNECTOR_ACCOUNTS);
    expect(SEAM['connector-connections'].max).toBe(MAX_CONNECTIONS);
    expect(SEAM['goal-plans'].max).toBe(MAX_GOALS);
    expect(SEAM['timeline-notes'].max).toBe(MAX_NOTES);
    expect(SEAM['transaction-annotations'].max).toBe(MAX_ANNOTATIONS);
    expect(SEAM['transaction-approvals'].max).toBe(MAX_APPROVALS);
    expect(SEAM['transaction-groups'].max).toBe(MAX_GROUPS);
    expect(SEAM['transaction-splits'].max).toBe(MAX_SPLITS);
    expect(MAX_RESTORED_MANUAL_ACCOUNTS).toBe(MAX_MANUAL_ACCOUNTS + MAX_CONNECTOR_ACCOUNTS);
  });
});
