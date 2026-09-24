// scripts/keys.ts
//
// Manage the data keys that encrypt Nya's storage (see lib/crypto.ts). Run
// locally, with the target named twice like the restore command:
//
//   REDIS_PREFIX=production bun run keys status --target production
//
// Commands:
//   status             list data keys and which master keys can open each
//   create             generate a new data key, wrapped with MASTER_KEY
//   add-master         also wrap every data key with NEW_MASTER_KEY
//   drop-old-masters   remove every wrapping except MASTER_KEY's
//
// MASTER_KEY (and NEW_MASTER_KEY for add-master) come from the shell, never a
// file in the repo. The Upstash credentials come from .env.local.
//
// ROTATING THE MASTER KEY, with no second master ever stored in Vercel:
//   1. Generate the new master and save it in your password manager.
//   2. MASTER_KEY=<old> NEW_MASTER_KEY=<new> bun run keys add-master ...
//      Every data key is now openable by either master.
//   3. Set MASTER_KEY=<new> in Vercel and redeploy.
//   4. MASTER_KEY=<new> bun run keys drop-old-masters ... --confirm-redeployed
//      The old master now opens nothing in the live database. Backups taken
//      before step 4 still hold the old wrappings, so they still need it.
//
// Writing to production also needs --confirm-production.

import { redis } from '@/lib/storage';
import {
  MasterKeyError,
  importMasterKey,
  isKeyId,
  keysHashKey,
  parseStoredDataKey,
  unwrapDataKey,
  wrapDataKey,
  type MasterKey,
  type StoredDataKey,
} from '@/lib/crypto';
import { RestoreRefused, checkTarget } from '@/lib/restore';

export type KeysClient = {
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
};

type Env = Record<string, string | undefined>;

const COMMANDS = ['status', 'create', 'add-master', 'drop-old-masters'] as const;
type Command = (typeof COMMANDS)[number];

export type KeysArgs = {
  command: Command;
  target?: string;
  confirmProduction: boolean;
  confirmRedeployed: boolean;
};

export function parseArgs(argv: string[]): KeysArgs {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as Command)) {
    throw new RestoreRefused(`Usage: bun run keys <${COMMANDS.join('|')}> --target <prefix>`);
  }
  const args: KeysArgs = { command: command as Command, confirmProduction: false, confirmRedeployed: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--target') args.target = rest[++i];
    else if (a === '--confirm-production') args.confirmProduction = true;
    else if (a === '--confirm-redeployed') args.confirmRedeployed = true;
    else throw new RestoreRefused(`Unexpected argument ${a}.`);
  }
  return args;
}

async function readKeys(client: KeysClient): Promise<Map<string, StoredDataKey>> {
  const all = (await client.hgetall(keysHashKey())) ?? {};
  const out = new Map<string, StoredDataKey>();
  for (const [id, value] of Object.entries(all)) {
    if (!isKeyId(id)) throw new MasterKeyError(`Unexpected entry "${id}" in the key store.`);
    out.set(id, parseStoredDataKey(id, value));
  }
  return out;
}

function numberOf(id: string): number {
  return Number(id.slice(1));
}

async function master(env: Env, name: string): Promise<MasterKey> {
  const material = env[name];
  if (!material) throw new RestoreRefused(`${name} is not set in this shell.`);
  return importMasterKey(material, name);
}

