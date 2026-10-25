import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignInFlow, SignInPlaceholder } from '@/components/SignInFlow';
import { demoStart, demoStep, type DemoState } from '@/components/sign-in-view';

// The sign-in page's frame (components/SignInFlow.tsx): the page, or, while
// a demo sign-in is on its way, the app loading with the page hidden under it
// and Clerk's form still mounted; and where a demo sign-in is
// (components/sign-in-view.ts).

const page = <p className="page-body">Clerk&apos;s form</p>;

describe('the sign-in page as the server draws it', () => {
  test('the page itself', () => {
    const html = renderToStaticMarkup(<SignInFlow demoTicket={false}>{page}</SignInFlow>);
    expect(html).toBe('<main class="auth-wrap"><p class="page-body">Clerk&#x27;s form</p></main>');
  });

  test('with a demo button’s ticket: the app loading, the page hidden but there', () => {
    const html = renderToStaticMarkup(<SignInFlow demoTicket>{page}</SignInFlow>);
    expect(html).toContain('<main class="auth-wrap" hidden=""><p class="page-body">Clerk&#x27;s form</p></main>');
    expect(html.indexOf('<main class="wrap">')).toBeGreaterThan(html.indexOf('<main class="auth-wrap" hidden="">'));
    expect(html).toContain('<p class="sub">Loading your accounts…</p>');
    expect(html).toContain('aria-busy="true"');
  });

  test('Clerk’s form’s place: its placeholder, said to be loading, and no notice yet', () => {
    const html = renderToStaticMarkup(<SignInPlaceholder />);
    expect(html).toStartWith('<div class="signin-skeleton" role="status"><span class="visually-hidden">Loading the sign-in form</span>');
    expect(html).not.toContain('notice');
  });
});

describe('a demo sign-in', () => {
  const press = (s: DemoState) => demoStep(s, { type: 'press' });
  const waited = (s: DemoState, attempt: number) => demoStep(s, { type: 'waited', attempt });

  test('on its way from the start only on a demo ticket’s page', () => {
    expect(demoStart(true)).toEqual({ pending: true, attempt: 0 });
    expect(demoStart(false)).toEqual({ pending: false, attempt: 0 });
  });

  test('on its way from a press, until its wait is over', () => {
    const s = press(demoStart(false));
    expect(s).toEqual({ pending: true, attempt: 1 });
    expect(waited(s, 1)).toEqual({ pending: false, attempt: 1 });
  });

  test('a ticket that never signs in: the page again after its wait', () => {
    expect(waited(demoStart(true), 0).pending).toBe(false);
  });

  test('a press after the page came back waits again, and an earlier wait ends nothing', () => {
    const back = waited(press(demoStart(true)), 1);
    expect(back.pending).toBe(false);
    const again = press(back);
    expect(again).toEqual({ pending: true, attempt: 2 });
    // The first press's wait, or the ticket's, landing late.
    expect(waited(again, 1)).toEqual(again);
    expect(waited(again, 0)).toEqual(again);
    expect(waited(again, 2).pending).toBe(false);
  });

  test('a sign-in that failed, or back from the browser’s cache: the page', () => {
    expect(demoStep(press(demoStart(false)), { type: 'failed' }).pending).toBe(false);
    expect(demoStep(press(demoStart(false)), { type: 'back' }).pending).toBe(false);
  });
});
