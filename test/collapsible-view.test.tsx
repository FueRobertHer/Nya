import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollapsibleHeader } from '@/components/Collapsible';
import { SharedWithMeView } from '@/components/Sharing';

// The sections at the foot of the Accounts tab open and close on their
// titles (rollout phase 3): Hidden, Accounts that ended, Shared with me. The
// title is a heading holding one button, so it can be reached by heading
// and says whether it is open.

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

describe('a collapsible card header', () => {
  test('a heading holding one button that says whether it is open, with its count and status after the title', () => {
    const html = renderToStaticMarkup(
      <CollapsibleHeader title="Accounts that ended" count={2} status={<span className="badge warn">1 to confirm</span>} open={false} onToggle={() => {}} controls="ended" />
    );
    expect(html).toStartWith('<div class="card-header"><h2><button type="button" class="section-toggle" aria-expanded="false">');
    expect(text(html)).toBe('Accounts that ended 2 1 to confirm');
    expect(html).toContain('<span class="badge">2</span><span class="badge warn">1 to confirm</span>');
    // Only an open one names what it opens: a closed one has nothing there.
    expect(html).not.toContain('aria-controls');
    const open = renderToStaticMarkup(<CollapsibleHeader title="Hidden" open onToggle={() => {}} controls="hidden-accounts" />);
    expect(open).toContain('aria-expanded="true" aria-controls="hidden-accounts"');
    expect(open).not.toContain('class="badge"');
  });
});

describe('Shared with me', () => {
  test('under its own heading, open, once something is shared; nothing at all while nothing is', () => {
    const html = renderToStaticMarkup(<SharedWithMeView data={{ shared: [{ connection: 'c1', label: 'Sam', accounts: [], expires_at: null }] }} />);
    expect(html).toContain('<h2><button type="button" class="section-toggle" aria-expanded="true" aria-controls="shared-with-me">');
    expect(text(html)).toContain('Shared with me');
    expect(text(html)).toContain('Shared by Sam');
    expect(renderToStaticMarkup(<SharedWithMeView data={{ shared: [] }} />)).toBe('');
  });
});
