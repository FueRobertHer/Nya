import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import AdminStorage from '@/components/AdminStorage';

// The admin's view of storage across accounts (lib/admin-storage.ts, read by
// /api/admin/storage). proxy.ts answers anyone but the admin as a path that
// does not exist (lib/admin-gate.ts), before this page renders, so they get
// the document any missing path gets. Decided again here, as app/page.tsx
// decides the admin's panel (lib/admin-items.ts): its title and description
// too, never sent unless the admin is asking, and notFound() otherwise. Any
// doubt (no container yet, an unreadable registry) means not the admin.
// Rendered per request, as every page is (app/layout.tsx).

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
    title: 'Storage across accounts · Nya',
    description: 'Each account’s bank connections, stored transactions against the limit, storage and last snapshot.',
  };
}

export default async function AdminStoragePage() {
  if (!(await forAdmin())) notFound();
  return <AdminStorage />;
}
