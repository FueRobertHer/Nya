import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, click, type FakeElement } from './mini-dom';

// The Add account sheet (rollout phase 3): every way to add an account, one
// row each, with what each service reaches and costs behind "Which should I
// use?". Rendered and used as a person would (react-dom/client over
// test/mini-dom.ts).

const dom = installDom();
afterAll(() => dom.uninstall());

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: AddAccountSheet } = await import('@/components/AddAccountSheet');
const { LUNCHFLOW_OPTION, SIMPLEFIN_OPTION } = await import('@/components/ConnectButtons');
type Props = Parameters<typeof AddAccountSheet>[0];

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noop = () => {};
const props = (over: Partial<Props> = {}): Props => ({
  open: true,
  onClose: noop,
  connecting: false,
  brokerage: true,
  onConnect: noop,
  onConnectSimpleFin: noop,
  onConnectLunchFlow: noop,
  onAddManual: noop,
  onSwitching: noop,
  ...over,
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
const titles = (html: string) => [...html.matchAll(/<span class="list-row-title">([^<]*)<\/span>/g)].map((m) => m[1]);

describe('the Add account sheet', () => {
  test('every way in, one row each, in order', () => {
    const html = renderToStaticMarkup(<AddAccountSheet {...props()} />);
    expect(html).toContain('aria-label="Add an account"');
    expect(titles(html)).toEqual([
      'Connect a bank or card',
      'Connect a brokerage or retirement account',
      'Connect with SimpleFIN',
      'Connect with Lunch Flow',
      'Add a manual account',
      'Switching from another app',
    ]);
    // Each row is one button: nothing inside it is another control.
    expect(html.match(/<button class="list-row"/g)).toHaveLength(6);
    expect(text(html)).toContain('Your own SimpleFIN account ($15 a year, paid to SimpleFIN), or Redbark');
    expect(text(html)).toContain('Monarch, YNAB, Lunch Money, Actual Budget or ZeroSum');
  });

  test('brokerage and Lunch Flow only where the deployment offers them', () => {
    const html = renderToStaticMarkup(<AddAccountSheet {...props({ brokerage: false, onConnectLunchFlow: undefined })} />);
    expect(titles(html)).toEqual(['Connect a bank or card', 'Connect with SimpleFIN', 'Add a manual account', 'Switching from another app']);
    expect(text(html)).not.toContain(LUNCHFLOW_OPTION.note);
  });

  test('which service reaches which banks, and what each costs, is behind "Which should I use?"', () => {
    const html = renderToStaticMarkup(<AddAccountSheet {...props()} />);
    expect(html).toContain('<details class="why"><summary>Which should I use?</summary>');
    const why = html.slice(html.indexOf('<details class="why">'));
    expect(text(why)).toContain('Bank connections through Plaid work for US institutions only.');
    expect(text(why)).toContain(text(SIMPLEFIN_OPTION.note));
    expect(text(why)).toContain(text(LUNCHFLOW_OPTION.note));
  });

  test('a Plaid row says Starting… and keeps the sheet open until Link has opened, then closes it', async () => {
    const events: string[] = [];
    let opened: () => void = noop;
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const render = (connecting: boolean) =>
      act(() =>
        root.render(
          <AddAccountSheet
            {...props({
              connecting,
              onClose: () => events.push('close'),
              onConnect: (kind) => {
                events.push(`connect ${kind}`);
                return new Promise<void>((resolve) => (opened = resolve));
              },
            })}
          />
        )
      );
    render(false);
    const row = (title: string) => (host as unknown as FakeElement).findAll((e) => e.getAttribute('class') === 'list-row' && e.textContent.includes(title))[0];
    act(() => click(row('Connect a brokerage or retirement account')));
    render(true);
    expect(events).toEqual(['connect investments']);
    expect(row('Starting…')).toBeDefined();
    expect(row('Connect a bank or card').getAttribute('disabled')).not.toBeNull();
    await act(async () => {
      opened();
    });
    expect(events).toEqual(['connect investments', 'close']);
    act(() => root.unmount());
  });

  test('a Plaid start that fails still closes the sheet, so the failure said on the tab can be seen', async () => {
    const events: string[] = [];
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    act(() => root.render(<AddAccountSheet {...props({ onClose: () => events.push('close'), onConnect: () => Promise.reject(new Error('offline')) })} />));
    const [row] = (host as unknown as FakeElement).findAll((e) => e.getAttribute('class') === 'list-row' && e.textContent.includes('Connect a bank or card'));
    await act(async () => {
      click(row);
    });
    expect(events).toEqual(['close']);
    act(() => root.unmount());
  });

  test('every other row closes this sheet before opening its own', () => {
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const events: string[] = [];
    act(() =>
      root.render(
        <AddAccountSheet
          {...props({
            onClose: () => events.push('close'),
            onConnectSimpleFin: () => events.push('simplefin'),
            onConnectLunchFlow: () => events.push('lunchflow'),
            onAddManual: () => events.push('manual'),
            onSwitching: () => events.push('switching'),
          })}
        />
      )
    );
    for (const title of ['Connect with SimpleFIN', 'Connect with Lunch Flow', 'Add a manual account', 'Switching from another app']) {
      const [row] = (host as unknown as FakeElement).findAll((e) => e.getAttribute('class') === 'list-row' && e.textContent.includes(title));
      act(() => click(row));
    }
    expect(events).toEqual(['close', 'simplefin', 'close', 'lunchflow', 'close', 'manual', 'close', 'switching']);
    act(() => root.unmount());
  });
});
