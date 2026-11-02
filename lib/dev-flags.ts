// lib/dev-flags.ts
//
// Whether this server may show /dev/flags, where anyone signed in, demo
// accounts included, sets the feature switches (lib/flags.ts) for local
// development. Only under `next dev` (NODE_ENV development), off Vercel (no
// VERCEL variable, so Vercel's own Development environment is out too, as is
// its `development:` prefix), on the `dev:` prefix, and only when
// NYA_DEV_FLAGS=1, which `bun run dev` sets and binds the server to this
// machine (127.0.0.1); `bun run dev:lan`, which answers the local network for
// trying the app on a phone, leaves the page off. With REDIS_PREFIX set to
// production or preview locally, as the scripts do, the page is missing.
// Whoever reaches a dev server some other way can change only the `dev:`
// prefix's switches. Anything else and the page and its route are missing.

import { envPrefix } from './storage';

/** The rule, over the values it is decided by. */
export function devFlagsOn(env: { nodeEnv: string | undefined; vercel: string | undefined; prefix: string; flag: string | undefined }): boolean {
  return env.nodeEnv === 'development' && !env.vercel && env.prefix === 'dev:' && env.flag === '1';
}

/** The rule, for this process. */
export function devFlagsHere(): boolean {
  return devFlagsOn({ nodeEnv: process.env.NODE_ENV, vercel: process.env.VERCEL, prefix: envPrefix(), flag: process.env.NYA_DEV_FLAGS });
}
