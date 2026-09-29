// lib/webhook-url.ts
//
// Where Plaid is told to send webhooks, from PLAID_WEBHOOK_URL: the public
// https URL of /api/plaid/webhook on this deployment. Unset, webhooks are off
// and the app behaves as it did before them: nothing tells it new data has
// arrived, so its caches stay short (lib/cache.ts).
//
// The container rides in the query string. Plaid signs the body, not the URL,
// so this is only a routing hint: the route checks the Item really belongs to
// that container before acting (app/api/plaid/webhook/route.ts).

import type { Ctx } from './containers';

/** The configured base URL, or undefined when unset or not a usable https URL. */
export function webhookBase(): string | undefined {
  const raw = process.env.PLAID_WEBHOOK_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export function webhooksEnabled(): boolean {
  return webhookBase() !== undefined;
}

/** The URL to register for this container's Items, or undefined if webhooks are off. */
export function webhookUrlFor(ctx: Ctx): string | undefined {
  const base = webhookBase();
  if (!base) return undefined;
  const url = new URL(base);
  url.searchParams.set('c', ctx.container);
  return url.toString();
}
