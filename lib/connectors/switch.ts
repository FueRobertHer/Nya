// lib/connectors/switch.ts
//
// Whether this deployment offers connecting Lunch Flow: off unless
// LUNCHFLOW_ENABLED=1 (docs/deployment.md, docs/operations.md). Off by
// default for two reasons the owner settles before turning it on:
//
//   - Lunch Flow's documentation points an app that accesses other users'
//     data to its Platform API, and a hosted Nya looks like one from its side
//     (lib/connectors/lunchflow.ts TERMS). So its leave for each person
//     bringing their own Personal API key is confirmed in writing first.
//   - A release from before Lunch Flow reads the connector stores strictly,
//     each as a whole, and doesn't know a Lunch Flow entry. Once anyone has a
//     Lunch Flow connection, rolling back past this release leaves every
//     connector account of theirs unreadable there, SimpleFIN's included.
//
// Turning it off again stops new connections only. Those already made keep
// working (the daily fetch, Refresh, Connect again with a new key, Choose
// accounts and Disconnect), so nobody's accounts stop updating, or are left
// with nothing to do about them, because of a switch they can't see.
//
// Server only: the page reads it (app/page.tsx) and the connect route refuses
// a new connection with it off (lib/connectors/manage.ts connect).

import type { ConnectorKind } from './types';

/** Whether new Lunch Flow connections may be made: LUNCHFLOW_ENABLED=1, and
 *  any other value (or none) is off. */
export function lunchFlowEnabled(): boolean {
  return process.env.LUNCHFLOW_ENABLED === '1';
}

/** Whether a new connection of this kind may be made here. */
export function connectorOffered(kind: ConnectorKind): boolean {
  return kind !== 'lunchflow' || lunchFlowEnabled();
}
