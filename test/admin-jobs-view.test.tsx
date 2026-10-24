import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { installDom, click, type FakeElement } from './mini-dom';

// The admin's card on Home: a nightly job that failed, where to look, and a
// button that runs it again now (app/api/admin/jobs). Rendered and used as a
// person would (react-dom/client over test/mini-dom.ts), with the route's
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
const { AdminAttention } = await import('@/components/NeedsAttention');
type Problems = import('@/components/NeedsAttention').JobProblems;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const failedBackup = { last_ok: '2026-10-20T16:00:00Z', reason: 'timeout' };
const failedFiles = { last_ok: null, reason: 'The file store didn’t answer a listing within 30s.', held: false };

/** What the route was sent, and what it answers next. */
let sent: unknown[] = [];
let answer: () => Promise<Response> = async () => new Response('{}');
beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return answer();
  }) as unknown as typeof fetch;
});

const json = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

/** Mounts the card, the way Home does: its problems in state, updated from
 *  what a run answers. */
function mount(initial: Problems) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  const changes: Problems[] = [];
  function Home() {
    const [p, setP] = React.useState(initial);
    return (
      <AdminAttention
        backup={p.backup}
        files={p.files}
        onChanged={(now) => {
          changes.push(now);
          setP(now);
        }}
      />
    );
  }
  act(() => root.render(<Home />));
  const body = dom.document.body as unknown as FakeElement;
  return {
    changes,
    text: () => body.textContent.replace(/\s+/g, ' ').trim(),
    buttons: () => body.findAll((e) => e.tagName === 'BUTTON'),
    unmount: () => {
      act(() => root.unmount());
      host.parentNode?.removeChild(host);
    },
  };
}

/** Clicks and lets the answer arrive. */
async function press(el: FakeElement) {
  await act(async () => {
    click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('running a nightly job again from the admin’s card', () => {
  test('each failed job’s row keeps its words and gets a button; one the breaker held gets none', () => {
    const card = mount({ backup: failedBackup, files: failedFiles });
    expect(card.text()).toContain('Check the backup cron in Vercel.');
    expect(card.text()).toContain('Check the clean-up cron in Vercel.');
    expect(card.buttons().map((b) => b.textContent)).toEqual(['Run again', 'Run again']);
    card.unmount();
    const held = mount({ backup: null, files: { last_ok: null, reason: null, held: true } });
    expect(held.text()).toContain('Its log in Vercel names the account.');
    expect(held.buttons()).toHaveLength(0);
    held.unmount();
  });

  test('a run that works clears its row, says so, and hands Home what the dashboard now says', async () => {
    answer = json(200, { backup_problem: null, attachments_problem: failedFiles });
    const card = mount({ backup: failedBackup, files: failedFiles });
    await press(card.buttons()[0]);
    expect(sent).toEqual([{ job: 'backup' }]);
    expect(card.changes).toEqual([{ backup: null, files: failedFiles }]);
    expect(card.text()).not.toContain('Check the backup cron in Vercel.');
    expect(card.text()).toContain('The backup ran and was saved.');
    // The other job's row stays, with its button.
    expect(card.buttons().map((b) => b.textContent)).toEqual(['Run again']);
    card.unmount();
  });

  test('the last row cleared: the card stays to say it ran', async () => {
    answer = json(200, { backup_problem: null, attachments_problem: null });
    const card = mount({ backup: null, files: failedFiles });
    await press(card.buttons()[0]);
    expect(sent).toEqual([{ job: 'files' }]);
    expect(card.text()).toBe('AdminThe clean-up ran.');
    card.unmount();
  });

  test('a run that fails again says so, with the new reason in the row', async () => {
    answer = json(500, { error: 'boom', backup_problem: { last_ok: '2026-10-20T16:00:00Z', reason: 'boom' }, attachments_problem: null });
    const card = mount({ backup: failedBackup, files: null });
    await press(card.buttons()[0]);
    expect(card.text()).toContain('(boom)');
    expect(card.text()).toContain('It failed again.');
    expect(card.buttons().map((b) => b.textContent)).toEqual(['Run again']);
    card.unmount();
  });

  test('while its cron may be running, the route’s words say when to try', async () => {
    answer = json(409, { error: 'Its nightly run may still be going. Try again in 12 minutes.' });
    const card = mount({ backup: failedBackup, files: null });
    await press(card.buttons()[0]);
    expect(card.changes).toEqual([]);
    expect(card.text()).toContain('Try again in 12 minutes.');
    card.unmount();
  });

  test('while one runs, every button is held and the row says it can take a while', async () => {
    let finish: (r: Response) => void = () => {};
    answer = () => new Promise((r) => (finish = r));
    const card = mount({ backup: failedBackup, files: failedFiles });
    await press(card.buttons()[0]);
    expect(card.buttons().map((b) => [b.textContent, b.getAttribute('disabled') !== null])).toEqual([
      ['Running…', true],
      ['Run again', true],
    ]);
    expect(card.text()).toContain('This can take up to five minutes.');
    await act(async () => {
      finish(new Response('nope', { status: 502 }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(card.text()).toContain('Could not run it right now.');
    expect(card.buttons().every((b) => b.getAttribute('disabled') === null)).toBe(true);
    card.unmount();
  });
});
