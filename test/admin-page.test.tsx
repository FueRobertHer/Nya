import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { clerk } from './clerk-mock';
import { mockForFile } from './scoped-mock';
import { FakeRedis, storageMock, testKey, TEST_CTX, TEST_CONTAINER } from './fake-redis';

// The admin page (/admin: app/admin-view/page.tsx, lib/admin-page.ts,
// components/AdminPage.tsx): what it reads, each part on its own, and the
// page as the server draws it (ISO days, before the browser takes over), in
// its order, with nothing secret in it, and missing for anyone but the admin.

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

let admin = true;
await mockForFile('@/lib/admin-items', () => ({ adminCtx: async () => (admin ? TEST_CTX : null) }));
// The card refreshes the page after a change; useRouter throws outside the
// App Router. notFound stays Next's own.
const navigation = { ...(await import('next/navigation')) };
await mockForFile('next/navigation', () => ({ ...navigation, useRouter: () => ({ refresh: () => {} }) }));

const { readAdminPage, adminFacts } = await import('@/lib/admin-page');
const { default: AdminPage, CHANGES_SHOWN } = await import('@/components/AdminPage');
const { default: AdminViewPage, generateMetadata } = await import('@/app/admin-view/page');
const { flagsStore } = await import('@/lib/flag-store');
const { flagCache } = await import('@/lib/flag-cache');
const { recordOutcome } = await import('@/lib/backup');

const OTHER = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const NOW = new Date('2026-10-22T12:00:00.000Z');

const register = (container: string, created: string, status: 'active' | 'archived' = 'active') =>
  fake.hset(testKey('containers'), { [container]: JSON.stringify({ status, primary: false, created_at: created }) });
const at = (iso: string) => Date.parse(iso);

const saved = { ...process.env };
const errors = console.error;
beforeEach(async () => {
  fake.reset();
  flagCache.forget();
  admin = true;
  process.env = { ...saved };
  process.env.VERCEL_ENV = 'preview';
  for (const name of ['OPS_ENABLED', 'LUNCHFLOW_ENABLED', 'DEMO_USER_IDS', 'BLOB_READ_WRITE_TOKEN', 'ATTACHMENTS_QUOTA_MB', 'BACKUP_KEEP_DAYS', 'PLAID_WEBHOOK_URL', 'OPS_SECRET', 'MAX_TXN_BLOB_CHARS'])
    delete process.env[name];
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  clerk.signedIn = null;
  await register(TEST_CONTAINER, '2026-01-01T00:00:00.000Z');
  await register(OTHER, '2026-02-01T00:00:00.000Z');
});
afterEach(() => {
  process.env = { ...saved };
  console.error = errors;
});

/** The page as the server draws it. */
const html = async () => renderToStaticMarkup(<AdminPage data={await readAdminPage(TEST_CTX, NOW)} />);
/** Its text, a space between elements. */
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, '’')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
/** The card titles, in order. */
const titles = (h: string) => [...h.matchAll(/<h2[^>]*>([^<]*)</g)].map((m) => m[1]);
/** One card's markup, by its title's id. */
const card = (h: string, id: string) => {
  const start = h.lastIndexOf('<section', h.indexOf(`id="${id}"`));
  return h.slice(start, h.indexOf('</section>', start));
};

