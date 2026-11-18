import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { clerk } from './clerk-mock';
import { mockForFile } from './scoped-mock';

// Not allowed yet (app/not-allowed/page.tsx), as the server draws it for a
// signed-in Clerk account that isn't on the list: the sign-in page's layout,
// one card on the primitives, and Sign out as Nya's own secondary button.
// Clerk's SignOutButton passes its one child through, as it does.

await mockForFile('@clerk/nextjs', () => ({ SignOutButton: ({ children }: { children: unknown }) => children }));
const { default: NotAllowedPage } = await import('@/app/not-allowed/page');

const saved = { ...process.env };
beforeAll(() => {
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  clerk.signedIn = 'user_2notallowedyet';
});
afterAll(() => {
  process.env = saved;
  clerk.signedIn = null;
});

describe('Not allowed yet', () => {
  test('one card on the primitives: its title in the card header, its words in a stack, nothing styled inline', async () => {
    const html = renderToStaticMarkup(await NotAllowedPage());
    expect(html).toStartWith('<main class="auth-wrap"><div class="brand">');
    expect(html).toContain('<div class="card not-allowed-card"><div class="card-header"><h2>Not allowed yet</h2></div><div class="stack">');
    expect(html).not.toContain('style=');
  });

  test('says what to do, with the account’s own id and nothing else about it', async () => {
    const html = renderToStaticMarkup(await NotAllowedPage());
    expect(html).toContain('You&#x27;re signed in, but this account can&#x27;t open Nya yet. Ask to be added by your email, or by this account&#x27;s id:');
    expect(html).toContain('<code>user_2notallowedyet</code>');
  });

  test('Sign out is a secondary .btn in a button row, not a full-width bare button', async () => {
    const html = renderToStaticMarkup(await NotAllowedPage());
    expect(html).toContain('<div class="btn-row"><button type="button" class="btn secondary">Sign out</button></div>');
  });
});
