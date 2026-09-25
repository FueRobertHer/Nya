// lib/containers.ts
//
// Containers: the unit every stored record will belong to (#53). Today there
// is one, holding everything; keys move into it later (PRs 10-13). This file
// only names containers and keeps the registry of them.
//
// THE REGISTRY is one environment-wide hash, kEnv('containers'):
//   <container id> -> {"status": "active" | "restoring" | "archived",
//                      "primary": true | false, "created_at": "<ISO>"}
// It holds no secrets and nothing encrypted.
//
// MINTED ONCE, EXPLICITLY, NEVER LAZILY. The first container is created by an
// operator through /api/ops/containers, and its id is then set as CONTAINER_ID
// in the environment. Nothing creates one on first use: two requests racing a
// lazy creator would mint two ids and split the data between them, silently
// at one user. For the same reason, creating the first container is a single
// atomic step that refuses if any container exists.
//
// A process learns its container from CONTAINER_ID, checked against the
// registry (resolveCtx), never by picking one from the registry.

import { redis, kEnv } from './storage';

declare const containerBrand: unique symbol;
/** A container id: a lowercase UUID v4, checked. The brand keeps an arbitrary
 *  string (a key, an item id) from being passed where one is meant. */
export type ContainerId = string & { readonly [containerBrand]: true };

/** What a request acts within. Resolved once at the route boundary and
 *  passed down, so library code costs no extra reads to find it. */
export type Ctx = { readonly container: ContainerId };

export type ContainerStatus = 'active' | 'restoring' | 'archived';
export type ContainerRecord = { status: ContainerStatus; primary: boolean; created_at: string };

const CONTAINER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set<ContainerStatus>(['active', 'restoring', 'archived']);

/** A container problem an operator can act on. Messages name ids and
 *  settings, never data. */
export class ContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerError';
  }
}

export function isContainerId(s: unknown): s is ContainerId {
  return typeof s === 'string' && CONTAINER_ID.test(s);
}

export function asContainerId(s: string): ContainerId {
  if (!isContainerId(s)) throw new ContainerError(`${JSON.stringify(s.slice(0, 64))} is not a container id.`);
  return s;
}

const SCOPED = /^c:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([\s\S]+)$/;

/**
 * A key (relative to the environment prefix) split into its container and the
 * key inside it: "c:<id>:goals" gives the id and "goals"; "goals" gives null
 * and "goals". Everything that decides something by a key's name (what an
 * export leaves out, how the re-encryption pass reads a key) must look at the
 * inner key, or it would treat a container's cache as data, or miss it.
 */
export function splitScoped(key: string): { container: ContainerId | null; key: string } {
  const m = SCOPED.exec(key);
  return m ? { container: m[1] as ContainerId, key: m[2] } : { container: null, key };
}

/** Stores that belong to the whole environment (see kEnv in lib/storage.ts),
 *  so never appear inside a container. */
export const ENV_WIDE_PREFIXES = ['crypto:', 'containers', 'ratelimit:'] as const;

export function isEnvWide(key: string): boolean {
  return ENV_WIDE_PREFIXES.some((p) => key === p || (p.endsWith(':') && key.startsWith(p)));
}

export function registryKey(): string {
  return kEnv('containers');
}

function parseRecord(id: string, value: unknown): ContainerRecord {
  let r: unknown = value;
  if (typeof value === 'string') {
    try {
      r = JSON.parse(value);
    } catch {
      r = null;
    }
  }
  const rec = r as ContainerRecord | null;
  if (!rec || !STATUSES.has(rec.status) || typeof rec.primary !== 'boolean' || typeof rec.created_at !== 'string') {
    throw new ContainerError(`The registry entry for ${id} is unreadable.`);
  }
  return { status: rec.status, primary: rec.primary, created_at: rec.created_at };
}

export async function listContainers(): Promise<(ContainerRecord & { id: ContainerId })[]> {
  const all = ((await redis().hgetall(registryKey())) ?? {}) as Record<string, unknown>;
  return Object.entries(all)
    .map(([id, value]) => {
      if (!isContainerId(id)) throw new ContainerError(`The registry has an entry that is not a container id.`);
      return { id, ...parseRecord(id, value) };
    })
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

export async function getContainer(id: ContainerId): Promise<ContainerRecord | null> {
  const value = await redis().hget(registryKey(), id);
  return value === null || value === undefined ? null : parseRecord(id, value);
}

/** Writes the first entry only if the registry is empty, in one step. The
 *  first line names the script for the test double. */
export const CREATE_FIRST = `-- nya:container-create-first
if redis.call('HLEN', KEYS[1]) ~= 0 then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1`;

/**
 * Create the first container, as the primary one. Refuses if any container
 * exists: there is one per environment until multi-user support, and a second
 * made by accident would be a place for data to go missing.
 */
export async function createFirstContainer(now: number = Date.now()): Promise<ContainerId> {
  const id = asContainerId(crypto.randomUUID());
  const record: ContainerRecord = { status: 'active', primary: true, created_at: new Date(now).toISOString() };
  const created = await redis().eval(CREATE_FIRST, [registryKey()], [id, JSON.stringify(record)]);
  if (created !== 1) {
    const existing = (await listContainers()).map((c) => c.id).join(', ');
    throw new ContainerError(`A container already exists (${existing}); only one is supported for now.`);
  }
  return id;
}

export const CONTAINER_ENV = 'CONTAINER_ID';

/**
 * The container this deployment acts within: CONTAINER_ID, which must name
 * an active container in the registry. Throws a ContainerError otherwise.
 * Never falls back to "the primary one" or to unscoped keys: a guess that
 * turns out wrong forks the data into two places, which nobody notices for
 * days.
 */
export async function resolveCtx(): Promise<Ctx> {
  const raw = process.env[CONTAINER_ENV];
  if (!raw) throw new ContainerError(`${CONTAINER_ENV} is not set.`);
  if (!isContainerId(raw)) throw new ContainerError(`${CONTAINER_ENV} is not a container id.`);
  const rec = await getContainer(raw);
  if (!rec) throw new ContainerError(`${CONTAINER_ENV} names a container that is not in the registry.`);
  if (rec.status !== 'active') throw new ContainerError(`${CONTAINER_ENV} names a container that is ${rec.status}.`);
  return { container: raw };
}
