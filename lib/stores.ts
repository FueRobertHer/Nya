// lib/stores.ts
//
// The catalogue of stores declared through the storage seam (lib/repo.ts).
//
// A store is declared in its own module, next to its type and shape check, and
// registers itself when that module loads. Each such module is imported below,
// so anything that walks every store sees all of them, whatever its own code
// happens to load: the key inventory (classify() in lib/reencrypt.ts), the
// person's data download (lib/user-export.ts, which gives each store declared
// exportable a section of its own) and their list of what Nya keeps about them
// (lib/inventory.ts). test/repo.test.ts fails if a module declares a store and
// is not imported here.
//
// Only stores built on the seam are here. Anything walking this catalogue
// misses the older stores, goals and budgets and history among them, until
// each moves behind the seam; the data download reads those itself.
//
// One line per declaring module, in alphabetical order, like:
//   import './rules';

import './access-log';
import './allocation-settings';
import './api-changes';
import './api-token-store';
import './budget-months-store';
import './budget-store';
import './category-store';
import './connection-records';
import './connectors/store';
import './fire-plan';
import './fx/ecb-store';
import './fx/settings';
import './goal-plans';
import './groups';
import './history-import/store';
import './holdings-history';
import './import/store';
import './inventory-limit';
import './lifecycle';
import './manual-txns';
import './migration/store';
import './plan-scenarios';
import './planned-store';
import './rate-limit';
import './report/runway-scenario-store';
import './report/store';
import './review-store';
import './rules';
import './share-limit';
import './sign-repair-store';
import './splits';
import './tags';
import './timeline-notes';
import './txn-annotations';
import './user-restore/store';
import './vendor-default-store';
import './weekly-summary/store';

import { publicStoresDeclaredSoFar, storesDeclaredSoFar, type PublicMapStore, type Store } from './repo';

/** Every declared store, in name order. */
export function declaredStores(): Store[] {
  return [...storesDeclaredSoFar().values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The store declared under a name (its key family), or null. */
export function declaredStore(name: string): Store | null {
  return storesDeclaredSoFar().get(name) ?? null;
}

/** Every public store (lib/repo.ts definePublicMapStore), in name order:
 *  environment-wide public data, apart from the containers' stores. */
export function declaredPublicStores(): PublicMapStore<unknown>[] {
  return [...publicStoresDeclaredSoFar().values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The public store declared under a name, or null. */
export function declaredPublicStore(name: string): PublicMapStore<unknown> | null {
  return publicStoresDeclaredSoFar().get(name) ?? null;
}
