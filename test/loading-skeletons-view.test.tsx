import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppLoading, HomeSkeleton, SignInSkeleton } from '@/components/LoadingSkeletons';
import NetWorthCard from '@/components/NetWorthCard';
import NetWorthChart from '@/components/NetWorthChart';
import { GEAR, HeaderIcon, REFRESH } from '@/components/HeaderIcon';

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
  const clerk = renderToStaticMarkup(<AppLoading account="clerk" />);
  const password = renderToStaticMarkup(<AppLoading account="password" />);
  const actions = (html: string) => html.slice(html.indexOf('<div class="top-actions">'), html.indexOf('<section'));

  test('the dashboard header with its loading line, and Home loading', () => {
    expect(clerk).toContain('<main class="wrap"><div class="top-row">');
    expect(clerk).toContain('<h1>Nya</h1>');
    expect(clerk).toContain('<p class="sub">Loading your accounts…</p>');
    expect(clerk).toContain(renderToStaticMarkup(<HomeSkeleton />));
  });

  test('the header’s own buttons, as the dashboard draws them while it loads', () => {
    const header = actions(clerk);
    // Hide amounts works; Refresh turns, unavailable, drawn with the dashboard's own icon.
    expect(header).toContain('aria-label="Hide amounts"');
    expect(header).toContain(
      `<button class="secondary icon-btn" disabled="" aria-label="Refresh" title="Refresh">${renderToStaticMarkup(<HeaderIcon d={REFRESH} spin />)}</button>`
    );
    // The account menu's place holds the circle ClerkAccount keeps until Clerk draws the avatar.
    expect(header).toContain('<div class="user-button-slot"><span class="skeleton user-button-skeleton" aria-hidden="true"></span></div>');
    expect(header).not.toContain('Settings');
  });

  test('password mode: the Settings gear, which does nothing until the dashboard is in', () => {
    const header = actions(password);
    expect(header).not.toContain('user-button-slot');
    expect(header).toContain(
      `<button class="secondary icon-btn" aria-disabled="true" aria-label="Settings" title="Settings">${renderToStaticMarkup(<HeaderIcon d={GEAR} />)}</button>`
    );
  });

  test('said once to a screen reader: one status, the card’s', () => {
    expect(clerk.match(/role="status"/g)?.length).toBe(1);
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