describe('what it reads', () => {
  test('the switches named, the record worded, the accounts, the jobs and the settings, for Preview', async () => {
    await flagsStore.update('lunchflow', () => ({ on: 'admin', containers: [OTHER as never], updatedAt: '2026-10-21T09:00:00.000Z' }), TEST_CONTAINER, at('2026-10-21T09:00:00.000Z'));
    const data = await readAdminPage(TEST_CTX, NOW);
    expect(data.environment).toBe('Preview');
    expect(data.freshSignIn).toBe(false);
    expect(data.demos).toEqual([
      { label: 'Alex', set: false },
      { label: 'Sam', set: false },
    ]);
    expect(data.rows?.find((r) => r.key === 'lunchflow')).toMatchObject({ name: 'Lunch Flow', stored: 'admin', containers: [OTHER] });
    expect(data.changes).toEqual({
      lines: [{ at: '2026-10-21T09:00:00.000Z', key: 'lunchflow', what: 'Lunch Flow: set to You, added Account 9c1d2e3f', by: 'You' }],
      unreadable: 0,
    });
    expect(data.accounts).toEqual([
      { id: TEST_CONTAINER, name: 'You', made: '2026-01-01T00:00:00.000Z', active: true },
      { id: OTHER, name: 'Account 9c1d2e3f', made: '2026-02-01T00:00:00.000Z', active: true },
    ]);
    expect(data.jobs?.map((j) => j.job)).toEqual(['backup', 'files']);
    expect(data.ops).toBeNull();
    expect(data.facts.map((f) => f.name)).toEqual([
      'Plaid',
      'Plaid webhooks',
      'Sign-in',
      'Ops secret',
      'Stored transactions',
      'Unused connections',
      'Receipts and documents',
      'Backups kept',
    ]);
  });

  test('Production: a fresh sign-in for a change, and no demo accounts', async () => {
    process.env.VERCEL_ENV = 'production';
    const data = await readAdminPage(TEST_CTX, NOW);
    expect([data.environment, data.freshSignIn, data.demos]).toEqual(['Production', true, null]);
  });

  test('a part that can’t be read is null, and the rest still is', async () => {
    console.error = () => {};
    const hgetall = fake.hgetall.bind(fake);
    (fake as any).hgetall = (key: string) => (key === testKey('flags:values') ? Promise.reject(new Error('storage down')) : hgetall(key));
    const data = await readAdminPage(TEST_CTX, NOW).finally(() => delete (fake as any).hgetall);
    expect(data.rows).toBeNull();
    expect(data.ops).toBeNull();
    expect(data.changes).toEqual({ lines: [], unreadable: 0 });
    expect(data.accounts).toHaveLength(2);
    const page = text(renderToStaticMarkup(<AdminPage data={data} />));
    expect(page).toContain('Feature switches Caution: The feature switches couldn’t be read.');
  });

  test('the ops routes: open by the stored switch, or by their variable, which wins either way', async () => {
    await flagsStore.update('ops', () => ({ on: true, updatedAt: '2026-10-21T09:00:00.000Z' }), TEST_CONTAINER);
    expect((await readAdminPage(TEST_CTX, NOW)).ops).toBe('stored');
    process.env.OPS_ENABLED = '0';
    expect((await readAdminPage(TEST_CTX, NOW)).ops).toBeNull();
    process.env.OPS_ENABLED = '1';
    expect((await readAdminPage(TEST_CTX, NOW)).ops).toBe('variable');
  });

  test('the settings say what the app makes of them', () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_x';
    process.env.BACKUP_KEEP_DAYS = '14';
    process.env.ATTACHMENTS_QUOTA_MB = '500';
    process.env.PLAID_WEBHOOK_URL = 'https://nya.test/api/plaid/webhook';
    const value = (name: string) => adminFacts().find((f) => f.name === name)?.value;
    expect([value('Backups kept'), value('Receipts and documents'), value('Plaid webhooks'), value('Ops secret')]).toEqual(['14 days', '500 MB', 'On', 'Not set']);
    // A count, with its unit: never a bare figure that reads as an amount.
    expect(value('Stored transactions')).toBe('8,388,608 characters');
    process.env.BACKUP_KEEP_DAYS = 'two weeks';
    process.env.ATTACHMENTS_QUOTA_MB = 'lots';
    expect([value('Backups kept'), value('Receipts and documents')]).toEqual(['Invalid', 'Off']);
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect(value('Backups kept')).toBe('None');
  });
});

