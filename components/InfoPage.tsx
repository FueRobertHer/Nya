import type { ReactNode } from 'react';
import { TrustLinks } from './TrustLinks';

// The frame of the public pages (app/security, app/privacy, app/developers):
// the logo back into the app, a title, and the links between the pages.
// Server-rendered and readable without signing in (proxy.ts), so nothing in it
// reads stored data.
export function InfoPage({
  page,
  title,
  intro,
  children,
}: {
  page: 'security' | 'privacy' | 'developers';
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <main className="wrap info-page">
      <a className="brand info-brand" href="/">
        {/* eslint-disable-next-line @next/next/no-img-element -- the app icon, already a static SVG */}
        <img className="brand-logo" src="/icon.svg" alt="" width={34} height={34} />
        <span>Nya</span>
      </a>
      <h1>{title}</h1>
      <p className="sub">{intro}</p>
      {children}
      <TrustLinks current={page === 'developers' ? undefined : page} home />
    </main>
  );
}

/** One titled part of a page. */
export function InfoSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card info-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
