// lib/demo-seed/guard.ts
//
// Where the demo seed (scripts/seed-demo.ts) may write, checked before it
// writes anything. Every check refuses with a SeedRefused that says what to
// change; none is a flag to skip.
//
// THE ENVIRONMENT. Only where demo accounts exist (lib/demo.ts
// demoEnvironment: Vercel's Preview or Development, never Production, never a
// self-hosted `next start`), on Plaid's sandbox, and only into the prefix the
// operator names twice: once in the environment (REDIS_PREFIX, else
// VERCEL_ENV, lib/storage.ts) and once as --target, as scripts/restore.ts
// asks. Production's prefix is refused by name too, whatever else says.
//
// THE ACCOUNTS. Only the demo accounts DEMO_USER_IDS names (lib/demo.ts
// demoUsers), each into the container it already owns (lib/owners.ts), so a
// demo account must have signed in once there first: the seed never mints a
// container, and never takes the deployment's primary one. A container
// another sign-in owns too is refused, as emptying it from the app is.

import { demoEnvironment, demoUsers } from '../demo';
import { envPrefix } from '../storage';
import { getContainer, type Ctx } from '../containers';
import { ownedContainer, ownersOf } from '../owners';
import { checkContainerKey } from '../crypto';
import type { DemoName } from './profiles';

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefused';
  }
}

/** What the seed reads from the environment, each as the alternatives that
 *  can stand for it (lib/storage.ts, lib/plaid.ts, lib/crypto.ts, lib/demo.ts). */
const NEEDED: readonly (readonly string[])[] = [
  ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL'],
  ['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN'],
  ['PLAID_CLIENT_ID'],
  ['PLAID_SECRET'],
  ['PLAID_ENCRYPTION_KEY', 'MASTER_KEY'],
  ['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'],
  ['CLERK_SECRET_KEY'],
  ['DEMO_USER_IDS'],
];

/** The settings the environment leaves empty, by their first name. Vercel
 *  pulls a variable marked Sensitive as an empty one, so a pulled file has
 *  these blank until they are filled in. */
export function missingSettings(): string[] {
  return NEEDED.filter((names) => !names.some((n) => process.env[n])).map((names) => names[0]);
}

/** The environment's own prefix, without its colon. */
const prefixName = () => envPrefix().slice(0, -1);

/** Refuses unless this process may seed demo accounts into `target`. */
export function checkSeedEnvironment(target: string | undefined): void {
  if (!target) throw new SeedRefused('Name the environment to seed with --target (for Preview, --target preview).');
  const prefix = prefixName();
  if (target === 'production' || prefix === 'production' || process.env.VERCEL_ENV === 'production') {
    throw new SeedRefused('The demo seed never writes to production.');
  }
  if (target !== prefix) {
    throw new SeedRefused(`This would write to "${prefix}", not "${target}": set REDIS_PREFIX (or VERCEL_ENV) so the two agree.`);
  }
  if (!demoEnvironment()) {
    throw new SeedRefused('Demo accounts exist only on Vercel Preview and Development: run this with the environment pulled from one (VERCEL_ENV=preview or development).');
  }
  const missing = missingSettings();
  if (missing.length > 0) {
    throw new SeedRefused(`These are empty here: ${missing.join(', ')}. Vercel pulls variables marked Sensitive as empty, so fill them in the env file with Preview's own values.`);
  }
  if ((process.env.PLAID_ENV || 'sandbox') !== 'sandbox') throw new SeedRefused('The demo seed links Plaid sandbox banks only: PLAID_ENV must be sandbox.');
}

export type SeedTarget = { name: DemoName; userId: string; ctx: Ctx };

/** The demo accounts to seed (all of them, or those named), each with the
 *  container it owns. Reads only. */
export async function seedTargets(only: DemoName[] = []): Promise<SeedTarget[]> {
  const users = demoUsers();
  if (users.length === 0) {
    throw new SeedRefused('DEMO_USER_IDS names no demo account here (it also needs the Clerk keys set): see docs/authentication.md, "Demo accounts".');
  }
  const wanted = only.length > 0 ? only : users.map((u) => u.label as DemoName);
  const out: SeedTarget[] = [];
  for (const name of wanted) {
    const user = users.find((u) => u.label === name);
    if (!user) throw new SeedRefused(`DEMO_USER_IDS doesn't name ${name}.`);
    const container = await ownedContainer(user.id);
    if (!container) throw new SeedRefused(`${name} hasn't signed in on this environment yet: sign in once with the demo button, then run this again.`);
    const others = (await ownersOf(container)).filter((o) => o !== user.id);
    if (others.length > 0) throw new SeedRefused(`${name}'s data belongs to another sign-in too, so it isn't replaced.`);
    const rec = await getContainer(container);
    if (!rec || rec.status !== 'active') throw new SeedRefused(`${name}'s container is ${rec ? rec.status : 'not in the registry'}.`);
    if (rec.primary) throw new SeedRefused(`${name}'s container is this environment's primary one, which holds the data from before accounts, so it isn't replaced.`);
    const ctx: Ctx = { container };
    await checkContainerKey(ctx);
    out.push({ name, userId: user.id, ctx });
  }
  return out;
}
