import type { ReactNode } from 'react';
import { TrustLinks } from './TrustLinks';
import { BrandLogo } from './Brand';

// The frame of the public pages (app/security, app/privacy, app/developers,
// app/open-download, app/unsubscribe): the logo back into the app, a title,
// and the links between the pages. Server-rendered and readable without
// signing in (proxy.ts), so nothing in it reads stored data.
export function InfoPage({
  page,
  title,
  intro,
  children,
}: {
  page: 'security' | 'privacy' | 'developers' | 'open-download' | 'unsubscribe';
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <main className="wrap info-page">
      <a className="brand info-brand" href="/">
        <BrandLogo />
        <span>Nya</span>
      </a>
      <h1>{title}</h1>
      <p className="sub">{intro}</p>
      {children}
      <TrustLinks current={page === 'security' || page === 'privacy' ? page : undefined} home />
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
