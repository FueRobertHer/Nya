import type { ReactNode } from 'react';
import { TrustLinks } from './TrustLinks';
import { PageHeader } from './PageHeader';
import { Notice } from './TotalCaveats';

// The frame of the public pages (app/security, app/privacy, app/developers,
// app/open-download, app/unsubscribe): the shared header back into the app
// (components/PageHeader.tsx), a title, then the page as plain prose under
// headings, not in cards, and the links between the pages. A form on one of
// them (unsubscribing, opening a download) is a control, so it keeps its
// card. Server-rendered and readable without signing in (proxy.ts), so
// nothing in it reads stored data.
//
// A long page passes its parts as `sections`, from which both the parts and a
// contents list of links to them are drawn, so the two can't drift apart;
// from CONTENTS_FROM parts on, the contents is shown, after the intro and any
// `notice` (a plain-language note said first, as Privacy's is).

/** One titled part of a page: its id is its address on the page (#id). */
export type InfoPart = { id: string; title: string; body: ReactNode };

/** How many parts make a page long enough for a contents list. */
export const CONTENTS_FROM = 5;

export function InfoPage({
  page,
  title,
  intro,
  notice,
  sections,
  children,
}: {
  page: 'security' | 'privacy' | 'developers' | 'open-download' | 'unsubscribe';
  title: string;
  intro: string;
  /** Information said before everything else, in an information notice. */
  notice?: ReactNode;
  sections?: InfoPart[];
  children?: ReactNode;
}) {
  return (
    <main className="wrap info-page">
      <PageHeader />
      <h1>{title}</h1>
      <p className="sub">{intro}</p>
      {notice && <Notice level="info">{notice}</Notice>}
      {sections && sections.length >= CONTENTS_FROM && <InfoContents sections={sections} />}
      <div className="info-body">
        {children}
        {sections?.map((s) => (
          <InfoSection key={s.id} id={s.id} title={s.title}>
            {s.body}
          </InfoSection>
        ))}
      </div>
      <TrustLinks current={page === 'security' || page === 'privacy' ? page : undefined} />
    </main>
  );
}

/** The contents of a long page: a link to each part, in order. */
function InfoContents({ sections }: { sections: InfoPart[] }) {
  return (
    <nav className="info-contents" aria-labelledby="info-contents-title">
      <h2 id="info-contents-title">On this page</h2>
      {/* The role keeps a list styled without bullets read as one. */}
      <ol role="list">
        {sections.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`}>{s.title}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** One titled part of a page, as prose under its heading. */
export function InfoSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="info-section info-prose" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
