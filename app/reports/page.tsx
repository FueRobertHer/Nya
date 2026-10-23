import type { Metadata } from 'next';
import ReportsPage from '@/components/ReportsPage';

export const metadata: Metadata = {
  title: 'Reports · Nya',
  description: 'A tax-year summary or a report on any dates for your accountant, how long your cash would last, and this year against last: to read, print or save as a PDF.',
};

// Reports: for an accountant (#43), a tax-year summary or a report on any
// dates; the runway, how long the person's cash would last; and year over
// year. Each printed or saved as a PDF from the browser's own print window, with
// print styles that make a clean A4 or Letter page (app/globals.css,
// "Reports"), so no PDF library is needed. Gated like the dashboard: proxy.ts
// lets nobody in unsigned, as for every page not on its public list. The data
// is read by app/api/reports (and app/api/reports/runway and
// year-over-year), in the reader's time zone.
export default function Reports() {
  return <ReportsPage />;
}
