import type { ReactNode } from 'react';
import { BrandLogo } from './Brand';

// The one header of the pages that stand outside the tabs: the public pages
// (components/InfoPage.tsx: security, privacy, developers, open-download,
// unsubscribe), Your data (components/DataInventory.tsx), Reports
// (components/ReportsPage.tsx) and the admin's pages (components/AdminJobs.tsx,
// AdminStorage.tsx). The logo and name are the way back into the app, a 44px
// target named for where it goes; `back` is where that is (Reports goes back
// to Activity, where it is opened from), and `end` holds a control at the
// row's other end (Reports' hide amounts). No state or effects (the logo
// only takes an id from useId), so it renders on the server and inside client
// components alike.
export function PageHeader({ back = '/', end }: { back?: string; end?: ReactNode }) {
  return (
    <header className="page-header">
      <nav aria-label="Back to Nya">
        <a className="brand page-brand" href={back}>
          <BrandLogo />
          <span>Nya</span>
        </a>
      </nav>
      {end}
    </header>
  );
}
