import { describe, expect, mock, test } from 'bun:test';
// Every name the app's client components take from Clerk in a test (this
// file's useAuth, and test/api-changes-view.test.tsx's two): Bun's module
// mocks are process-wide, so a later file still finds those.
mock.module('@clerk/nextjs', () => ({
  useAuth: () => ({ isLoaded: false, isSignedIn: undefined }),
  useClerk: () => ({ signOut: async () => {} }),
  useReverification: (fetcher: unknown) => fetcher,
}));
const { renderToStaticMarkup } = await import('react-dom/server');
const { SignInFlow } = await import('@/components/SignInFlow');

// The sign-in page's frame (components/SignInFlow.tsx), as the server draws
// it before Clerk has loaded: the page, or, on a demo button's ticket, the
// app loading with the page hidden under it, Clerk's form still mounted.

const page = <p className="page-body">Clerk&apos;s form</p>;

describe('the sign-in page as the server draws it', () => {
  test('the page itself', () => {
    const html = renderToStaticMarkup(
      <SignInFlow demoTicket={false} home>
        {page}
      </SignInFlow>
    );
    expect(html).toBe('<main class="auth-wrap"><p class="page-body">Clerk&#x27;s form</p></main>');
  });

  test('with a demo button’s ticket: the app loading, the page hidden but there', () => {
    const html = renderToStaticMarkup(
      <SignInFlow demoTicket home>
        {page}
      </SignInFlow>
    );
    expect(html).toContain('<main class="auth-wrap" hidden=""><p class="page-body">Clerk&#x27;s form</p></main>');
    expect(html.indexOf('<main class="wrap">')).toBeGreaterThan(html.indexOf('<main class="auth-wrap" hidden="">'));
    expect(html).toContain('<p class="sub" role="status">Loading your accounts…</p>');
    expect(html).toContain('aria-busy="true"');
  });
});
