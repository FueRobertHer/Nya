// lib/connectors/http.ts
//
// The one way a connector reaches the network: an HTTPS request guarded
// against server-side request forgery. A connector's URLs come from the person
// (SimpleFIN's Setup Token is a URL they paste; the Access URL it is exchanged
// for is whatever the server named), so every request is held to these rules:
//
//   - https only, on any port;
//   - no credentials in the URL itself: the caller passes them separately
//     (a user name and password, sent as an Authorization header, or an API
//     key, sent in a header of its own), and they are sent only to the URL's
//     own origin (scheme, host and port), or to the few others the caller
//     names as the same service's (`trustedOrigins`: Lunch Flow's site at
//     its www name), never to another host a redirect names;
//   - every address the host resolves to must be public
//     (lib/connectors/net-guard.ts), checked after DNS resolution and pinned:
//     the connection goes to the address that was checked, through the
//     request's own `lookup`, so a name that resolves differently a moment
//     later (DNS rebinding) can't slip a private address in. A host written as
//     an address is checked as it is;
//   - at most MAX_REDIRECTS redirects, each held to every rule above;
//   - one deadline for the whole exchange, redirects included, so an answer
//     that comes slowly, a byte at a time, is cut off like one that never
//     comes;
//   - a bounded answer: one declared or found to be over `maxBytes` is
//     dropped, never read whole.
//
// ERRORS NAME THE HOST, NEVER THE URL. An Access URL carries its credentials,
// and its path can be as private: no error made here holds a URL, a path, a
// header or the request's options, and none wraps the error underneath (whose
// fields say more than its message), only that error's code. They are safe to
// pass through loggable() (lib/log-safe.ts) and to show.
//
// THE TRANSPORT is how names are resolved and which addresses are allowed,
// plus any extra certificate to trust. Production uses the system resolver and
// isPublicAddress; tests point a name at a local fake server with a
// certificate of their own (setTransportForTests), and allow only that.

import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPublicAddress } from './net-guard';

/** How many redirects a request follows before giving up. */
export const MAX_REDIRECTS = 3;

/** Resolves a host name to every address it has. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export type Transport = {
  resolve: Resolver;
  /** Whether a connection to this address is allowed. */
  allowAddress: (address: string) => boolean;
  /** Certificates to trust in place of the system's (a test's own). */
  ca?: string;
};

const systemResolve: Resolver = async (host) => dnsLookup(host, { all: true, verbatim: true });

/** The real network: the system's resolver, public addresses only. */
export const SYSTEM_TRANSPORT: Transport = { resolve: systemResolve, allowAddress: isPublicAddress };

let testTransport: Transport | null = null;

/** For tests: route every connector request through `t` (a local fake
 *  server), or back to the real network with null. */
export function setTransportForTests(t: Transport | null): void {
  testTransport = t;
}

/** The transport requests use. */
export function currentTransport(): Transport {
  return testTransport ?? SYSTEM_TRANSPORT;
}

/** Why a URL was refused before anything was sent to it. */
export type RefusalReason = 'scheme' | 'credentials' | 'host' | 'address' | 'redirect';

/** A request refused by the rules above: nothing was sent. */
export class UnsafeUrlError extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string
  ) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** Why a request that was allowed didn't come back with an answer. */
export type FailureReason = 'timeout' | 'too-large' | 'network' | 'tls' | 'redirects';

/** A request that was sent but brought no usable answer. `code` is the
 *  system's code for a network failure (ECONNREFUSED, ...), when there was
 *  one. */
export class RequestFailedError extends Error {
  constructor(
    readonly reason: FailureReason,
    message: string,
    readonly code: string | null = null
  ) {
    super(message);
    this.name = 'RequestFailedError';
  }
}

