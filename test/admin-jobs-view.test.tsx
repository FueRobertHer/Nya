import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, click, type FakeElement } from './mini-dom';

// The admin's Nightly jobs page (/admin/jobs, components/AdminJobs.tsx): each
// job, how it last went, and Run now (/api/admin/jobs). Rendered and used as
// a person would (react-dom/client over test/mini-dom.ts), with the route's
// answers stood in for.

const dom = installDom();
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: AdminJobs } = await import('@/components/AdminJobs');
type JobView = import('@/lib/backup').JobView;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const job = (over: Partial<JobView> & Pick<JobView, 'job'>): JobView => ({
  hour: over.job === 'backup' ? 16 : 17,
  minute: over.job === 'backup' ? 0 : 30,
  last_ok: null,
  last_failed: null,
  reason: null,
  problem: null,
  hold_until: null,
  runnable: true,
  ...over,
});
const failedBackup = job({ job: 'backup', last_ok: '2026-10-20T16:03:00Z', last_failed: '2026-10-24T16:04:00Z', reason: 'timeout', problem: { last_ok: '2026-10-20T16:03:00Z', reason: 'timeout' } });
const goodBackup = job({ job: 'backup', last_ok: '2026-10-24T16:03:00Z' });
const failedFiles = job({ job: 'files', last_failed: '2026-10-24T17:31:00Z', reason: 'listing', problem: { last_ok: null, reason: 'listing', held: false } });
const goodFiles = job({ job: 'files', last_ok: '2026-10-24T17:32:00Z' });

/** What the page sent, and what the route answers next: a GET, then a POST. */
let posts: unknown[] = [];
let listing: JobView[] = [];
let answer: () => Promise<Response> = async () => new Response('{}');
beforeEach(() => {
  posts = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return answer();
    }
    return new Response(JSON.stringify({ jobs: listing }));
  }) as unknown as typeof fetch;
});

const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
const settle = () => new Promise((r) => setTimeout(r, 0));

async function mount() {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(<AdminJobs />);
    await settle();
  });
  const body = dom.document.body as unknown as FakeElement;
  const section = (name: string) => body.findAll((e) => e.tagName === 'SECTION').find((s) => s.textContent.startsWith(name))!;
  return {
    text: (name: string) => section(name).textContent.replace(/\s+/g, ' ').trim(),
    button: (name: string) => section(name).findAll((e) => e.tagName === 'BUTTON')[0] as FakeElement | undefined,
    press: async (el: FakeElement) =>
      act(async () => {
        click(el);
        await settle();
      }),
    unmount: () => {
      act(() => root.unmount());
      host.parentNode?.removeChild(host);
    },
  };
}

describe('the Nightly jobs page', () => {
  test('each job: what it does, when, how it last went, and Run now', async () => {
    listing = [failedBackup, goodFiles];
    const page = await mount();
    const backup = page.text('Nightly backup');
    expect(backup).toContain('Every day at 16:00 UTC.');
    // The dashboard's words for it, unchanged.
    expect(backup).toContain('The nightly backup failed; the last one saved was on Oct 20. (timeout)');
    expect(backup).toContain('Last failed');
    expect(page.button('Nightly backup')?.textContent).toBe('Run now');
    const files = page.text('Receipts and documents clean-up');
    expect(files).toContain('Every day at 17:30 UTC.');
    expect(files).toContain('Its last run worked');
    expect(page.button('Receipts and documents clean-up')?.textContent).toBe('Run now');
    page.unmount();
  });

  test('a run that works says so, and the job shows its new last run', async () => {
    listing = [failedBackup, goodFiles];
    answer = json(200, { jobs: [goodBackup, goodFiles] });
    const page = await mount();
    await page.press(page.button('Nightly backup')!);
    expect(posts).toEqual([{ job: 'backup' }]);
    const backup = page.text('Nightly backup');
    expect(backup).toContain('The backup ran and was saved.');
    expect(backup).not.toContain('failed');
    page.unmount();
  });

  test('a run that fails again says so, with the new reason', async () => {
    listing = [goodBackup, failedFiles];
    const again = job({ ...failedFiles, reason: 'boom', problem: { last_ok: null, reason: 'boom', held: false } });
    answer = json(500, { error: 'boom', jobs: [goodBackup, again] });
    const page = await mount();
    await page.press(page.button('Receipts and documents clean-up')!);
    expect(posts).toEqual([{ job: 'files' }]);
    const files = page.text('Receipts and documents clean-up');
    expect(files).toContain('(boom)');
    expect(files).toContain('It failed again.');
    page.unmount();
  });

  test('while its cron may be going, the button waits and says until when; the route’s answer says when too', async () => {
    listing = [job({ ...failedBackup, hold_until: '2026-10-24T17:05:00Z' }), goodFiles];
    const page = await mount();
    expect(page.button('Nightly backup')?.getAttribute('disabled')).not.toBeNull();
    expect(page.text('Nightly backup')).toContain('Its nightly run may still be going. Run it from here after');
    page.unmount();
    listing = [failedBackup, goodFiles];
    answer = json(409, { error: 'Its nightly run may still be going. Try again in 12 minutes.', jobs: listing });
    const later = await mount();
    await later.press(later.button('Nightly backup')!);
    expect(later.text('Nightly backup')).toContain('Try again in 12 minutes.');
    later.unmount();
  });

  test('a clean-up the breaker held, or no file store: no button, and why', async () => {
    listing = [job({ job: 'backup', runnable: false }), job({ job: 'files', runnable: false, problem: { last_ok: null, reason: null, held: true } })];
    const page = await mount();
    expect(page.button('Nightly backup')).toBeUndefined();
    expect(page.text('Nightly backup')).toContain('No file store is connected');
    expect(page.button('Receipts and documents clean-up')).toBeUndefined();
    expect(page.text('Receipts and documents clean-up')).toContain('Running it again would hold back again.');
    page.unmount();
  });

  test('while one runs, every button is held and its job says it can take a while', async () => {
    listing = [failedBackup, failedFiles];
    let finish: (r: Response) => void = () => {};
    answer = () => new Promise((r) => (finish = r));
    const page = await mount();
    await page.press(page.button('Nightly backup')!);
    expect(page.button('Nightly backup')?.textContent).toBe('Running…');
    expect(page.button('Nightly backup')?.getAttribute('disabled')).not.toBeNull();
    expect(page.button('Receipts and documents clean-up')?.getAttribute('disabled')).not.toBeNull();
    expect(page.text('Nightly backup')).toContain('This can take up to five minutes.');
    await act(async () => {
      finish(new Response('nope', { status: 502 }));
      await settle();
    });
    expect(page.text('Nightly backup')).toContain('Could not run it right now.');
    expect(page.button('Receipts and documents clean-up')?.getAttribute('disabled')).toBeNull();
    page.unmount();
  });

  test('a page that can’t be read says so', async () => {
    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    await act(async () => {
      root.render(<AdminJobs />);
      await settle();
    });
    expect((dom.document.body as unknown as FakeElement).textContent).toContain('Could not read the nightly jobs right now.');
    act(() => root.unmount());
    host.parentNode?.removeChild(host);
  });
});
