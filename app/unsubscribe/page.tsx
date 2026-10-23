import type { Metadata } from 'next';
import { InfoPage, InfoSection } from '@/components/InfoPage';
import UnsubscribeForm from '@/components/UnsubscribeForm';

export const metadata: Metadata = {
  title: 'Turn off the weekly summary · Nya',
  description: 'Turn off the weekly summary email from Nya.',
  robots: { index: false, follow: false },
  // The link's token is in this page's address: no other site is told it.
  referrer: 'no-referrer',
};

// Where the link in a weekly summary goes (lib/weekly-summary/unsubscribe.ts):
// a button that turns the summary off, signed out. Public (proxy.ts): it reads
// no stored data and has no server action; the button posts the link's token,
// read from the address in the browser, to app/api/weekly-summary/unsubscribe,
// which checks it. Opening the link changes nothing by itself, since mail apps
// and the security scanners in front of them open links on their own.

export default function UnsubscribePage() {
  return (
    <InfoPage page="unsubscribe" title="Weekly summary" intro="Turn off the weekly summary email Nya sends you.">
      <UnsubscribeForm />
      <InfoSection title="What it is">
        <p>
          The weekly summary says what changed in your week and what needs your attention: spending against a usual week,
          budgets over or close, bills due, goals, bank connections and months that may be missing transactions. It never
          includes balances, amounts or account numbers. Turning it off stops it; it can be turned on again under Settings, Preferences.
        </p>
      </InfoSection>
    </InfoPage>
  );
}
