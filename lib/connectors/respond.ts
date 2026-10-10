// lib/connectors/respond.ts
//
// How the connector routes (app/api/connectors) read a request and answer a
// failure, the same way in each: a body of bounded size that is a JSON
// object, and every error in words for the person, logged without anything a
// request held (the Setup Token, the Access URL: lib/log-safe.ts loggable).

import { NextResponse } from 'next/server';
import { ExchangeFailure, type ExchangeFailureKind } from './types';
import { ConnectorRefused } from './manage';
import { storeFailure } from '../store-failure';

/** Far more than any of these requests needs: a token is at most 4 KB. */
const MAX_BODY_CHARS = 16 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The body as an object, or the response refusing it. */
export async function readJson(req: Request): Promise<Record<string, unknown> | NextResponse> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
  try {
    const body = JSON.parse(text);
    if (isRecord(body)) return body;
  } catch {
    // Not JSON: refused below.
  }
  return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
}

/** A connection's id as Nya makes them (lib/connectors/store.ts). */
export const isConnectionId = (v: unknown): v is string => typeof v === 'string' && /^conn_[0-9a-f-]{36}$/.test(v);

const EXCHANGE_STATUS: Record<ExchangeFailureKind, number> = { invalid: 400, claimed: 409, blocked: 400, down: 502, answer: 502 };

/** The answer for an error in a connector route. */
export function connectorError(err: unknown, fallback: string): NextResponse {
  if (err instanceof ConnectorRefused) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ExchangeFailure) return NextResponse.json({ error: err.message, kind: err.kind }, { status: EXCHANGE_STATUS[err.kind] });
  return storeFailure(err, fallback);
}
