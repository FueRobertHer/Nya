import { NextResponse } from 'next/server';
import { admit } from '@/lib/api-http';
import { handleMessage, rpcError, RPC, PROTOCOL_VERSIONS, type RpcResponse } from '@/lib/mcp';

// The MCP server (lib/mcp.ts) over MCP's streamable HTTP transport, read only,
// with an API token (lib/api-tokens.ts) as a bearer token, exactly as the REST
// API takes it (lib/api-http.ts admit: the same check, the same limit per
// token, one request counted per HTTP request). proxy.ts lets it past the
// session gate: it reads no cookie.
//
//   POST  one JSON-RPC message, or a batch of them (2025-03-26 allows one;
//         later versions send none): each request's answer as JSON, or 202
//         with no body when there was nothing to answer (a notification).
//   GET   405: the server offers no stream of its own messages.
//   DELETE 405: there are no sessions to end.
//
// As the transport requires, a request a browser sends from another site (an
// Origin that isn't this one) is refused, against DNS rebinding; a client
// that isn't a browser sends none. An MCP-Protocol-Version this server doesn't
// speak is a 400. No CORS headers are sent.

const MAX_BODY_CHARS = 256 * 1024;
const MAX_BATCH = 20;

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
  if (origin !== null && origin !== new URL(req.url).origin) {
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
    if (body.length === 0 || body.length > MAX_BATCH) return json(400, rpcError(null, RPC.invalidRequest, `A batch holds 1 to ${MAX_BATCH} messages.`), limits);
    // One at a time: each tool reads the data whole, and a batch is no reason
    // to read it many times at once.
    const answers: RpcResponse[] = [];
    for (const m of body) {
      const answer = await handleMessage(auth, m);
      if (answer) answers.push(answer);
    }
    return answers.length > 0 ? json(200, answers, limits) : new NextResponse(null, { status: 202, headers: limits });
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
