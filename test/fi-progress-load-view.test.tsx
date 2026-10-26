import { afterAll, describe, expect, test } from 'bun:test';
import { installDom } from './mini-dom';

// Home's FI line as it loads the saved plan (components/FiProgressCard.tsx,
// rollout phase 8b, from 4c's review): a saved plan that can't be read gets
// a line saying so, which opens the Plan tab; a request that failed shows
// nothing, as before, so Home stays as it was.

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
const { default: FiProgressCard } = await import('@/components/FiProgressCard');

/** The FI line, with /api/fire-plan answering as given. */
async function line(answer: () => Promise<Response>) {
  (globalThis as { fetch: unknown }).fetch = answer;
  const container = dom.document.createElement('ul');
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<FiProgressCard txns={[]} txnsLoading={false} txnNotes={[]} institutions={[]} currency="USD" onOpenPlan={() => {}} />));
  await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
  const text = container.textContent;
  await act(async () => root.unmount());
  return text;
}
const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Home’s FI line as the saved plan loads', () => {
  test('a saved plan the store says it can’t read: a line saying so, opening the Plan tab', async () => {
    expect(await line(json({ error: 'Your saved plan couldn’t be read.', unreadable: true }, 409))).toBe('FI isn’t worked outYour saved plan couldn’t be read: the Plan tab says why.');
  });

  test('a saved plan this release can’t take (a newer one’s shape): the same line', async () => {
    expect(await line(json({ plan: { version: 2 }, currency: null }))).toBe('FI isn’t worked outYour saved plan couldn’t be read: the Plan tab says why.');
  });

  test('a request that failed, a network error or an answer with no plan: nothing, as before', async () => {
    expect(await line(json({ error: 'Failed to read plan assumptions' }, 500))).toBe('');
    expect(await line(json({ error: 'stale' }, 409))).toBe('');
    expect(await line(async () => Promise.reject(new Error('offline')))).toBe('');
    expect(await line(json({}))).toBe('');
  });
});
