import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppLoading, HomeSkeleton, SignInSkeleton } from '@/components/LoadingSkeletons';
import NetWorthCard from '@/components/NetWorthCard';
import NetWorthChart from '@/components/NetWorthChart';

// What screens show while they load (components/LoadingSkeletons.tsx): Home's
// Net worth card drawn on its own classes with placeholders for its figures,
// the app loading as a page (what Home streams while it reads the session,
// and what the sign-in and login pages hand over to), and Clerk's form's
// placeholder.

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
    // Its own classes are the placeholders and their sizes; every other is the card's or the chart's.
    const layout = [...classesOf(html)].filter((c) => c !== 'skeleton' && c !== 'block' && !c.startsWith('home-skeleton-') && c !== 'visually-hidden');
    expect(layout.filter((c) => !real.has(c))).toEqual([]);
    for (const c of ['total-value', 'hero-delta', 'chart-readout', 'chart-readout-date', 'chart-info-btn', 'chart-ranges', 'chart-range', 'net-worth-foot']) expect(layout).toContain(c);
  });
});

describe('the app loading, as a page', () => {
  test('the dashboard header with its loading line, its buttons outlined, and Home loading', () => {
    const html = renderToStaticMarkup(<AppLoading account="clerk" />);
    expect(html).toContain('<main class="wrap"><div class="top-row">');
    expect(html).toContain('<h1>Nya</h1>');
    expect(html).toContain('<p class="sub">Loading your accounts…</p>');
    expect(html).toContain(
      '<div class="top-actions" aria-hidden="true"><span class="skeleton app-loading-btn"></span><span class="skeleton app-loading-btn"></span><span class="user-button-slot"><span class="skeleton app-loading-avatar"></span></span></div>'
    );
    expect(html).toContain(renderToStaticMarkup(<HomeSkeleton />));
  });

  test('said once to a screen reader: one status, the card’s', () => {
    const html = renderToStaticMarkup(<AppLoading account="clerk" />);
    expect(html.match(/role="status"/g)?.length).toBe(1);
  });

  test('password mode: the Settings gear in place of the account menu', () => {
    const html = renderToStaticMarkup(<AppLoading account="password" />);
    expect(html).not.toContain('user-button-slot');
    expect(html.match(/app-loading-btn/g)?.length).toBe(3);
  });
});

describe('Clerk’s form while it loads', () => {
  test('a card of placeholders, its status in words', () => {
    const html = renderToStaticMarkup(<SignInSkeleton status="Loading the sign-in form" />);
    expect(html).toStartWith('<div class="signin-skeleton" role="status"><span class="visually-hidden">Loading the sign-in form</span>');
    expect(text(html)).toBe('Loading the sign-in form');
    expect(html).toContain('<div class="signin-skeleton-card" aria-hidden="true">');
    expect(html).toContain('<div class="signin-skeleton-foot" aria-hidden="true">');
  });
});
