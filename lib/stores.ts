// lib/stores.ts
//
// The catalogue of stores declared through the storage seam (lib/repo.ts).
//
// A store is declared in its own module, next to its type and shape check, and
// registers itself when that module loads. Each such module is imported below,
// so anything that walks every store sees all of them, whatever its own code
// happens to load: the key inventory (classify() in lib/reencrypt.ts) and the
// person's data download (lib/user-export.ts, which gives each store declared
// exportable a section of its own). test/repo.test.ts fails if a module
// declares a store and is not imported here.
//
// Only stores built on the seam are here. Anything walking this catalogue
// misses the older stores, goals and budgets and history among them, until
// each moves behind the seam; the data download reads those itself.
//
// One line per declaring module, in alphabetical order, like:
//   import './rules';

import './allocation-settings';
import './connection-records';
import './fire-plan';
import './holdings-history';
import './rate-limit';

import { storesDeclaredSoFar, type Store } from './repo';

/** Every declared store, in name order. */
export function declaredStores(): Store[] {
  return [...storesDeclaredSoFar().values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The store declared under a name (its key family), or null. */
export function declaredStore(name: string): Store | null {
  return storesDeclaredSoFar().get(name) ?? null;
}
