// lib/connectors/registry.ts
//
// Every connector Nya can use, by kind (lib/connectors/types.ts). Adding one
// (Lunch Flow's personal API, say) is a module implementing ConnectorDef and
// a line here; the stores, the daily fetch, net worth and the screens take it
// from there.

import { SIMPLEFIN } from './simplefin';
import type { ConnectorDef, ConnectorKind } from './types';

export const CONNECTORS: Readonly<Record<ConnectorKind, ConnectorDef>> = {
  simplefin: SIMPLEFIN,
};

export function connectorOf(kind: ConnectorKind): ConnectorDef {
  return CONNECTORS[kind];
}
