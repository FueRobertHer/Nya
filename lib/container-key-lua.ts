// lib/container-key-lua.ts
//
// The part of a container's birth that claims its data key, as Lua, for the
// two scripts that register a container: CLAIM_OR_CREATE (lib/owners.ts, an
// account's first sign-in) and CREATE_FIRST (lib/containers.ts). Writing the
// key in the same step as the registry entry means no request can reach a new
// container before it has its key (docs/architecture.md, "Per-container data
// keys").
//
// Its own module, importing nothing, because lib/crypto.ts imports
// lib/containers.ts (for ContainerError), and lib/containers.ts needs this at
// load: neither can import the other's runtime code.
//
// The keys and arguments are lib/crypto.ts's containerKeyScriptKeys() and
// containerKeyScriptArgs(), in that order: the map, the key store, the
// rotation record, the rotation lock and the current master record; the key's
// id, its record, the map entry and the current master record as stored.

/**
 * `k` is the index in KEYS of the first of containerKeyScriptKeys, `a` the
 * index in ARGV of the first of containerKeyScriptArgs, and `c` the index in
 * ARGV of the container's id. It writes nothing when there is no key (an empty
 * id), while a master rotation is prepared or pending or a rotation step holds
 * the lock, when the current master is another, when the key's id is taken or
 * the container is in the map already: the container is then registered
 * without a key, and the migration pass makes it one. A caller that sends no
 * key arguments at all (fewer ARGV) is read as sending none.
 */
export function birthKeyLua(k: number, a: number, c: number): string {
  return `if (ARGV[${a}] or '') ~= '' and redis.call('EXISTS', KEYS[${k + 2}]) == 0 and redis.call('EXISTS', KEYS[${k + 3}]) == 0
  and redis.call('HEXISTS', KEYS[${k + 1}], ARGV[${a}]) == 0 and redis.call('HEXISTS', KEYS[${k}], ARGV[${c}]) == 0 then
  local master = redis.call('GET', KEYS[${k + 4}])
  if not master or master == ARGV[${a + 3}] then
    if not master then redis.call('SET', KEYS[${k + 4}], ARGV[${a + 3}]) end
    redis.call('HSET', KEYS[${k + 1}], ARGV[${a}], ARGV[${a + 1}])
    redis.call('HSET', KEYS[${k}], ARGV[${c}], ARGV[${a + 2}])
  end
end`;
}
