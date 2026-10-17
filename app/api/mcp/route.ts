import { NextResponse } from 'next/server';
import { admit } from '@/lib/api-http';
import { appUrl } from '@/lib/app-url';
import { handleMessage, rpcError, RPC, PROTOCOL_VERSIONS } from '@/lib/mcp';

// The MCP server (lib/mcp.ts) over MCP's streamable HTTP transport, read only,
// with an API token (lib/api-tokens.ts) as a bearer token, exactly as the REST
// API takes it (lib/api-http.ts admit: the same check, the same limit per
// token, one request counted per HTTP request). proxy.ts lets it past the
// session gate: it reads no cookie.
//
//   POST  one JSON-RPC message: a request's answer as JSON, or 202 with no
//         body when there was nothing to answer (a notification). A batch (an
//         array) is refused, as MCP 2025-06-18 and later have no batches: so
//         every tool call is a request of its own, counted against the token's
//         limit, and no answer holds many.
//   GET   405: the server offers no stream of its own messages.
//   DELETE 405: there are no sessions to end.
//
// A request a browser sends from another site's page (an Origin that isn't
// this app's: APP_URL's when it is set, else the address the request came
// to) is refused. That stops a page elsewhere from calling it with a token it
// somehow holds; it isn't what stops DNS rebinding, where Host and Origin are
// both the attacker's name and match: a rebinding page has no token, and
// every request needs one. A client that isn't a browser sends no Origin. An
// MCP-Protocol-Version this server doesn't speak is a 400. No CORS headers
// are sent.

const MAX_BODY_CHARS = 256 * 1024;

/** This app's own origin: APP_URL's when it is set, else the one the request
 *  came to. */
function ownOrigin(req: Request): string {
  const configured = appUrl();
  return configured ? new URL(configured).origin : new URL(req.url).origin;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

/** The API's refusal (401, 429, 503), as a JSON-RPC error with its headers. */
async function refused(res: NextResponse): Promise<NextResponse> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  const headers: Record<string, string> = {};
  for (const name of ['www-authenticate', 'retry-after', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset']) {
    const v = res.headers.get(name);
    if (v !== null) headers[name] = v;
  }
  return json(res.status, rpcError(null, -32000, body?.error?.message ?? 'Refused.'), headers);
}

export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  if (origin !== null && origin !== ownOrigin(req)) {
    return json(403, rpcError(null, -32000, 'Requests from other sites are not accepted.'));
  }
  const version = req.headers.get('mcp-protocol-version');
  if (version !== null && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json(400, rpcError(null, RPC.invalidRequest, `This server speaks MCP ${PROTOCOL_VERSIONS.join(', ')}.`));
  }

  const admitted = await admit(req);
  if (admitted instanceof NextResponse) return refused(admitted);
  const { auth, limits } = admitted;

  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return json(413, rpcError(null, RPC.invalidRequest, 'The request is too large.'), limits);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, rpcError(null, RPC.parse, 'Parse error: the body is not JSON.'), limits);
  }

  if (Array.isArray(body)) {
    return json(400, rpcError(null, RPC.invalidRequest, 'Batches are not accepted: send one JSON-RPC message per request.'), limits);
  }

  const answer = await handleMessage(auth, body);
  if (!answer) return new NextResponse(null, { status: 202, headers: limits });
  // A message that isn't one at all has no request to answer in kind.
  const malformed = 'error' in answer && answer.error.code === RPC.invalidRequest && answer.id === null;
  return json(malformed ? 400 : 200, answer, limits);
}

const noStream = () => json(405, rpcError(null, -32000, 'This server answers POST only: it offers no stream, and keeps no sessions.'), { Allow: 'POST' });
export const GET = noStream;
export const DELETE = noStream;
export const PUT = noStream;
export const PATCH = noStream;
