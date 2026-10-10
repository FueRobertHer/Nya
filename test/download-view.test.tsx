import { describe, expect, test, mock, afterEach } from 'bun:test';
// Every name the app's components take from Clerk's client, so this mock can
// stand in for another file's while they share the process.
mock.module('@clerk/nextjs', () => ({
  useClerk: () => ({ signOut: async () => {} }),
  useReverification: (fetcher: unknown) => fetcher,
}));
const { renderToStaticMarkup } = await import('react-dom/server');
const { DownloadMyDataView, requestFile, formatBytes, formatsFor, localFilename, incompleteOf, CUT_OFF } = await import('@/components/DownloadMyData');
const { DOWNLOADS_PER_WINDOW } = await import('@/lib/download-limit');
const { localDate } = await import('@/lib/local-date');

type Phase = Parameters<typeof DownloadMyDataView>[0]['phase'];
const noop = () => {};
const view = (over: Partial<Parameters<typeof DownloadMyDataView>[0]> = {}) =>
  renderToStaticMarkup(
    <DownloadMyDataView format="json" onFormat={noop} needsPassword={false} password="" onPassword={noop} phase={{ kind: 'idle' }} onDownload={noop} {...over} />
  );
const button = (html: string) => /<button[^>]*>([^<]*)<\/button>/.exec(html)!;

