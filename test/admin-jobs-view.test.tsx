import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, trackRoots, click, type FakeElement } from './mini-dom';
import { holdDay } from './held-day';

holdDay();

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
const { createRoot } = trackRoots(require('react-dom/client') as typeof import('react-dom/client'));
const { default: AdminJobs } = await import('@/components/AdminJobs');
type JobView = import('@/lib/backup').JobView;
type RunView = import('@/lib/backup').RunView;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const job = (over: Partial<JobView> & Pick<JobView, 'job'>): JobView => ({
  hour: over.job === 'backup' ? 16 : 17,
  minute: over.job === 'backup' ? 0 : 30,
  last_ok: null,
  last_failed: null,
  reason: null,
  problem: null,
  running_now: null,
  again_at: null,
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
/** The run log the GET answers with (lib/backup.ts recentRuns); undefined
 *  leaves it out, as a log that couldn't be read is. */
let runs: RunView[] | undefined = [];
let answer: () => Promise<Response> = async () => new Response('{}');
beforeEach(() => {
  posts = [];
  runs = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return answer();
    }
    return new Response(JSON.stringify({ jobs: listing, ...(runs ? { runs } : { runs: null }) }));
  }) as unknown as typeof fetch;
});

const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
const settle = () => new Promise((r) => setTimeout(r, 0));

