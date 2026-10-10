import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { StoredDataUnreadableError, UnreadableEntriesError, StoreRefusedError, describeUnreadable } from '@/lib/repo';
import { freshSignIn, PASSWORD_MAX } from '@/lib/fresh-sign-in';
import { apiTokenStore, cleanLabel, createToken, listTokens, revokeToken, TokenLimitError, MAX_TOKENS, DEMO_REFUSAL } from '@/lib/api-tokens';
import { clerkEnabled } from '@/lib/auth-mode';
import { isDemoUser } from '@/lib/demo';
import { loggable } from '@/lib/log-safe';

// The API tokens card (components/ApiTokens.tsx): the person's own tokens for
// the read-only API and the MCP server (lib/api-tokens.ts). Behind the session
// gate like every other route; the tokens themselves are only ever checked by
// app/api/v1 and app/api/mcp.
//
//   GET     { tokens: [{ id, label, hint, created_at, last_used_at }],
//             unreadable: [id], unrecognised: [id], limit }
//   POST    { label, password? }  makes one: { token, info }. The token is in
//           this answer and nowhere else, ever: only its hash is kept.
//   DELETE  { id, unreadable? }   revokes one: { revoked: true }, or 404.
//
// Making a token needs a FRESH SIGN-IN (lib/fresh-sign-in.ts, as downloading
// everything does): a token goes on reading the data after "Sign out
// everywhere", so a stolen session cookie must not be able to make one. The
// token keeps the Clerk account that made it, which must go on owning the
// container and being allowed in for it to work. The limit (MAX_TOKENS) is
// checked before the sign-in, so a person at it isn't asked to sign in for
// nothing, and again as the token is saved. A DEMO account (Preview's shared
// ones, lib/demo.ts) can't make one: everyone who tries the demo shares its
// data, and a token would go on reading what later visitors type. A sandbox
// for developers is a later step. Revoking needs only the session: it only
// ever takes access away.
//
// A token whose record can't be read is listed by id under `unreadable`
// (damaged: DELETE removes it once the person confirms, with unreadable:
// true) or `unrecognised` (saved by another version: never removed from
// here). Neither kind authenticates.

const LABEL_FIELD_MAX = 1000;

/** The answer for what the seam or the container refused, or anything else. */
function failure(err: unknown, doing: string): NextResponse {
  const unavailable = containerUnavailable(err);
  if (unavailable) return unavailable;
  if (err instanceof StoredDataUnreadableError) {
    console.error('Stored API tokens unreadable:', describeUnreadable(err));
    const entries = err instanceof UnreadableEntriesError ? err : null;
    return NextResponse.json(
      {
        error: err.message,
        unreadable: true,
        ...(entries ? { unreadable_ids: entries.unreadable, unrecognised_ids: entries.unrecognised } : {}),
      },
      { status: 409 }
    );
  }
  if (err instanceof StoreRefusedError) return NextResponse.json({ error: err.message }, { status: err.status });
  console.error(`API tokens: ${doing} failed`, loggable(err));
  return NextResponse.json({ error: `Could not ${doing} API tokens.` }, { status: 500 });
}

const noStore = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const ctx = await dataCtx();
    const { tokens, unreadable, unrecognised } = await listTokens(ctx);
    return NextResponse.json({ tokens, unreadable, unrecognised, limit: MAX_TOKENS }, { headers: noStore });
  } catch (err) {
    return failure(err, 'read');
  }
}

export async function POST(req: Request) {
  let ctx: Ctx;
  try {
    ctx = await dataCtx();
  } catch (err) {
    return failure(err, 'make');
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Send { label }.' }, { status: 400 });
  const { label: rawLabel, password } = body;
  if (typeof rawLabel === 'string' && rawLabel.length > LABEL_FIELD_MAX) return NextResponse.json({ error: 'That name is too long.' }, { status: 400 });
  const label = cleanLabel(rawLabel);
  if (typeof label !== 'string') return NextResponse.json({ error: label.error }, { status: 400 });
  if (password !== undefined && password !== null && (typeof password !== 'string' || password.length > PASSWORD_MAX)) {
    return NextResponse.json({ error: 'password must be text.' }, { status: 400 });
  }

  // Before the sign-in, so a demo visitor isn't asked to confirm it's them for nothing.
  if (clerkEnabled()) {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    if (userId && isDemoUser(userId)) return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403 });
  }

  try {
    if ((await apiTokenStore.count(ctx)) >= MAX_TOKENS) return NextResponse.json({ error: new TokenLimitError().message }, { status: 409 });
  } catch (err) {
    return failure(err, 'make');
  }

  const signedIn = await freshSignIn(req, typeof password === 'string' ? password : null);
  if (signedIn instanceof NextResponse) return signedIn;
  if (signedIn.userId && isDemoUser(signedIn.userId)) return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403 });

  try {
    const { token, info } = await createToken(ctx, label, new Date(), signedIn.userId);
    // Never the token itself: it is in this answer alone.
    console.log('API token made');
    return NextResponse.json({ token, info }, { headers: noStore });
  } catch (err) {
    if (err instanceof TokenLimitError) return NextResponse.json({ error: err.message }, { status: 409 });
    return failure(err, 'make');
  }
}

export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = body?.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return NextResponse.json({ error: 'Send the id of the token to revoke.' }, { status: 400 });
  if (body?.unreadable !== undefined && typeof body.unreadable !== 'boolean') return NextResponse.json({ error: 'unreadable is true or false.' }, { status: 400 });
  try {
    const ctx = await dataCtx();
    const revoked = await revokeToken(ctx, id, { unreadable: body?.unreadable === true });
    if (!revoked) return NextResponse.json({ error: 'No such token: it may have been revoked already.' }, { status: 404 });
    console.log('API token revoked');
    return NextResponse.json({ revoked: true });
  } catch (err) {
    return failure(err, 'revoke');
  }
}
