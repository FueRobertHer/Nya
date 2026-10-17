import { NextResponse } from 'next/server';
import { ContainerKeyError } from '@/lib/crypto';
import { StoredDataUnreadableError, describeUnreadable } from '@/lib/repo';
import { loggable } from '@/lib/log-safe';
import { countTokenFailure, tokenFailuresExhausted, API_AUTH_WINDOW_SECONDS } from '@/lib/rate-limit';
import { checkLink, parseLinkToken, takeUnsubscribe, turnOff, OFF_MESSAGE, REFUSED_MESSAGE, TOKEN_LENGTH } from '@/lib/weekly-summary/unsubscribe';

// The link in each weekly summary that turns it off (lib/weekly-summary/
// unsubscribe.ts), without signing in. It authenticates itself, by the token
// in its own address (?t=), so proxy.ts lets it past the session gate: no
// cookie is read, and a session alone does nothing here.
//
//   GET   a link opened in a browser: never acted on, since mail apps and the
//         security scanners in front of them open links on their own. Sent on
//         (303) to the page that asks first (app/unsubscribe).
//   POST  turns the summary off: from a mail app's own unsubscribe, which
//         posts "List-Unsubscribe=One-Click" to the link in the
//         List-Unsubscribe header (RFC 8058), or from the page's button.
//         200 { ok: true, message } whatever the summary was (already off, or
//         never set up), so the answer tells nothing.
//
// A token that doesn't work gets one answer whatever the reason (not a
// token, forged, altered, expired, for a container that doesn't exist or has
// no summary), and nothing about any container: 400 with the same message.
// One in the right form that doesn't work is counted against the address it
// came from, with the API's tokens that don't work, and an address past a
// flood of them is turned away (429) for the rest of the window before
// anything is read. A token that works is counted against its container's
// limit (lib/weekly-summary/store.ts). Only a working token is told that its
// data can't be reached just now (503): its container being restored, or its
// data key unusable once the link checked out.

const NO_STORE = { 'Cache-Control': 'no-store' };

const refused = () => NextResponse.json({ error: REFUSED_MESSAGE }, { status: 400, headers: NO_STORE });
const unavailable = () => NextResponse.json({ error: 'Your data can’t be reached just now. Try the link again later.' }, { status: 503, headers: NO_STORE });

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('t');
  const page = new URL('/unsubscribe', req.url);
  if (token && token.length <= TOKEN_LENGTH) page.searchParams.set('t', token);
  return NextResponse.redirect(page, { status: 303, headers: NO_STORE });
}

export async function POST(req: Request) {
  const token = new URL(req.url).searchParams.get('t');
  // Not even in a token's form: refused before anything is read or counted.
  if (!parseLinkToken(token)) return refused();
  if (await tokenFailuresExhausted(req)) {
    return NextResponse.json({ error: 'Too many links that don’t work came from here. Try again later.' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(API_AUTH_WINDOW_SECONDS) } });
  }
  try {
    const check = await checkLink(token);
    if (check.kind === 'malformed' || check.kind === 'refused') {
      await countTokenFailure(req);
      return refused();
    }
    if (check.kind === 'unavailable') return unavailable();
    const allowed = await takeUnsubscribe(check.ctx);
    if (!allowed.ok) return NextResponse.json({ error: 'This link was used too often just now. Try again later.' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': String(allowed.retryAfterSeconds) } });
    await turnOff(check.ctx);
    console.log('Weekly summary: turned off from its link.');
    return NextResponse.json({ ok: true, message: OFF_MESSAGE }, { headers: NO_STORE });
  } catch (err) {
    // Its data key, once the link checked out (a value still under the shared
    // key read, its own key couldn't be used to write).
    if (err instanceof ContainerKeyError) {
      console.error('Weekly summary: a link could not turn it off, as the data key of its container can’t be used just now.');
      return unavailable();
    }
    if (err instanceof StoredDataUnreadableError) {
      console.error('Weekly summary: a link could not turn it off, as its setting could not be read.', describeUnreadable(err));
      return NextResponse.json(
        {
          error:
            'Nya couldn’t read your weekly summary’s setting, so it couldn’t turn it off. No summary goes while it can’t be read; to be sure, sign in to Nya and turn it off under Manage on the Accounts tab.',
          unreadable: true,
        },
        { status: 409, headers: NO_STORE }
      );
    }
    console.error('Weekly summary: a link could not turn it off.', loggable(err));
    return NextResponse.json({ error: 'Something went wrong. Try the link again later.' }, { status: 500, headers: NO_STORE });
  }
}