export type GuardedRequest = {
  method: 'GET' | 'POST';
  /** No credentials in it: pass them as `auth` or `key`. */
  url: URL;
  /** Sent as HTTP Basic authorization, to `url`'s origin (or a trusted one) only. */
  auth?: { user: string; password: string };
  /** An API key, sent in the header named, to `url`'s origin (or a trusted
   *  one) only. The header is one of the service's own (x-api-key), never one
   *  this module sets itself. */
  key?: { header: string; value: string };
  /** Other origins (https://host[:port]) that are the same service as `url`'s,
   *  which a redirect may lead to with the credentials. None by default. */
  trustedOrigins?: readonly string[];
  accept: string;
  timeoutMs: number;
  maxBytes: number;
};

/** The headers this module sets itself, which a key's header may never be. */
const OWN_HEADERS = new Set(['host', 'accept', 'user-agent', 'content-length', 'authorization', 'cookie', 'connection', 'transfer-encoding']);

export type GuardedResponse = { status: number; contentType: string | null; body: string };

/** The host as a connection takes it: an IPv6 address without its brackets. */
const bareHost = (url: URL) => url.hostname.replace(/^\[(.*)\]$/, '$1');

/**
 * Refuses a URL the rules don't allow, before anything is sent: not https, with
 * credentials in it, without a usable host, or naming an address that isn't
 * allowed. A host name's addresses are checked when it is resolved.
 */
export function checkUrl(url: URL, transport: Transport = currentTransport()): void {
  if (url.protocol !== 'https:') throw new UnsafeUrlError('scheme', 'Only https addresses are used.');
  if (url.username || url.password) throw new UnsafeUrlError('credentials', `The address for ${url.hostname} has credentials in it, which Nya never sends that way.`);
  const host = bareHost(url);
  if (!host || host.includes('%') || host.length > 253) throw new UnsafeUrlError('host', 'The address has no host Nya can use.');
  if (isIP(host) && !transport.allowAddress(host)) {
    throw new UnsafeUrlError('address', `${url.hostname} is not a public address, so Nya won't connect to it.`);
  }
}

/** A lookup for one request: resolves through the transport and passes on
 *  only addresses that are all allowed, so the connection is made to an
 *  address that was checked. */
function guardedLookup(transport: Transport): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (err: Error | null, address?: unknown, family?: number) => void) => {
    transport.resolve(hostname).then(
      (found) => {
        if (found.length === 0) return callback(new RequestFailedError('network', `${hostname} could not be found.`, 'ENOTFOUND'));
        // Every address, not just the first: a name resolving to a public and
        // a private address is refused whole.
        if (found.some((a) => !transport.allowAddress(a.address))) {
          return callback(new UnsafeUrlError('address', `${hostname} resolves to an address that is not public, so Nya won't connect to it.`));
        }
        if (options?.all) return callback(null, found.map((a) => ({ address: a.address, family: a.family })));
        callback(null, found[0].address, found[0].family);
      },
      () => callback(new RequestFailedError('network', `${hostname} could not be found.`, 'ENOTFOUND'))
    );
  }) as unknown as LookupFunction;
}

/** A network error as this module reports it: its code and the host, nothing
 *  of its own fields. */
function failureOf(err: unknown, host: string): Error {
  if (err instanceof UnsafeUrlError || err instanceof RequestFailedError) return err;
  const code = typeof (err as { code?: unknown })?.code === 'string' ? ((err as { code: string }).code.slice(0, 40)) : null;
  if (code && /CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO|HOSTNAME|DEPTH_ZERO/.test(code)) {
    return new RequestFailedError('tls', `${host}'s certificate couldn't be verified.`, code);
  }
  return new RequestFailedError('network', `${host} couldn't be reached${code ? ` (${code})` : ''}.`, code);
}

type OneAnswer = { status: number; location: string | null; contentType: string | null; body: Buffer };

