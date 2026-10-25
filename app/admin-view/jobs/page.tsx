import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import AdminJobs from '@/components/AdminJobs';

// The admin's Nightly jobs page (/admin/jobs; components/AdminJobs.tsx, read
// and run through /api/admin/jobs). Gated as app/admin-view/storage is:
// proxy.ts answers anyone but the admin as a path that does not exist
// (lib/admin-gate.ts), before this page renders, and it is decided again
// here, its title and description too, with notFound() for anyone else. Any
// doubt (no container yet, an unreadable registry) means not the admin.

async function forAdmin(): Promise<boolean> {
  try {
    const { adminCtx } = await import('@/lib/admin-items');
    return (await adminCtx()) !== null;
  } catch {
    return false;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  if (!(await forAdmin())) notFound();
  return {
    title: 'Nightly jobs · Nya',
    description: 'The nightly backup and the clean-up of receipts and documents: how each last went, and running one now.',
  };
}

export default async function AdminJobsPage() {
  if (!(await forAdmin())) notFound();
  return <AdminJobs />;
}
