import { describe, expect, test, mock, afterEach } from 'bun:test';
// Every name the app's components take from Clerk's client, so this mock can
// stand in for another file's while they share the process.
mock.module('@clerk/nextjs', () => ({
  useClerk: () => ({ signOut: async () => {} }),
  useReverification: (fetcher: unknown) => fetcher,
}));
const { renderToStaticMarkup } = await import('react-dom/server');
const { DownloadMyDataView, requestFile, formatBytes, FORMATS } = await import('@/components/DownloadMyData');

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
    expect(html).toContain('everything Nya keeps for you');
    expect(html).toContain('Left out: the access tokens Nya uses to reach your banks through Plaid');
    expect(html).toContain('isn’t encrypted');
    expect(html).toContain('Up to 5 downloads an hour.');
    for (const f of FORMATS) expect(html).toContain(f.label);
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
    for (const phase of [{ kind: 'confirming' }, { kind: 'preparing' }, { kind: 'receiving', bytes: 2048 }] as Phase[]) {
      const html = view({ phase });
      expect(button(html)[0]).toMatch(/disabled/);
      expect(button(html)[1]).toBe('Preparing…');
      expect(html).toMatch(/<fieldset[^>]*disabled/);
    }
    expect(view({ phase: { kind: 'confirming' } })).toContain('Confirm it’s you in the window that opened.');
    expect(view({ phase: { kind: 'receiving', bytes: 2048 } })).toContain('Downloading… 2 KB');
  });

  test('done: what was saved, and any caveat that came with it', () => {
    const html = view({ phase: { kind: 'done', filename: 'nya-data-2026-10-06.json', bytes: 1_572_864, notes: ['Nya could not save the newest transactions from Chase.'] } });
    expect(html).toContain('Saved nya-data-2026-10-06.json (1.5 MB).');
    expect(html).toContain('Nya could not save the newest transactions from Chase.');
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

  test('a whole file, with its name and caveats', async () => {
    phases.length = 0;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"format":'));
        c.enqueue(new TextEncoder().encode('"nya-export"}'));
        c.close();
      },
    });
    answer(
      new Response(body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="nya-data-2026-10-06.json"',
          'x-nya-export-notes': encodeURIComponent(JSON.stringify(['a caveat'])),
        },
      })
    );
    const out = await requestFile('json', null, track);
    expect(out).toMatchObject({ ok: true, filename: 'nya-data-2026-10-06.json', notes: ['a caveat'] });
    expect(await (out as { blob: Blob }).blob.text()).toBe('{"format":"nya-export"}');
    expect(phases).toEqual(['preparing', 'receiving', 'receiving']);
  });

  test('a connection cut part way saves nothing', async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"format":'));
        c.error(new Error('connection reset'));
      },
    });
    answer(new Response(body, { headers: { 'content-disposition': 'attachment; filename="x.json"' } }));
    expect(await requestFile('json', null, () => {})).toEqual({ ok: false, error: 'The download was cut off part way, so nothing was saved. Try again.' });
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
