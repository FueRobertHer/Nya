// lib/connectors/registry.ts
//
// Every connector Nya can use, by kind (lib/connectors/types.ts). Adding one
// is a module implementing ConnectorDef and a line here (Lunch Flow's Personal
// API was the second); the stores, the daily fetch, net worth and the screens
// take it from there.

import { SIMPLEFIN } from './simplefin';
import { LUNCHFLOW } from './lunchflow';
import type { ConnectorDef, ConnectorKind } from './types';

export const CONNECTORS: Readonly<Record<ConnectorKind, ConnectorDef>> = {
  simplefin: SIMPLEFIN,
  lunchflow: LUNCHFLOW,
};

export function connectorOf(kind: ConnectorKind): ConnectorDef {
  return CONNECTORS[kind];
}
