import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import AdminStorage from '@/components/AdminStorage';

export const metadata: Metadata = {
  title: 'Storage across accounts · Nya',
  description: 'Each account’s bank connections, stored transactions against the limit, storage and last snapshot.',
};

// The admin's view of storage across accounts (lib/admin-storage.ts, read by
// /api/admin/storage). Decided on the server, as app/page.tsx decides the
// admin's panel (lib/admin-items.ts): anyone else gets this copy of Nya's
// 404, as if the page did not exist, and the route refuses them too. Any
// doubt (no container yet, an unreadable registry) means not the admin.
// Rendered per request, as every page is (app/layout.tsx).
export default async function AdminStoragePage() {
  let admin = false;
  try {
    const { adminCtx } = await import('@/lib/admin-items');
    admin = (await adminCtx()) !== null;
  } catch {
    admin = false;
  }
  if (!admin) notFound();
  return <AdminStorage />;
}
