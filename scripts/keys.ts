// scripts/keys.ts
//
// Manage the data keys that encrypt Nya's storage (see lib/crypto.ts). Run
// locally, with the target named twice like the restore command:
//
//   REDIS_PREFIX=production bun run keys status --target production
//
// Commands:
//   status             list data keys, which masters wrap each, and which
//                      masters deployments have recently reported running
//   create             generate a new data key, wrapped with the master key
//   add-master         also wrap every data key with a new master key
//   drop-old-masters   remove every wrapping except the master key's
//
// MASTER KEYS ARE NEVER READ FROM THE ENVIRONMENT. They are typed at a hidden
// prompt, or piped in on stdin (one per line: the master, then the new master
// for add-master), e.g. from a password manager's CLI. Environment variables
// are ruled out on purpose: Bun loads .env.local automatically, so a dev
// MASTER_KEY there would silently be used against production, and a key typed
// on the command line lands in shell history.
//
// SAFETY CHECKS, each skippable only with --skip-attestation-check:
//   - Every command refuses unless the master key given opens every existing
//     data key, so a mistyped or wrong master cannot add or remove anything.
//   - create refuses unless a deployment of this environment has reported
//     running this master recently (lib/crypto.ts attestMasterKey): a data key
//     the live app cannot open would be an outage the moment it was used.
//   - drop-old-masters refuses unless the master given has been reported
//     recently AND no other master has been, so no running deployment is
//     locked out.
//
// ROTATING THE MASTER KEY, with no second master ever stored in Vercel:
//   1. Generate the new master and save it in your password manager.
//   2. bun run keys add-master ...   (asks for the current, then the new master)
//      Every data key is now openable by either master.
//   3. Set MASTER_KEY to the new master in Vercel for EVERY environment that
//      uses it, redeploy, and open the app once so the new master is reported.
//      Run steps 2 and 4 for each of those environments' prefixes too.
//   4. bun run keys drop-old-masters ... --confirm-redeployed
//      The old master now opens nothing in the live database. Two cautions:
//      backups taken before this step still need the old master, and rolling
//      back to a deployment from before step 3 will not be able to open any
//      data key.
//
// Writing to production also needs --confirm-production.

import { redis } from '@/lib/storage';
import {
  MasterKeyError,
  dataKeyId,
  importMasterKey,
  isKeyId,
  keysHashKey,
  mastersSeenKey,
  parseStoredDataKey,
  unwrapDataKey,
  type MasterKey,
  type StoredDataKey,
} from '@/lib/crypto';
import { RestoreRefused, checkTarget } from '@/lib/restore';

export type KeysClient = {
  hgetall(key: string): Promise<Record<string, unknown> | null>;
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  hsetnx(key: string, field: string, value: string): Promise<number>;
};

/** Where master keys come from: a hidden prompt or stdin, never the env. */
export type Secrets = { read(label: string): Promise<string> };

/** create: the master must have been reported by a deployment this recently. */
export const CREATE_ATTEST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** drop-old-masters: the master kept must have been reported, and every other
 *  one not reported, within this window. Deployments report every 5 minutes
 *  while in use (lib/crypto.ts), so a live old deployment would show. */
export const DROP_ATTEST_WINDOW_MS = 30 * 60 * 1000;

const COMMANDS = ['status', 'create', 'add-master', 'drop-old-masters'] as const;
type Command = (typeof COMMANDS)[number];

export type KeysArgs = {
  command: Command;
  target?: string;
  confirmProduction: boolean;
  confirmRedeployed: boolean;
  skipAttestationCheck: boolean;
  withMaster: boolean;
};

export function parseArgs(argv: string[]): KeysArgs {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command as Command)) {
    throw new RestoreRefused(`Usage: bun run keys <${COMMANDS.join('|')}> --target <prefix>`);
  }
  const args: KeysArgs = {
    command: command as Command,
    confirmProduction: false,
    confirmRedeployed: false,
    skipAttestationCheck: false,
    withMaster: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--target') args.target = rest[++i];
    else if (a === '--confirm-production') args.confirmProduction = true;
    else if (a === '--confirm-redeployed') args.confirmRedeployed = true;
    else if (a === '--skip-attestation-check') args.skipAttestationCheck = true;
    else if (a === '--with-master') args.withMaster = true;
    else throw new RestoreRefused(`Unexpected argument ${a}.`);
  }
  return args;
}

async function readKeys(client: KeysClient): Promise<Map<string, StoredDataKey>> {
  const all = (await client.hgetall(keysHashKey())) ?? {};
  const out = new Map<string, StoredDataKey>();
  for (const [id, value] of Object.entries(all)) {
    if (!isKeyId(id) || id === 'k0') throw new MasterKeyError(`Unexpected entry "${id}" in the key store.`);
    out.set(id, parseStoredDataKey(id, value));
  }
  return out;
}

