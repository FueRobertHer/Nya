// lib/plaid-scrub.ts
//
// Strips what a failed Plaid call carries before anything can print it.
//
// The SDK is axios underneath, and an axios error holds the request it failed
// on: `config.headers` has PLAID-CLIENT-ID and PLAID-SECRET, `config.data` is
// the JSON body (an access token for most calls), and `request` is the raw
// client request, whose header text repeats the secret. `response` points back
// at the same config and request. Printing such an error, or anything that
// keeps it as a cause, copies the secret and the token into the logs.
//
// So the client's axios instance rejects with the same error minus all of that.
// What says which call failed stays (the endpoint and the method), and so does
// Plaid's answer (`response.status`, `response.data`), which callers read for
// error codes. lib/log-safe.ts is the second line, for logging anything that
// went around this client.

import { PlaidApi, type Configuration } from 'plaid';
import type { AxiosInstance } from 'axios';

/** What is left of a request's config: enough to name the call, nothing more. */
type SafeConfig = { url?: string; method?: string; timeout?: number };

function safeConfig(config: unknown): SafeConfig | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const c = config as Record<string, unknown>;
  const out: SafeConfig = {};
  if (typeof c.url === 'string') out.url = c.url;
  if (typeof c.method === 'string') out.method = c.method;
  if (typeof c.timeout === 'number') out.timeout = c.timeout;
  return out;
}

/**
 * Removes the request (headers, body, the raw client request) from an axios
 * error, in place, and returns it. The error stays the SDK's own error class,
 * so `isAxiosError` checks and `err.response.data.error_code` work as before.
 */
export function scrubPlaidError(err: unknown): unknown {
  if (!err || typeof err !== 'object') return err;
  const e = err as Record<string, unknown>;
  const config = safeConfig(e.config);
  if ('config' in e) e.config = config;
  if ('request' in e) delete e.request;
  const response = e.response;
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>;
    if ('config' in r) r.config = config;
    if ('request' in r) delete r.request;
  }
  return err;
}

/**
 * An axios instance whose failures come out scrubbed. Response interceptors see
 * every failure of a request, timeouts and network errors included, once the
 * request runs through axios's promise chain. With no request interceptor,
 * axios takes a synchronous path on which a request cancelled before it starts
 * throws without passing them, so a pass-through request interceptor keeps
 * every request on the chain.
 */
export function scrubbing(instance: AxiosInstance): AxiosInstance {
  instance.interceptors.request.use((config) => config);
  instance.interceptors.response.use(undefined, (err: unknown) => Promise.reject(scrubPlaidError(err)));
  return instance;
}

/**
 * A Plaid client that never throws its own request. The SDK keeps its axios
 * instance on the protected `axios` field (the global one, unless given
 * another); a new instance is made from it rather than adding an interceptor to
 * the global, which anything else in the process might share, and rather than
 * importing axios here, which this app only has through the SDK.
 */
export function makePlaidClient(configuration: Configuration): PlaidApi {
  const sdkAxios = (new PlaidApi(configuration) as unknown as { axios: AxiosInstance }).axios;
  return new PlaidApi(configuration, undefined, scrubbing(sdkAxios.create()));
}
