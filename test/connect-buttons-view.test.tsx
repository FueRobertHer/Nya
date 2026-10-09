import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectButtonsView, CONNECT_OPTIONS } from '@/components/ConnectButtons';
import type { LinkKind } from '@/lib/item-products';

// The two ways to connect (components/ConnectButtons.tsx): what each says, and
// which link token each asks for (app/api/create-link-token).

const noop = () => {};
const view = (over: Partial<Parameters<typeof ConnectButtonsView>[0]> = {}) =>
  renderToStaticMarkup(<ConnectButtonsView connecting={false} starting={null} onConnect={noop} {...over} />);
const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map((m) => ({ attrs: m[1], label: m[2] }));

/** Every <button> element in a rendered tree, without a DOM. */
function buttonElements(node: ReactNode): ReactElement<{ onClick: () => void }>[] {
  if (Array.isArray(node)) return node.flatMap(buttonElements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<{ children?: ReactNode; onClick: () => void }>;
  return [...(el.type === 'button' ? [el] : []), ...buttonElements(el.props.children)];
}

describe('the two ways to connect', () => {
  test('each says what it is for, the bank option first and filled', () => {
    const html = view();
    const shown = buttons(html);
    expect(shown.map((b) => b.label)).toEqual(['Connect a bank or card', 'Connect a brokerage or retirement account']);
    expect(html).toContain('Checking, savings, credit cards and loans, with their transactions.');
    expect(html).toContain('401(k)s, IRAs and brokerage accounts, including ones the bank option can’t find.');
    expect(shown[0].attrs).not.toContain('secondary');
    expect(shown[1].attrs).toContain('class="secondary"');
    for (const b of shown) expect(b.attrs).not.toContain('disabled');
  });

  test('each asks for its own kind of link', () => {
    const asked: LinkKind[] = [];
    const tree = ConnectButtonsView({ connecting: false, starting: null, onConnect: (kind) => asked.push(kind) });
    for (const button of buttonElements(tree)) button.props.onClick();
    expect(asked).toEqual(['bank', 'investments']);
  });

  test('while one starts, only it says so, and neither can be pressed', () => {
    for (const kind of ['bank', 'investments'] as const) {
      const shown = buttons(view({ connecting: true, starting: kind }));
      expect(shown.map((b) => b.label)).toEqual(CONNECT_OPTIONS.map((o) => (o.kind === kind ? 'Starting…' : o.label)));
      for (const b of shown) expect(b.attrs).toContain('disabled');
    }
  });

  test('a flow started elsewhere (Reconnect, say) holds both, naming neither', () => {
    const shown = buttons(view({ connecting: true, starting: null }));
    expect(shown.map((b) => b.label)).toEqual(CONNECT_OPTIONS.map((o) => o.label));
    for (const b of shown) expect(b.attrs).toContain('disabled');
  });

  // Read from the source, as test/public-pages.test.tsx does: the dashboard
  // needs Clerk and Plaid Link to render.
  test('the dashboard asks for the kind pressed, and a different login is connected the same way', () => {
    const dashboard = readFileSync(join(import.meta.dir, '..', 'components', 'Dashboard.tsx'), 'utf8');
    expect(dashboard).toContain("fetch('/api/create-link-token', {");
    expect(dashboard).toContain('body: JSON.stringify({ kind }),');
    expect(dashboard).toContain('beginConnect(shownRedirect.kind, true);');
  });
});
