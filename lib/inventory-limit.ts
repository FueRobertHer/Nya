// lib/inventory-limit.ts
//
// How often Your data (app/your-data, /api/data-inventory) is counted for one
// account: each look walks the database's whole keyspace (lib/repo.ts
// measureContainer), as the restore's look at whether an account is empty
// does, so it is held to a count the same way (lib/user-restore/store.ts
// previewsCount). A counter store on the seam: in the person's container, a
// plain count, never in the download.

import { defineCounterStore } from './repo';

/** Looks at Your data an account may take in an hour. */
export const INVENTORY_READS_PER_HOUR = 30;

export const inventoryReadCount = defineCounterStore('inventory-reads', { what: 'looks at Your data', windowSeconds: 60 * 60 });
