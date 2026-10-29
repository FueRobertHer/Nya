// lib/manual-types.ts
//
// The kinds a manual account can be. Apart from lib/manual.ts, which reads and
// writes storage, so a client component can list them without pulling the
// storage seam into its bundle.

export const MANUAL_TYPES = ['depository', 'credit', 'investment', 'loan', 'other'] as const;
export type ManualType = (typeof MANUAL_TYPES)[number];