/** Fingerprint -> when a deployment last reported running it. */
async function readSeen(client: KeysClient): Promise<Map<string, number>> {
  const all = (await client.hgetall(mastersSeenKey())) ?? {};
  const out = new Map<string, number>();
  for (const [fp, at] of Object.entries(all)) {
    const t = Date.parse(String(at));
    if (Number.isFinite(t)) out.set(fp, t);
  }
  return out;
}

const numberOf = (id: string) => Number(id.slice(1, id.indexOf('-')));

async function readMaster(secrets: Secrets, label: string): Promise<MasterKey> {
  const material = (await secrets.read(label)).trim();
  if (!material) throw new RestoreRefused(`No ${label} was given.`);
  return importMasterKey(material, label);
}

/** Every existing key must open with this master, or the command stops before
 *  writing anything. */
async function openAll(master: MasterKey, keys: Map<string, StoredDataKey>): Promise<Map<string, Uint8Array>> {
  const opened = new Map<string, Uint8Array>();
  for (const [id, stored] of keys) {
    try {
      opened.set(id, await unwrapDataKey(master, id, stored));
    } catch (err) {
      throw new RestoreRefused(
        `That master key (${master.fingerprint}) does not open ${id}, so it is not the one this store uses. Nothing was changed. (${err instanceof Error ? err.message : err})`
      );
    }
  }
  return opened;
}

const ago = (ms: number) => `${Math.round(ms / 60000)} min ago`;

