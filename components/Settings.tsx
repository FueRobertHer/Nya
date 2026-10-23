'use client';

// The Settings screen (docs/design/information-architecture.md#settings),
// opened from the account menu, or the gear in password mode. A list of
// sections, each opening its own view with a back button. It took over what
// the Accounts tab's Manage mode used to append below the accounts.
//
// An in-app view rather than a route, so every card keeps the dashboard's
// loaded data: the dashboard builds each section's cards as they were and
// passes them in. Each new level moves focus to its heading.

import { useEffect, useRef, type ReactNode } from 'react';

export type SettingsSectionId = 'preferences' | 'transactions' | 'connections' | 'sharing' | 'data' | 'account';

/** What Settings shows: its list of sections, or one of them. */
export type SettingsView = 'list' | SettingsSectionId;

export type SettingsSection = {
  id: SettingsSectionId;
  title: string;
  /** One line under the title in the list: what is inside. */
  sub: string;
  content: ReactNode;
};

const chevron = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const LEFT = 'm15 18-6-6 6-6';
const RIGHT = 'm9 18 6-6-6-6';

export function SettingsScreen({
  view,
  sections,
  onView,
  onClose,
}: {
  view: SettingsView;
  sections: SettingsSection[];
  onView: (view: SettingsView) => void;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [view]);

  // A section the dashboard doesn't offer here (Sharing without Clerk) shows
  // the list instead.
  const section = view === 'list' ? null : (sections.find((s) => s.id === view) ?? null);
  const go = (next: SettingsView) => {
    window.scrollTo(0, 0);
    onView(next);
  };

  return (
    <section className="settings" aria-labelledby="settings-title">
      <div className="settings-bar">
        <button
          className="secondary icon-btn"
          onClick={() => (section ? go('list') : onClose())}
          aria-label={section ? 'Back to Settings' : 'Close Settings'}
        >
          {chevron(LEFT)}
        </button>
        <h2 id="settings-title" ref={heading} tabIndex={-1}>
          {section ? section.title : 'Settings'}
        </h2>
      </div>
      {section ? (
        <div className="settings-section">{section.content}</div>
      ) : (
        <ul className="card settings-list">
          {sections.map((s) => (
            <li key={s.id}>
              <button className="settings-row" onClick={() => go(s.id)}>
                <span className="settings-row-text">
                  <span className="settings-row-title">{s.title}</span>
                  <span className="settings-row-sub">{s.sub}</span>
                </span>
                {chevron(RIGHT)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
