import type { Metadata } from 'next';
import DataInventory from '@/components/DataInventory';

export const metadata: Metadata = {
  title: 'Your data · Nya',
  description: 'Every kind of thing Nya keeps about you, how much of it, and who can see it.',
};

// Your data: the honest data map the privacy page points to, for the signed-in
// person's own account (lib/inventory-read.ts, read by /api/data-inventory).
// Gated like the dashboard: proxy.ts lets nobody in unsigned, as for every
// page not on its public list. Numbers only: nothing stored is shown.
export default function YourData() {
  return <DataInventory />;
}