export async function main(
  argv: string[],
  client: KeysClient,
  secrets: Secrets,
  now: number = Date.now()
): Promise<void> {
  const args = parseArgs(argv);
  const writes = args.command !== 'status';
  // Reading production's key list is harmless; changing it needs the extra flag.
  const target = checkTarget(args.target, writes ? args.confirmProduction : true, 'Changing the keys of');

  // Masters are read before anything touches Redis, so a missing one fails
  // fast and nothing is done on a partial set of inputs.
  const given: MasterKey | null =
    args.command === 'create'
      ? await readMaster(secrets, 'master key')
      : args.command === 'add-master'
        ? await readMaster(secrets, 'current master key')
        : args.command === 'drop-old-masters'
          ? args.confirmRedeployed
            ? await readMaster(secrets, 'master key to keep')
            : null
          : args.withMaster
            ? await readMaster(secrets, 'master key')
            : null;
  const newMaster = args.command === 'add-master' ? await readMaster(secrets, 'new master key') : null;

  const keys = await readKeys(client);
  const seen = await readSeen(client);
  const attested = (fp: string, windowMs: number) => (seen.get(fp) ?? -Infinity) >= now - windowMs;

  if (args.command === 'status') {
    const current = given ? given.fingerprint : null;
    console.log(`Key store for "${target}": ${keys.size} data key(s).`);
    if (current) console.log(`The master key given has fingerprint ${current}.`);
    for (const [id, stored] of [...keys].sort(([a], [b]) => numberOf(a) - numberOf(b))) {
      const fps = Object.keys(stored.wrapped);
      const mark = current ? (fps.includes(current) ? ' (opens with the master given)' : ' (NOT openable with the master given)') : '';
      console.log(`  ${id}  created ${stored.created_at}  wrapped for: ${fps.join(', ')}${mark}`);
    }
    if (seen.size === 0) console.log('No deployment has reported a master key yet.');
    for (const [fp, at] of seen) console.log(`  deployment reported master ${fp} ${ago(now - at)}`);
    return;
  }

  if (args.command === 'create') {
    const m = given!;
    await openAll(m, keys);
    if (!args.skipAttestationCheck && !attested(m.fingerprint, CREATE_ATTEST_WINDOW_MS)) {
      throw new RestoreRefused(
        `No deployment of "${target}" has reported running master ${m.fingerprint} in the last day, so the app might not be able to open a key made with it. Set MASTER_KEY in Vercel, redeploy, open the app once, and try again.`
      );
    }
    const n = Math.max(0, ...[...keys.keys()].map(numberOf)) + 1;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const id = await dataKeyId(n, raw);
    const stored: StoredDataKey = { created_at: new Date(now).toISOString(), wrapped: { [m.fingerprint]: await m.wrap(id, raw) } };
    // Exclusive: two creates racing cannot both claim the same id.
    if ((await client.hsetnx(keysHashKey(), id, JSON.stringify(stored))) !== 1) {
      throw new RestoreRefused(`${id} already exists. Nothing was changed; run it again.`);
    }
    // Prove it opens, and is the key its id names, before anyone relies on it.
    await unwrapDataKey(m, id, (await readKeys(client)).get(id)!);
    console.log(`Created ${id} in "${target}", wrapped for master ${m.fingerprint}.`);
    console.log('It is not used for anything until a later change makes it the active key.');
    return;
  }

  if (args.command === 'add-master') {
    const oldM = given!;
    const newM = newMaster!;
    if (oldM.fingerprint === newM.fingerprint) throw new RestoreRefused('The new master key is the same as the current one.');
    const opened = await openAll(oldM, keys);
    for (const [id, stored] of keys) {
      const updated: StoredDataKey = { ...stored, wrapped: { ...stored.wrapped, [newM.fingerprint]: await newM.wrap(id, opened.get(id)!) } };
      await client.hset(keysHashKey(), { [id]: JSON.stringify(updated) });
    }
    // Both masters must open everything, or deployments on either would fail.
    const after = await readKeys(client);
    await openAll(oldM, after);
    await openAll(newM, after);
    console.log(`Wrapped ${after.size} data key(s) for master ${newM.fingerprint} as well as ${oldM.fingerprint}.`);
    console.log('Next: set MASTER_KEY to the new key in Vercel, redeploy, open the app once, then run drop-old-masters.');
    return;
  }

  // drop-old-masters
  if (!args.confirmRedeployed) {
    throw new RestoreRefused(
      'Pass --confirm-redeployed once every deployment runs with the new MASTER_KEY; until then they still need the old wrappings.'
    );
  }
  const m = given!;
  await openAll(m, keys);
  const others = new Set<string>();
  for (const stored of keys.values()) for (const fp of Object.keys(stored.wrapped)) if (fp !== m.fingerprint) others.add(fp);

  if (!args.skipAttestationCheck) {
    if (!attested(m.fingerprint, DROP_ATTEST_WINDOW_MS)) {
      throw new RestoreRefused(
        `No deployment has reported running master ${m.fingerprint} in the last 30 minutes. Open the app on the redeployed version first. Nothing was changed.`
      );
    }
    const live = [...others].filter((fp) => attested(fp, DROP_ATTEST_WINDOW_MS));
    if (live.length > 0) {
      throw new RestoreRefused(
        `A deployment reported running master ${live.join(', ')} in the last 30 minutes; dropping it would lock that deployment out. Nothing was changed.`
      );
    }
  }

  let dropped = 0;
  for (const [id, stored] of keys) {
    const extra = Object.keys(stored.wrapped).filter((fp) => fp !== m.fingerprint);
    if (extra.length === 0) continue;
    dropped += extra.length;
    const updated: StoredDataKey = { ...stored, wrapped: { [m.fingerprint]: stored.wrapped[m.fingerprint] } };
    await client.hset(keysHashKey(), { [id]: JSON.stringify(updated) });
  }
  await openAll(m, await readKeys(client));
  console.log(`Removed ${dropped} wrapping(s) for other masters. Every data key now opens only with ${m.fingerprint}.`);
}

// ---------------------------------------------------------------------------
// Reading secrets without echoing them

/** Lines piped on stdin, handed out one per read. */
function pipedSecrets(): Secrets {
  let lines: Promise<string[]> | null = null;
  let next = 0;
  return {
    async read(label) {
      lines ??= Bun.stdin.text().then((t) => t.split(/\r?\n/));
      const all = await lines;
      if (next >= all.length || !all[next].trim()) throw new RestoreRefused(`Expected the ${label} on stdin.`);
      return all[next++];
    },
  };
}

/** A prompt that does not echo what is typed. */
function promptSecrets(): Secrets {
  return {
    read(label) {
      return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        process.stderr.write(`Enter the ${label} (not shown): `);
        stdin.setRawMode(true);
        stdin.resume();
        let value = '';
        const done = (err?: Error) => {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stderr.write('\n');
          if (err) reject(err);
          else resolve(value);
        };
        const onData = (chunk: Buffer) => {
          for (const ch of chunk.toString('utf8')) {
            if (ch === '\r' || ch === '\n') return done();
            if (ch === '\u0003') return done(new RestoreRefused('Cancelled.'));
            if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
            else value += ch;
          }
        };
        stdin.on('data', onData);
      });
    },
  };
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
    await main(argv, lazy, process.stdin.isTTY ? promptSecrets() : pipedSecrets());
  })().catch((err) => {
    if (err instanceof RestoreRefused) console.error(`Refused: ${err.message}`);
    else console.error(`Failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