export async function main(argv: string[], client: KeysClient, env: Env = process.env): Promise<void> {
  const args = parseArgs(argv);
  const writes = args.command !== 'status';
  // Reading production's key list is harmless; changing it needs the extra flag.
  const target = checkTarget(args.target, writes ? args.confirmProduction : true);
  const keys = await readKeys(client);

  if (args.command === 'status') {
    const current = env.MASTER_KEY ? (await master(env, 'MASTER_KEY')).fingerprint : null;
    console.log(`Key store for "${target}": ${keys.size} data key(s).`);
    if (current) console.log(`MASTER_KEY in this shell has fingerprint ${current}.`);
    for (const [id, stored] of [...keys].sort(([a], [b]) => numberOf(a) - numberOf(b))) {
      const fps = Object.keys(stored.wrapped);
      const mark = current ? (fps.includes(current) ? ' (opens with this MASTER_KEY)' : ' (NOT openable with this MASTER_KEY)') : '';
      console.log(`  ${id}  created ${stored.created_at}  wrapped for: ${fps.join(', ')}${mark}`);
    }
    return;
  }

  if (args.command === 'create') {
    const m = await master(env, 'MASTER_KEY');
    const next = `k${Math.max(0, ...[...keys.keys()].map(numberOf)) + 1}`;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const stored: StoredDataKey = {
      created_at: new Date().toISOString(),
      wrapped: { [m.fingerprint]: await wrapDataKey(m, next, raw) },
    };
    // Exclusive: two creates racing cannot both claim the same id.
    if ((await client.hsetnx(keysHashKey(), next, JSON.stringify(stored))) !== 1) {
      throw new RestoreRefused(`${next} was created by someone else meanwhile. Nothing was changed; run it again.`);
    }
    // Prove it opens before anyone relies on it.
    const back = (await readKeys(client)).get(next)!;
    await unwrapDataKey(m, next, back);
    console.log(`Created ${next} in "${target}", wrapped for master ${m.fingerprint}.`);
    console.log('It is not used for anything until a later change makes it the active key.');
    return;
  }

  if (args.command === 'add-master') {
    const oldM = await master(env, 'MASTER_KEY');
    const newM = await master(env, 'NEW_MASTER_KEY');
    if (oldM.fingerprint === newM.fingerprint) throw new RestoreRefused('NEW_MASTER_KEY is the same as MASTER_KEY.');
    // Open everything first, so a key that cannot be opened stops the command
    // before anything is written.
    const opened = new Map<string, Uint8Array>();
    for (const [id, stored] of keys) opened.set(id, await unwrapDataKey(oldM, id, stored));
    for (const [id, stored] of keys) {
      const updated: StoredDataKey = {
        ...stored,
        wrapped: { ...stored.wrapped, [newM.fingerprint]: await wrapDataKey(newM, id, opened.get(id)!) },
      };
      await client.hset(keysHashKey(), { [id]: JSON.stringify(updated) });
    }
    const after = await readKeys(client);
    for (const [id, stored] of after) await unwrapDataKey(newM, id, stored);
    console.log(`Wrapped ${after.size} data key(s) for master ${newM.fingerprint} as well as ${oldM.fingerprint}.`);
    console.log('Next: set MASTER_KEY to the new key in Vercel, redeploy, then run drop-old-masters.');
    return;
  }

  // drop-old-masters
  if (!args.confirmRedeployed) {
    throw new RestoreRefused(
      'Pass --confirm-redeployed once every deployment runs with the new MASTER_KEY; until then they still need the old wrappings.'
    );
  }
  const m = await master(env, 'MASTER_KEY');
  // Every key must open with the master that stays, or this would lock it out.
  for (const [id, stored] of keys) await unwrapDataKey(m, id, stored);
  let dropped = 0;
  for (const [id, stored] of keys) {
    const others = Object.keys(stored.wrapped).filter((fp) => fp !== m.fingerprint);
    if (others.length === 0) continue;
    dropped += others.length;
    const updated: StoredDataKey = { ...stored, wrapped: { [m.fingerprint]: stored.wrapped[m.fingerprint] } };
    await client.hset(keysHashKey(), { [id]: JSON.stringify(updated) });
  }
  console.log(`Removed ${dropped} wrapping(s) for other masters. Every data key now opens only with ${m.fingerprint}.`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  (async () => {
    parseArgs(argv);
    // Built on first use, so a wrong --target is refused before credentials
    // are even looked for.
    const lazy: KeysClient = {
      hgetall: (key) => redis().hgetall(key),
      hset: (key, fields) => redis().hset(key, fields),
      hsetnx: (key, field, value) => redis().hsetnx(key, field, value),
    };
    await main(argv, lazy);
  })().catch((err) => {
    if (err instanceof RestoreRefused) console.error(`Refused: ${err.message}`);
    else console.error(`Failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
