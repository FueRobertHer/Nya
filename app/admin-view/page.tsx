import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import AdminPage from '@/components/AdminPage';
import type { Ctx } from '@/lib/containers';

// The admin page (/admin; components/AdminPage.tsx, read by lib/admin-page.ts).
// Gated as app/admin-view/storage is: proxy.ts answers anyone but the admin as
// a path that does not exist (lib/admin-gate.ts), before this page renders,
// and it is decided again here, its title and description too, with
// notFound() for anyone else. Any doubt (no container yet, an unreadable
// registry) means not the admin. Read fresh on every load, so a change on it
// shows when the page is read again (router.refresh).

async function forAdmin(): Promise<Ctx | null> {
  try {
    const { adminCtx } = await import('@/lib/admin-items');
    return await adminCtx();
  } catch {
    return null;
  }
}

export async function generateMetadata(): Promise<Metadata> {
  if (!(await forAdmin())) notFound();
  return {
    title: 'Admin · Nya',
    description: 'The feature switches, nightly jobs, storage, unused connections and settings of this deployment.',
  };
}

export default async function AdminViewPage() {
  const admin = await forAdmin();
  if (!admin) notFound();
  const { readAdminPage } = await import('@/lib/admin-page');
  return <AdminPage data={await readAdminPage(admin)} />;
}
