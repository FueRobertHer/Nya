import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { devFlagsHere } from '@/lib/dev-flags';
import { FLAG_KEYS, choiceOf, choicesFor, defaultChoice, flagDef, isListValue, variableSet } from '@/lib/flags';
import { flagsStore } from '@/lib/flag-store';
import { demoUsers } from '@/lib/demo';
import { PageHeader } from '@/components/PageHeader';
import FeatureSwitchesCard, { type SwitchRow } from '@/components/FeatureSwitchesCard';

// The feature switches for local development (lib/dev-flags.ts says where:
// `bun run dev`, on this machine, on the `dev:` prefix). Missing anywhere
// else, its title and description too. The proxy has already sent anyone
// signed out to sign in, as for every page that isn't public; anyone signed
// in, demo accounts included, may set them here. Read fresh, so a change is
// shown on the next load.

export async function generateMetadata(): Promise<Metadata> {
  if (!devFlagsHere()) notFound();
  return { title: 'Feature switches · Nya', description: 'The feature switches, for local development.' };
}

export default async function DevFlagsPage() {
  if (!devFlagsHere()) notFound();
  const { entries, unrecognised } = await flagsStore.getAllReport();
  const rows: SwitchRow[] = FLAG_KEYS.map((key) => {
    const def = flagDef(key);
    const value = entries.get(key) ?? null;
    return {
      key,
      about: def.about,
      kind: def.value,
      removeBy: def.kind === 'release' ? def.removeBy : null,
      choices: [...choicesFor(key)],
      stored: unrecognised.includes(key) ? 'unreadable' : def.value === 'list' ? (value ? 'list' : null) : choiceOf(key, value),
      defaultChoice: defaultChoice(key),
      variable: 'variable' in def && def.variable ? def.variable : null,
      variableSet: variableSet(key),
      people: value && isListValue(value) ? value.ids.length + value.emails.length : null,
    };
  });
  return (
    <main className="wrap report-wrap">
      <PageHeader />
      <h1>Feature switches</h1>
      <p className="sub">For local development: what each switch does, and who it is on for here. A switch still set in the environment follows its variable.</p>
      <FeatureSwitchesCard rows={rows} demos={demoUsers().length > 0} />
    </main>
  );
}
