import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppLoading, HomeSkeleton, SignInSkeleton } from '@/components/LoadingSkeletons';
import NetWorthCard from '@/components/NetWorthCard';
import NetWorthChart from '@/components/NetWorthChart';
import { DEMO_WAIT_MS, goesHome, signInView } from '@/components/sign-in-view';

// What screens show while they load (components/LoadingSkeletons.tsx): Home's
// Net worth card drawn on its own classes with placeholders for its figures,
// the app loading as a page for the sign-in and login pages to hand over to,
// and Clerk's form's placeholder. And when the sign-in page hands over
// (components/sign-in-view.ts).

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const classesOf = (html: string) => new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(' ')));

describe('Home while it loads', () => {
  const html = renderToStaticMarkup(<HomeSkeleton />);

  test('the Net worth card, busy, its title in words and its figures as placeholders', () => {
    expect(html).toContain('<section class="card stack net-worth-card" aria-busy="true" aria-labelledby="net-worth-loading">');
    expect(html).toContain('<h2 id="net-worth-loading" class="total-label">Net worth</h2>');
    expect(html).toContain('<p class="visually-hidden" role="status">Loading</p>');
    // No figure, and nothing a screen reader reads but the title and the status.
    expect(text(html)).toBe('Net worth Loading');
  });

  test('drawn on the classes of the card and chart it stands for, so it is as tall as they are', () => {
    const points = Array.from({ length: 60 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 1) + i * 864e5).toISOString().slice(0, 10), value: 1000 + i }));
    const real = classesOf(
      renderToStaticMarkup(
        <NetWorthCard
          worth={1000}
          currency="USD"
          delta={<div className="hero-delta up">up</div>}
          caveats={[]}
          chart={<NetWorthChart points={points} />}
          pausedSince={null}
          notesProblem={null}
          backupProblem={null}
          filesProblem={null}
          asOf="2026-10-23T09:14:00Z"
          refreshing={false}
          notesCount={0}
          onNotes={() => {}}
        />
      )
    );
    const layout = [...classesOf(html)].filter((c) => !c.startsWith('skeleton') && c !== 'block' && c !== 'visually-hidden');
    expect(layout.filter((c) => !real.has(c))).toEqual([]);
    for (const c of ['total-value', 'hero-delta', 'chart-readout', 'chart-readout-date', 'chart-info-btn', 'chart-ranges', 'chart-range', 'net-worth-foot']) expect(layout).toContain(c);
  });
});

describe('the app loading, as a page', () => {
  test('the dashboard header with its loading line, its buttons outlined, and Home loading', () => {
    const html = renderToStaticMarkup(<AppLoading account="clerk" />);
    expect(html).toContain('<main class="wrap"><div class="top-row">');
    expect(html).toContain('<h1>Nya</h1>');
    expect(html).toContain('<p class="sub" role="status">Loading your accounts…</p>');
    expect(html).toContain(
      '<div class="top-actions" aria-hidden="true"><span class="skeleton skeleton-icon-btn"></span><span class="skeleton skeleton-icon-btn"></span><span class="user-button-slot"><span class="skeleton skeleton-avatar"></span></span></div>'
    );
    expect(html).toContain(renderToStaticMarkup(<HomeSkeleton />));
  });

  test('password mode: the Settings gear in place of the account menu', () => {
    const html = renderToStaticMarkup(<AppLoading account="password" />);
    expect(html).not.toContain('user-button-slot');
    expect(html.match(/skeleton-icon-btn/g)?.length).toBe(3);
  });
});

describe('Clerk’s form while it loads', () => {
  test('a card of placeholders, said to be loading', () => {
    const html = renderToStaticMarkup(<SignInSkeleton />);
    expect(html).toStartWith('<div class="signin-skeleton" role="status"><span class="visually-hidden">Loading the sign-in form</span>');
    expect(text(html)).toBe('Loading the sign-in form');
    expect(html).toContain('<div class="signin-skeleton-card" aria-hidden="true">');
    expect(html).toContain('<div class="signin-skeleton-foot" aria-hidden="true">');
  });
});

describe('when the sign-in page hands over to the app', () => {
  const view = (over: Partial<Parameters<typeof signInView>[0]> = {}) => signInView({ signedIn: false, home: true, demo: false, waited: false, ...over });

  test('signed in, with Home next: the app loading', () => {
    expect(view({ signedIn: true })).toBe('loading');
    expect(view({ signedIn: true, demo: true, waited: true })).toBe('loading');
  });

  test('signed in for somewhere else (an invite link): the page, where Clerk says so', () => {
    expect(view({ signedIn: true, home: false })).toBe('page');
  });

  test('a demo sign-in on its way: the app loading, until it has waited too long', () => {
    expect(view({ demo: true })).toBe('signing-in');
    expect(view({ demo: true, waited: true })).toBe('page');
    expect(DEMO_WAIT_MS).toBeGreaterThanOrEqual(5_000);
  });

  test('otherwise the page', () => {
    expect(view()).toBe('page');
    expect(view({ home: false })).toBe('page');
  });

  test('Home is next with no redirect_url or one to "/", with its query', () => {
    expect(goesHome(undefined)).toBe(true);
    expect(goesHome('/')).toBe(true);
    expect(goesHome('/?view=connections')).toBe(true);
    expect(goesHome('https://nya.example/?view=connections')).toBe(true);
    expect(goesHome('/connect/abc123')).toBe(false);
    expect(goesHome('/reports')).toBe(false);
    expect(goesHome(['/', '/reports'])).toBe(false);
  });
});