async function mount(props: { pollMs?: number } = {}) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(<AdminJobs {...props} />);
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

  test('while a run is going, every button waits and says which run; the route’s answer names it too', async () => {
    const going = { job: 'backup' as const, by: 'cron' as const, started: '2026-10-24T16:01:00Z' };
    listing = [job({ ...failedBackup, running_now: going }), job({ ...failedFiles, running_now: going })];
    const page = await mount();
    expect(page.button('Nightly backup')?.getAttribute('disabled')).not.toBeNull();
    expect(page.text('Nightly backup')).toContain('Its nightly cron is running it now. Run now comes back when it finishes.');
    expect(page.button('Receipts and documents clean-up')?.getAttribute('disabled')).not.toBeNull();
    expect(page.text('Receipts and documents clean-up')).toContain('The nightly backup is running now. Run this once it finishes.');
    page.unmount();
    listing = [failedBackup, goodFiles];
    answer = json(409, { error: 'The nightly backup (started by its cron) is running now. Try again once it finishes.', jobs: listing });
    const later = await mount();
    await later.press(later.button('Nightly backup')!);
    expect(later.text('Nightly backup')).toContain('The nightly backup (started by its cron) is running now.');
    later.unmount();
  });

  test('a job that worked a few minutes ago waits until when; one that failed never waits', async () => {
    listing = [job({ ...goodBackup, again_at: '2026-11-06T12:04:00Z' }), failedFiles];
    const page = await mount();
    expect(page.button('Nightly backup')?.getAttribute('disabled')).not.toBeNull();
    expect(page.text('Nightly backup')).toContain('It worked a few minutes ago. Run it again from here after');
    expect(page.button('Receipts and documents clean-up')?.getAttribute('disabled')).toBeNull();
    expect(page.text('Receipts and documents clean-up')).not.toContain('Run it again from here after');
    page.unmount();
  });

  /** Real time passing, in short acts, so React runs the effects each read
   *  sets off, until `done` (or `ms` have passed). */
  const waitUntil = async (done: () => boolean, ms: number) => {
    const end = performance.now() + ms;
    while (!done() && performance.now() < end) await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
  };

  test('while it waits, it reads again on its own, after a read that failed too, and Run now comes back', async () => {
    // Worked a moment ago, free again half a second from now (the day is held at noon).
    listing = [job({ ...goodBackup, again_at: '2026-11-06T12:00:00.500Z' }), goodFiles];
    const page = await mount({ pollMs: 100 });
    expect(page.button('Nightly backup')?.getAttribute('disabled')).not.toBeNull();
    // The next read fails; the one after says it is free.
    let reads = 0;
    globalThis.fetch = (async () => {
      reads++;
      return reads === 1 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ jobs: [goodBackup, goodFiles] }));
    }) as unknown as typeof fetch;
    await waitUntil(() => reads === 1, 3000);
    expect(page.text('Nightly backup')).toContain('It worked a few minutes ago.');
    expect(page.button('Nightly backup')?.getAttribute('disabled')).not.toBeNull();
    await waitUntil(() => reads === 2, 3000);
    await waitUntil(() => page.button('Nightly backup')?.getAttribute('disabled') === null, 1000);
    expect(reads).toBe(2);
    expect(page.button('Nightly backup')?.getAttribute('disabled')).toBeNull();
    page.unmount();
  }, 10_000);

  test('reads that keep failing are tried less often, and stop after three', async () => {
    const going = { job: 'backup' as const, by: 'cron' as const, started: '2026-11-06T11:59:00Z' };
    listing = [job({ ...failedBackup, running_now: going }), job({ ...goodFiles, running_now: going })];
    const page = await mount({ pollMs: 100 });
    const at: number[] = [];
    globalThis.fetch = (async () => (at.push(performance.now()), new Response('', { status: 503 }))) as unknown as typeof fetch;
    // 100 ms, then 200 and 400 more: three reads, and none after.
    await waitUntil(() => at.length >= 3, 3000);
    await waitUntil(() => false, 1500);
    expect(at.length).toBe(3);
    expect(at[2] - at[1]).toBeGreaterThan(at[1] - at[0]);
    expect((dom.document.body as unknown as FakeElement).textContent).toContain('Could not read the nightly jobs right now.');
    page.unmount();
  }, 10_000);

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

  test('Recent runs: each run of either job, newest first, with how it went and why', async () => {
    listing = [goodBackup, goodFiles];
    const run = (over: Partial<RunView> & Pick<RunView, 'id' | 'job' | 'outcome'>): RunView => ({
      by: 'cron',
      started: '2026-10-24T16:00:00.000Z',
      ended: '2026-10-24T16:00:12.300Z',
      reason: null,
      at: null,
      silent: false,
      ...over,
    });
    runs = [
      run({ id: '5', job: 'backup', outcome: 'running', ended: null, at: { phase: 'upload', at: '2026-10-24T16:00:03.000Z' } }),
      run({
        id: '4',
        job: 'backup',
        outcome: 'worked',
        by: 'hand',
        attempts: [{ step: 'upload', reason: 'Vercel Blob: the service is unavailable' }],
        steps: [
          ['export', 2100],
          ['upload', 800],
        ],
        resends: 2,
      }),
      run({ id: '3', job: 'files', outcome: 'worked', counts: { containers: 3, orphans_deleted: 1, errors: 0, finished: true, listed: true } }),
      run({ id: '2', job: 'files', outcome: 'not-run', reason: 'Not run: the nightly backup (started by its cron) was still going after 30s.' }),
      run({ id: '1', job: 'backup', outcome: 'running', ended: null, silent: true, at: { phase: 'keys', at: '2026-10-23T16:00:40.000Z' } }),
    ];
    const page = await mount();
    const text = page.text('Recent runs');
    const order = ['Nightly backup: running now', 'Nightly backup: worked', 'Receipts and documents clean-up: worked', 'Receipts and documents clean-up: not run', 'Nightly backup: no outcome recorded'];
    expect(order.map((t) => text.indexOf(t))).toEqual([...order.map((t) => text.indexOf(t))].sort((a, b) => a - b));
    expect(order.every((t) => text.includes(t))).toBe(true);
    expect(text).toContain('Now at: upload.');
    expect(text).toContain('from this page · 12.3 seconds · on attempt 2');
    expect(text).toContain('Attempt 1 failed at its upload step: Vercel Blob: the service is unavailable');
    expect(text).toContain('Steps: export 2.1 seconds, upload 0.8 seconds. 2 Vercel Blob calls sent again.');
    expect(text).toContain('3 accounts checked, 1 file no record names removed, the weekly store-wide pass ran.');
    expect(text).toContain('Not run: the nightly backup (started by its cron) was still going after 30s.');
    // Two runs that ran say how long they took; the one that didn't run, nothing.
    expect(text.split('12.3 seconds').length - 1).toBe(2);
    expect(text).toContain('It stopped before it could say how it went: Vercel ends a run at 300 seconds, or storage couldn’t be reached. Last at: keys,');
    page.unmount();
  });

  test('Recent runs with none yet says so, and a log that can’t be read says so without hiding the jobs', async () => {
    listing = [goodBackup, goodFiles];
    let page = await mount();
    expect(page.text('Recent runs')).toContain('No runs recorded yet.');
    page.unmount();
    runs = undefined;
    page = await mount();
    expect(page.text('Recent runs')).toContain('The run log couldn’t be read. Reload the page to try again.');
    expect(page.button('Nightly backup')?.textContent).toBe('Run now');
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