/** One request, no redirects followed, within `deadline` (a time). */
function once(url: URL, req: GuardedRequest, sendAuth: boolean, deadline: number, transport: Transport): Promise<OneAnswer> {
  const host = bareHost(url);
  const literal = isIP(host) !== 0;
  const headers: Record<string, string> = { Host: url.host, Accept: req.accept, 'User-Agent': 'Nya' };
  if (req.method === 'POST') headers['Content-Length'] = '0';
  if (sendAuth && req.auth) {
    headers.Authorization = `Basic ${Buffer.from(`${req.auth.user}:${req.auth.password}`, 'utf8').toString('base64')}`;
  }
  if (sendAuth && req.key) headers[req.key.header] = req.key.value;
  return new Promise<OneAnswer>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const request = httpsRequest(
      {
        protocol: 'https:',
        hostname: host,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
        // A connection of its own each time, so the lookup below decides
        // where every request goes: no pooled socket opened for another.
        agent: false,
        ...(literal ? {} : { lookup: guardedLookup(transport), servername: host }),
        ...(transport.ca ? { ca: transport.ca } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > req.maxBytes) {
          request.destroy();
          return finish(() => reject(new RequestFailedError('too-large', `${url.hostname}'s answer was too large to read.`)));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > req.maxBytes) {
            request.destroy();
            finish(() => reject(new RequestFailedError('too-large', `${url.hostname}'s answer was too large to read.`)));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(() =>
            resolve({
              status,
              location: typeof res.headers.location === 'string' ? res.headers.location : null,
              contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null,
              body: Buffer.concat(chunks),
            })
          )
        );
        res.on('error', (err) => finish(() => reject(failureOf(err, url.hostname))));
      }
    );
    const timer = setTimeout(() => {
      request.destroy();
      finish(() => reject(new RequestFailedError('timeout', `${url.hostname} didn't answer in time.`)));
    }, Math.max(0, deadline - Date.now()));
    request.on('error', (err) => finish(() => reject(failureOf(err, url.hostname))));
    request.end();
  });
}

/**
 * Sends one request under the rules in the header, following redirects, and
 * answers with the final response's status, content type and body as text.
 * Throws UnsafeUrlError when a rule refused a URL (nothing was sent to it),
 * RequestFailedError when no usable answer came.
 */
export async function guardedRequest(req: GuardedRequest, transport: Transport = currentTransport()): Promise<GuardedResponse> {
  const deadline = Date.now() + req.timeoutMs;
  const origin = req.url.origin;
  // The origins the credentials may go to: the URL's own, and those the
  // caller names as the same service's.
  const trusted = new Set([origin, ...(req.trustedOrigins ?? [])]);
  if (req.key && (!/^[A-Za-z0-9-]{1,64}$/.test(req.key.header) || OWN_HEADERS.has(req.key.header.toLowerCase()) || /[\r\n\0]/.test(req.key.value))) {
    throw new UnsafeUrlError('credentials', 'The key would be sent in a way Nya never sends one.');
  }
  let url = req.url;
  for (let hop = 0; ; hop++) {
    checkUrl(url, transport);
    const answer = await once(url, req, trusted.has(url.origin), deadline, transport);
    const redirect = [301, 302, 303, 307, 308].includes(answer.status) && answer.location !== null;
    if (!redirect) {
      return { status: answer.status, contentType: answer.contentType, body: new TextDecoder().decode(answer.body) };
    }
    if (hop >= MAX_REDIRECTS) throw new RequestFailedError('redirects', `${req.url.hostname} redirected too many times.`);
    let next: URL;
    try {
      next = new URL(answer.location!, url);
    } catch {
      throw new UnsafeUrlError('redirect', `${url.hostname} redirected to an address Nya can't read.`);
    }
    // Credentials go to their own origin (or a trusted one) only: a redirect
    // elsewhere would either drop them (and fail) or hand them to another host.
    if ((req.auth || req.key) && !trusted.has(next.origin)) {
      throw new UnsafeUrlError('redirect', `${req.url.hostname} redirected to another host, so Nya didn't follow it with your access.`);
    }
    url = next;
  }
}
