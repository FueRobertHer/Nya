import type { ReactNode } from 'react';
import { BrandLogo } from './Brand';

// The one header of the pages that stand outside the tabs: the public pages
// (components/InfoPage.tsx: security, privacy, developers, open-download,
// unsubscribe), Your data (components/DataInventory.tsx), Reports
// (components/ReportsPage.tsx) and the admin's pages (components/AdminJobs.tsx,
// AdminStorage.tsx). The logo and name are the way back into the app, a 44px
// target named for where it goes; `back` is where that is (Reports goes back
// to Activity, and Your data to Settings > Your data, where each is opened
// from), and `end` holds a control at the
// row's other end (Reports' hide amounts). No state or effects (the logo
// only takes an id from useId), so it renders on the server and inside client
// components alike.
function backLabel(back: string): string {
  if (back.includes('tab=activity')) return 'Back to Activity';
  if (back.includes('settings=')) return 'Back to Settings';
  if (back.startsWith('/admin')) return 'Back to Admin';
  return 'Back to Nya';
}

export function PageHeader({ back = '/', end }: { back?: string; end?: ReactNode }) {
  const label = backLabel(back);
  const inApp = back !== '/';
  return (
    <header className="page-header">
      <nav aria-label={label}>
        <a className="brand page-brand" href={back}>
          {inApp && (
            <svg className="page-back-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          )}
          <BrandLogo />
          <span>Nya</span>
          {inApp && <span className="page-back-label">{label}</span>}
        </a>
      </nav>
      {end}
    </header>
  );
}
