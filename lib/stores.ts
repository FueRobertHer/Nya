// lib/stores.ts
//
// The catalogue of stores declared through the storage seam (lib/repo.ts).
//
// A store is declared in its own module, next to its type and shape check, and
// registers itself when that module loads. Each such module is imported below,
// so anything that walks every store sees all of them, whatever its own code
// happens to load: the key inventory (classify() in lib/reencrypt.ts) and a
// person's data download. test/repo.test.ts fails if a module under lib/
// declares a store and is not imported here.
//
// One line per declaring module, in alphabetical order, like:
//   import './rules';

import { storesDeclaredSoFar, type Store } from './repo';

/** Every declared store, in name order. */
export function declaredStores(): Store[] {
  return [...storesDeclaredSoFar().values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The store declared under a name (its key family), or null. */
export function declaredStore(name: string): Store | null {
  return storesDeclaredSoFar().get(name) ?? null;
}
