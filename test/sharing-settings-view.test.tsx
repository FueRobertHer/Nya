import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type FakeElement } from './mini-dom';

// Settings > Sharing (components/Sharing.tsx SharingSettings), used as a
// person would (react-dom/client over test/mini-dom.ts), with the sharing
// routes answered here: the list is in place, a person opens in a sheet of
// their own with What they see one level deeper and Back to come out of it,
// the sheet keeps its content while it slides away, and once a person is
// removed (their row gone with them) focus lands on the People card's title
// under the line saying so.

const dom = installDom();
const g = globalThis as Record<string, unknown>;
const realFetch = globalThis.fetch;
const realConfirm = (dom.document.defaultView as Record<string, unknown>).confirm;
afterAll(() => {
  globalThis.fetch = realFetch;
  (dom.document.defaultView as Record<string, unknown>).confirm = realConfirm;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
// React's client reads what the document supports once, when it loads: it is
// loaded afresh, after this file put a document there.
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { SharingSettings } = await import('@/components/Sharing');

(g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pat = { id: 'c1', label: 'Pat', introduced_as: 'Patricia', since: '2026-09-28', sharing: { a: 'balance' }, expires_at: null };
let connections = [pat];
let blocked = [{ id: 'c8', label: 'Ex' }, { id: 'c9', label: 'Old' }];
const asked: string[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const path = String(url).split('?')[0];
  asked.push(`${method} ${path}`);
  if (path === '/api/connections' && method === 'DELETE') {
    const id = JSON.parse(String(init?.body)).id;
    connections = connections.filter((c) => c.id !== id);
    blocked = blocked.filter((b) => b.id !== id);
    return Response.json({});
  }
  if (path === '/api/connections') return Response.json({ enabled: true, connections, blocked, accounts: [{ id: 'a', label: 'Chase Checking ••1111' }] });
  if (path === '/api/connections/access-log') return Response.json({ damaged: [], maybe_connected: false });
  if (path === '/api/connections/records') return Response.json({ connection: 'c1', record_id: null, record_since: null, shown_to_them: { days: [], total_days: 0 }, shown_to_me: { days: [], total_days: 0 } });
  if (path === '/api/connections/preview') return Response.json({ connection: 'c1', view: null });
  return new Response(null, { status: 404 });
}) as typeof fetch;
(dom.document.defaultView as Record<string, unknown>).confirm = () => true;

const settle = (ms = 5) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const all = (root: FakeElement, pick: (e: FakeElement) => boolean) => root.findAll(pick);
const button = (root: FakeElement, label: string) => all(root, (e) => e.tagName === 'BUTTON' && (e.textContent.trim() === label || e.getAttribute('aria-label') === label))[0];
const dialog = () => all(dom.document.body, (e) => e.getAttribute('role') === 'dialog')[0];

describe('Settings > Sharing', () => {
  test('the list in place, each person in their own sheet, and focus after a removal', async () => {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    act(() => root.render(<SharingSettings />));
    await settle();
    expect(asked).toEqual(['GET /api/connections', 'GET /api/connections/access-log']);

    // In place: the invite, the people and the blocked, no sheet open.
    expect(all(host, (e) => e.tagName === 'H2').map((h) => h.textContent.trim())).toEqual(['Invite someone', 'People', 'Blocked']);
    expect(dialog()).toBeUndefined();
    const row = all(host, (e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'list-row')[0];
    expect(row.getAttribute('aria-haspopup')).toBe('dialog');
    expect(row.textContent).toContain('Pat');

    // A person opens in their sheet, with their records asked for. (A browser
    // focuses a button as it is pressed: the sheet hands focus back to it.)
    row.focus();
    act(() => click(row));
    await settle();
    expect(asked).toContain('GET /api/connections/records');
    expect(dialog().getAttribute('aria-label')).toBe('Pat');
    expect(button(dialog(), 'Back')).toBeUndefined();
    expect(dialog().textContent).toContain('What you call them');

    // What they see is one level in, with Back.
    act(() => click(button(dialog(), 'See what Pat sees')));
    await settle();
    expect(dialog().getAttribute('aria-label')).toBe('What Pat sees');
    act(() => click(button(dialog(), 'Back')));
    expect(dialog().getAttribute('aria-label')).toBe('Pat');

    // Closed, it keeps Pat's content while it slides away, then goes.
    act(() => click(button(dialog(), 'Close')));
    expect(dialog().getAttribute('aria-label')).toBe('Pat');
    expect(dialog().textContent).toContain('What you call them');
    await settle(360);
    expect(dialog()).toBeUndefined();

    // Removed from their sheet: the row is gone, so focus goes to People,
    // under the line saying what was done.
    const again = all(host, (e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'list-row')[0];
    again.focus();
    act(() => click(again));
    await settle();
    act(() => click(button(dialog(), 'Remove')));
    await settle(20);
    expect(asked.filter((a) => a === 'DELETE /api/connections')).toHaveLength(1);
    expect(all(host, (e) => e.tagName === 'BUTTON' && e.getAttribute('class') === 'list-row')).toHaveLength(0);
    expect(dom.document.activeElement.getAttribute('id')).toBe('sharing-people-title');
    const status = all(host, (e) => e.getAttribute('role') === 'status')[0];
    expect(status.textContent).toBe('Removed.');
    expect(host.textContent).toContain('No one yet.');

    // Unblocked: the row is gone with them, so focus goes to the Blocked
    // card's title while it has someone, then to People once it is gone.
    const unblock = () => all(host, (e) => e.tagName === 'BUTTON' && e.textContent.trim() === 'Unblock');
    unblock()[0].focus();
    act(() => click(unblock()[0]));
    await settle(20);
    expect(unblock()).toHaveLength(1);
    expect(dom.document.activeElement.getAttribute('id')).toBe('sharing-blocked-title');
    expect(status.textContent).toBe('Unblocked.');
    unblock()[0].focus();
    act(() => click(unblock()[0]));
    await settle(20);
    expect(all(host, (e) => e.getAttribute('id') === 'sharing-blocked-title')).toHaveLength(0);
    expect(dom.document.activeElement.getAttribute('id')).toBe('sharing-people-title');

    act(() => root.unmount());
    await settle(360);
  });
});