describe('the page', () => {
  test('its cards in order, Needs attention only when something does', async () => {
    const quiet = await html();
    expect(titles(quiet)).toEqual(['Feature switches', 'Jobs and storage', 'Demo accounts', 'Environment', 'Operations', 'Changes']);
    expect(text(quiet)).not.toContain('Tax law');
    expect(quiet).toContain('href="/?settings=admin"');
    expect(quiet).toContain('href="/admin/jobs"');
    expect(quiet).toContain('href="/admin/storage"');
    expect(text(quiet)).toContain('Storage across accounts 2 accounts in use');

    process.env.VERCEL_ENV = 'production';
    expect(titles(await html())).toEqual(['Feature switches', 'Jobs and storage', 'Environment', 'Operations', 'Changes']);
  });

  test('a nightly job that failed, and ops routes left on, need attention, each linked where it is done, its day as the server writes it', async () => {
    await recordOutcome({ ok: true }, new Date('2026-10-20T16:00:00.000Z'));
    await recordOutcome({ ok: false, reason: 'timeout' }, new Date('2026-10-21T16:00:00.000Z'));
    await flagsStore.update('ops', () => ({ on: true, updatedAt: '2026-10-21T09:00:00.000Z' }), TEST_CONTAINER);
    const page = await html();
    expect(titles(page)[0]).toBe('Needs attention');
    const needs = card(page, 'admin-needs-title');
    expect(text(needs)).toContain('Caution: Nightly backup failed Last saved 2026-10-20 · timeout · Check the backup cron in Vercel.');
    expect(text(needs)).toContain('Caution: The ops routes are on Turn them off once the operation is done.');
    expect([...needs.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual(['/admin/jobs', '/admin#feature-switches']);
    expect(text(card(page, 'admin-jobs-title'))).toContain('Nightly jobs Backup needs attention · Clean-up hasn’t run');

    process.env.OPS_ENABLED = '1';
    expect(text(card(await html(), 'admin-needs-title'))).toContain('The ops routes are on OPS_ENABLED is set: remove it once the operation is done.');
  });

  test('the environment and operations are read only, and no secret reaches the page', async () => {
    process.env.OPS_SECRET = 'sentinel-ops-secret';
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_sentinel_publishable';
    process.env.CLERK_SECRET_KEY = 'sk_sentinel_secret';
    process.env.PLAID_SECRET = 'sentinel-plaid-secret';
    process.env.APP_PASSWORD = 'sentinel-app-password';
    process.env.PLAID_WEBHOOK_URL = 'https://nya.test/api/plaid/webhook?token=sentinel-webhook';
    const page = await html();
    for (const secret of ['sentinel-ops-secret', 'pk_sentinel', 'sk_sentinel', 'sentinel-plaid-secret', 'sentinel-app-password', 'sentinel-webhook']) expect([secret, page.includes(secret)]).toEqual([secret, false]);
    const environment = card(page, 'admin-environment-title');
    expect(text(environment)).toContain('Ops secret What the ops routes ask for while they are on. Set by OPS_SECRET. Set');
    expect(text(environment)).toContain('Sign-in Clerk while both its keys are set');
    const operations = card(page, 'admin-operations-title');
    for (const part of [environment, operations]) expect(/<(button|form|input|select|textarea)\b/.test(part)).toBe(false);
    expect(text(operations)).toContain('Nothing runs from this page.');
    expect([...operations.matchAll(/class="list-row" href="([^"]+)"/g)]).toHaveLength(9);
  });

  test('the record: each change worded, its day as the server writes it, latest first, the latest 25 until Show all', async () => {
    for (let i = 0; i < CHANGES_SHOWN + 2; i++) {
      const on = i % 2 === 0;
      await flagsStore.update('ops', () => ({ on, updatedAt: '2026-10-01T00:00:00.000Z' }), i === 0 ? 'local development' : TEST_CONTAINER, at(`2026-10-${String(i + 1).padStart(2, '0')}T08:00:00.000Z`));
    }
    const changes = card(await html(), 'admin-changes-title');
    const rows = [...changes.matchAll(/<div class="list-row">/g)];
    expect(rows).toHaveLength(CHANGES_SHOWN);
    expect(text(changes)).toContain('Ops routes: Off to On 2026-10-27 · You');
    expect(text(changes)).not.toContain('Local development');
    expect(text(changes)).toContain(`Show all ${CHANGES_SHOWN + 2}`);
  });

  test('changes this release can’t read are counted, not shown', async () => {
    await flagsStore.update('ops', () => ({ on: true, updatedAt: '2026-10-01T00:00:00.000Z' }), TEST_CONTAINER);
    await fake.hset(testKey('flags:log'), { 'zzz-unreadable': '{not json' });
    const changes = text(card(await html(), 'admin-changes-title'));
    expect(changes).toContain('Ops routes: set to On');
    expect(changes).toContain('1 change this release can’t read is left out.');
  });
});

describe('who sees it', () => {
  test('anyone but the admin gets the 404 page, its title and description too; the admin the page', async () => {
    admin = false;
    await expect(AdminViewPage()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    await expect(generateMetadata()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    admin = true;
    expect(await AdminViewPage()).toBeTruthy();
    expect((await generateMetadata()).title).toBe('Admin · Nya');
  });
});
