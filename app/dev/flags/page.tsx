import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { devFlagsHere } from '@/lib/dev-flags';
import { flagsStore } from '@/lib/flag-store';
import { switchRows } from '@/lib/flag-view';
import { demoUsers } from '@/lib/demo';
import { clerkEnabled } from '@/lib/auth-mode';
import { PageHeader } from '@/components/PageHeader';
import FeatureSwitchesCard from '@/components/FeatureSwitchesCard';

// The feature switches for local development (lib/dev-flags.ts says where:
// `bun run dev`, on this machine, on the `dev:` prefix). Missing anywhere
// else, its title and description too. The proxy has already sent anyone
// signed out to sign in, as for every page that isn't public; anyone signed
// in, demo accounts included, may set them here, choices alone: the accounts
// an audience is also on for and who may sign in are counted, never named,
// and set on the admin page (lib/flag-view.ts). Read fresh, so a change is
// shown on the next load.

export async function generateMetadata(): Promise<Metadata> {
  if (!devFlagsHere()) notFound();
  return { title: 'Feature switches · Nya', description: 'The feature switches, for local development.' };
}

export default async function DevFlagsPage() {
  if (!devFlagsHere()) notFound();
  const rows = switchRows(await flagsStore.getAllReport(), 'dev');
  return (
    <main className="wrap report-wrap">
      <PageHeader />
      <h1>Feature switches</h1>
      <p className="sub">For local development: what each switch does, and who it is on for here. A switch still set in the environment follows its variable.</p>
      <FeatureSwitchesCard rows={rows} place="dev" demos={demoUsers().length > 0} environment="local development" freshSignIn={false} clerk={clerkEnabled()} />
    </main>
  );
}