describe('download my data, on screen', () => {
  test('says plainly what is in it, what is not, and that it isn’t encrypted', () => {
    const html = view();
    expect(html).toContain('Download my data');
    expect(html).toContain('A copy of what Nya keeps for you');
    expect(html).toContain('Left out: the access tokens Nya uses to reach your banks through Plaid');
    expect(html).toContain('the app’s own machinery, such as caches and counters. The file lists everything it leaves out');
    expect(html).toContain('isn’t encrypted');
    // The limit the server applies, not a number written out separately.
    expect(html).toContain(`Up to ${DOWNLOADS_PER_WINDOW} downloads an hour.`);
    for (const f of formatsFor(true)) expect(html).toContain(f.label);
    // The transactions CSV is every transaction, manual ones too; investments are in the JSON.
    expect(html).toContain('Every stored transaction, from your banks and entered by hand or imported, one per row');
    expect(html).toContain('Investment transactions are in the JSON file only.');
  });

  test('sharing is promised only where there is sharing', () => {
    expect(view()).toContain('and what you share');
    expect(view()).toContain('account links and sharing settings, in one file');
    const password = view({ needsPassword: true });
    expect(password).not.toContain('what you share');
    expect(password).not.toContain('sharing settings');
    expect(password).toContain('budgets, goals and account links, in one file');
  });

  test('with the shared password, it asks for it, and won’t start without it', () => {
    const empty = view({ needsPassword: true });
    expect(empty).toContain('type="password"');
    expect(button(empty)[0]).toMatch(/disabled/);
    expect(button(view({ needsPassword: true, password: 'hunter2' }))[0]).not.toMatch(/disabled/);
  });

  test('with Clerk, no password: Clerk confirms it’s you if it has to', () => {
    const html = view();
    expect(html).not.toContain('type="password"');
    expect(html).toContain('you’ll be asked to confirm it’s you first');
    expect(button(html)[0]).not.toMatch(/disabled/);
  });

  test('while it works, nothing can be changed or started again', () => {
    for (const phase of [{ kind: 'confirming' }, { kind: 'preparing' }, { kind: 'receiving', bytes: 2048, total: 4096 }] as Phase[]) {
      const html = view({ phase });
      expect(button(html)[0]).toMatch(/disabled/);
      expect(button(html)[1]).toBe('Preparing…');
      expect(html).toMatch(/<fieldset[^>]*disabled/);
    }
    expect(view({ phase: { kind: 'confirming' } })).toContain('Confirm it’s you in the window that opened.');
    expect(view({ phase: { kind: 'receiving', bytes: 2048, total: 3 * 1024 * 1024 } })).toContain('Downloading… 2 KB of 3.0 MB');
  });

  test('done: what was saved, and any caveat that came with it', () => {
    const html = view({ phase: { kind: 'done', filename: 'nya-data-2026-10-06.json', bytes: 1_572_864, notes: ['Nya could not save the newest transactions from Chase.'], incomplete: [] } });
    expect(html).toContain('Saved nya-data-2026-10-06.json (1.5 MB).');
    expect(html).toContain('Nya could not save the newest transactions from Chase.');
    // A whole file is never called incomplete.
    expect(html).not.toContain('incomplete');
    // Two caveats with the same words are both shown (they are keyed by place, not text).
    const twice = view({ phase: { kind: 'done', filename: 'f', bytes: 1, notes: ['same', 'same'], incomplete: [] } });
    expect(twice.match(/>same</g)).toHaveLength(2);
  });

  test('done, but missing something: says plainly the file is incomplete, above what is missing', () => {
    const missing = 'Not all of your holdings records could be read, so this file is missing 1 entry whose stored data is damaged.';
    const html = view({ phase: { kind: 'done', filename: 'nya-data-2026-10-06.json', bytes: 2048, notes: [missing], incomplete: ['holdings:history'] } });
    expect(html).toContain('Saved nya-data-2026-10-06.json (2 KB).');
    expect(html).toContain('This file is incomplete: some of what Nya keeps for you could not be read');
    expect(html.indexOf('This file is incomplete')).toBeLessThan(html.indexOf(missing));
    expect(html).toContain('Nothing was changed.');
  });

  test('the file is named with the viewer’s own date', () => {
    // 01:30 UTC on the 7th is still the 6th in New York.
    const evening = new Date('2026-10-07T01:30:00.000Z');
    expect(localFilename('json', evening)).toBe(`nya-data-${localDate(evening)}.json`);
    expect(localFilename('transactions-csv', evening)).toBe(`nya-transactions-${localDate(evening)}.csv`);
    expect(localFilename('balances-csv', evening)).toBe(`nya-balances-${localDate(evening)}.csv`);
  });

  test('an error is shown as the server said it', () => {
    expect(view({ phase: { kind: 'error', message: 'Your budgets could not be read, so nothing was downloaded.' } })).toContain(
      'Your budgets could not be read, so nothing was downloaded.'
    );
  });

  test('sizes', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(4096)).toBe('4 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('the request, read to its end before anything is saved', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const answer = (res: Response) => {
    globalThis.fetch = (async () => res) as unknown as typeof fetch;
  };
  const phases: string[] = [];
  const track = (p: { kind: string }) => void phases.push(p.kind);

  /** A body sent in the given pieces, ending cleanly, announcing `declared` bytes. */
  const file = (pieces: string[], declared: number | null, headers: Record<string, string> = {}) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (const p of pieces) c.enqueue(new TextEncoder().encode(p));
          c.close();
        },
      }),
      {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="nya-data-2026-10-06.json"',
          ...(declared === null ? {} : { 'x-nya-export-bytes': String(declared) }),
          ...headers,
        },
      }
    );
  const WHOLE = ['{"format":', '"nya-export"}'];
  const SIZE = new TextEncoder().encode(WHOLE.join('')).byteLength;

  test('a whole file, with its caveats, named with the viewer’s date', async () => {
    phases.length = 0;
    answer(file(WHOLE, SIZE, { 'x-nya-export-notes': encodeURIComponent(JSON.stringify(['a caveat'])) }));
    const out = await requestFile('json', null, track);
    expect(out).toMatchObject({ ok: true, filename: `nya-data-${localDate()}.json`, notes: ['a caveat'], incomplete: [] });
    expect(await (out as { blob: Blob }).blob.text()).toBe('{"format":"nya-export"}');
    expect(phases).toEqual(['preparing', 'receiving', 'receiving']);
  });

  test('a file missing something is saved, with the parts the server said it is missing them from', async () => {
    answer(file(WHOLE, SIZE, { 'x-nya-export-incomplete': 'account_history, holdings:history', 'x-nya-export-notes': encodeURIComponent(JSON.stringify(['what is missing'])) }));
    expect(await requestFile('json', null, () => {})).toMatchObject({ ok: true, notes: ['what is missing'], incomplete: ['account_history', 'holdings:history'] });
    expect(incompleteOf(null)).toEqual([]);
    expect(incompleteOf(' , ')).toEqual([]);
  });

  test('a body that ends early without an error saves nothing', async () => {
    // What a platform ending the stream at its time limit looks like: a clean end, short.
    answer(file(['{"format":'], SIZE));
    expect(await requestFile('json', null, () => {})).toEqual({ ok: false, error: CUT_OFF });
  });

  test('more than was announced saves nothing either', async () => {
    answer(file([...WHOLE, 'extra'], SIZE));
    expect(await requestFile('json', null, () => {})).toEqual({ ok: false, error: CUT_OFF });
  });

  test('a file whose size wasn’t announced saves nothing, and isn’t downloaded', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(c) {
        c.enqueue(new TextEncoder().encode('{}'));
      },
      cancel() {
        cancelled = true;
      },
    });
    answer(new Response(body, { headers: { 'content-type': 'application/json' } }));
    expect(await requestFile('json', null, () => {})).toEqual({ ok: false, error: CUT_OFF });
    expect(cancelled).toBe(true);
    for (const bad of ['', 'twelve', '-1', '1.5']) {
      answer(file(WHOLE, null, { 'x-nya-export-bytes': bad }));
      expect(await requestFile('json', null, () => {})).toEqual({ ok: false, error: CUT_OFF });
    }
  });

  test('a connection cut part way saves nothing', async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"format":'));
        c.error(new Error('connection reset'));
      },
    });
    answer(new Response(body, { headers: { 'x-nya-export-bytes': String(SIZE) } }));
    expect(await requestFile('json', null, () => {})).toEqual({ ok: false, error: CUT_OFF });
  });

  test('Clerk’s hint is handed back for its hook, and says it is confirming', async () => {
    phases.length = 0;
    const hint = { clerk_error: { type: 'forbidden', reason: 'reverification-error', metadata: { reverification: 'strict' } } };
    answer(Response.json(hint, { status: 403 }));
    expect(await requestFile('json', null, track)).toEqual(hint);
    expect(phases).toEqual(['preparing', 'confirming']);
  });

  test('a refusal brings its reason; a wrong password is not a sign-out', async () => {
    answer(Response.json({ error: 'That password isn’t right.', wrong_password: true }, { status: 403 }));
    expect(await requestFile('json', 'nope', () => {})).toEqual({ ok: false, error: 'That password isn’t right.' });
    answer(Response.json({ error: 'You can download your data 5 times an hour. Try again in 12 minutes.' }, { status: 429 }));
    expect(await requestFile('balances-csv', 'x', () => {})).toEqual({ ok: false, error: 'You can download your data 5 times an hour. Try again in 12 minutes.' });
  });

  test('sends the password only when there is one', async () => {
    const sent: unknown[] = [];
    globalThis.fetch = (async (_: unknown, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ error: 'x' }, { status: 500 });
    }) as unknown as typeof fetch;
    await requestFile('json', null, () => {});
    await requestFile('transactions-csv', 'hunter2', () => {});
    expect(sent).toEqual([{ format: 'json' }, { format: 'transactions-csv', password: 'hunter2' }]);
  });

  test('no network at all', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await requestFile('json', null, () => {})).toEqual({ ok: false, error: 'Nya could not be reached. Check your connection and try again.' });
  });
});
