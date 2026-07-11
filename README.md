# Nya

A Next.js + React app that connects to all your financial accounts — banks
(Ally, Chase), brokerages (Fidelity, Vanguard), credit cards, etc. — via
Plaid, and shows a combined balance sheet and net worth. Runs on Bun,
deploys to Vercel, installs on your phone as a PWA.

Plaid access tokens are encrypted (AES-256-GCM) before being stored in
Upstash Redis (via the Vercel Marketplace), and the whole app sits behind a password (see "Security notes"
below for why, and what's still not covered).

## 1. Get Plaid API keys

1. Sign up free at https://dashboard.plaid.com/signup
2. Go to **Team Settings → Keys** and copy your `client_id` and `sandbox` secret.

## 2. Create a Vercel project + Redis database

1. Push this folder to a GitHub repo.
2. In the [Vercel dashboard](https://vercel.com), import the repo as a new project.
3. Go to the project's **Storage** tab → **Create Database** → choose **Upstash for Redis** (Vercel KV was sunset; Upstash is its Marketplace successor) → connect it to this project. This automatically adds `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to your project's environment variables. (If you have a store that was auto-migrated from old Vercel KV, it uses the legacy `KV_REST_API_URL`/`KV_REST_API_TOKEN` names — the app supports both.)
4. Under **Settings → Environment Variables**, add:
   - `PLAID_CLIENT_ID`
   - `PLAID_SECRET`
   - `PLAID_ENV` (`sandbox` to start)
   - `PLAID_ENCRYPTION_KEY` — generate with `openssl rand -base64 32`
   - `APP_PASSWORD` — the password you'll use to open the app
   - `SESSION_SECRET` — generate with `openssl rand -base64 32`

## 3. Local development

```bash
bun install
vercel link          # connects this folder to the Vercel project you just made
vercel env pull .env.local   # pulls down KV credentials + your other env vars
bun run dev
```

Open http://localhost:3000 — you'll be redirected to `/login` first.

> Bun is Vercel's officially supported runtime for the API routes (`vercel.json` sets `bunVersion`). One nuance worth knowing: `middleware.ts` (the auth gate) always runs on Vercel's **Edge runtime**, not Bun — that's a Next.js constraint, not a choice made here. It's why `lib/auth.ts` uses the Web Crypto API instead of Node's `crypto`/`Buffer`: that code needs to work on Edge. If a future Vercel CLI/Next.js version changes the Bun config shape, check https://vercel.com/docs/functions/runtimes/bun for the current syntax.

## 4. Connect accounts

Log in, then click **Connect an Account**. Click it again for each
additional institution — Ally, Chase, Fidelity, etc. Each one gets added to
your dashboard with a running net worth total.

If Plaid Link asks you to reconnect an institution (shown as a "Reconnect"
button on that card), that means the bank's credentials or MFA changed on
their end — click it and log back in through Plaid to fix it, no need to
disconnect and relink from scratch.

In `sandbox` mode, Plaid Link shows fake test institutions. Search for any
name (e.g. "Chase") and log in with:
- username: `user_good`
- password: `pass_good`

## 5. Deploy

```bash
vercel deploy --prod
```

Vercel gives you a free HTTPS domain automatically — no separate hosting step needed.

**One Plaid-specific step:** in the [Plaid Dashboard](https://dashboard.plaid.com), under Team Settings → API, add your deployed URL to the allowed redirect URIs (some bank logins use OAuth screens that redirect back to a registered domain).

## 6. Install on your phone

**iPhone (Safari):** open your deployed URL → Share icon → **Add to Home Screen**

**Android (Chrome):** open your deployed URL → ⋮ menu → **Install app**

---

## Security notes

### Password gate

Deploying to Vercel gives the app a public HTTPS URL — anyone who found it
could otherwise view your balances or link their own account into your
Redis store. Every route (except `/login` and the PWA assets needed for install)
is now gated by `middleware.ts`, which checks a signed, expiring session
cookie. Logging in at `/login` sets that cookie for 30 days.

This is a single shared password, not per-user accounts — appropriate for
one person's personal tracker, not for sharing with others. If you want
real multi-user auth later, swap this for something like NextAuth/Auth.js
or Clerk rather than extending the password system.

### Token encryption

Each Plaid access token is encrypted (AES-256-GCM) with `PLAID_ENCRYPTION_KEY`
before being written to Redis — see `lib/crypto.ts`. That key lives only in
your env vars, never in Redis itself, so a database-only leak doesn't expose
usable tokens.

**Keep `PLAID_ENCRYPTION_KEY` and `SESSION_SECRET` safe** — losing the
encryption key makes previously stored tokens permanently undecryptable
(you'd need to reconnect all accounts); losing/leaking the session secret
would let someone forge a valid login cookie.

### What's still not covered

- **No rate limiting** on the API routes or the login endpoint — someone
  who discovers the URL could brute-force `APP_PASSWORD` given enough
  attempts. Fine for a personal app behind a real password; add rate
  limiting (e.g. Vercel's built-in Attack Challenge Mode, or a small
  Upstash-backed limiter) before treating this as hardened.
- **Single household password**, not per-device or per-person sessions —
  anyone with the password gets full access, including the ability to
  disconnect your accounts.

## What changed in this revision

An earlier version of this app had no auth at all (fine for `localhost`,
not fine once deployed publicly), fetched every linked institution's
balances one at a time, had no way to recover from an expired bank login,
and stored items in a single JSON blob with a read-then-write race between
concurrent link flows. This revision fixes all four:

- **Auth**: `middleware.ts` + `lib/auth.ts` + `/login` — see above.
- **Parallel fetching**: `app/api/net-worth/route.ts` now fetches all
  institutions concurrently (`Promise.all`) instead of in a sequential loop.
- **Reconnect flow**: institutions Plaid flags as `ITEM_LOGIN_REQUIRED` now
  show a "Reconnect" button that opens Plaid Link in update mode
  (`app/api/create-update-link-token`), fixing the connection without
  creating a duplicate Item.
- **Disconnect**: each institution card has a "Disconnect" button
  (`app/api/disconnect`) that revokes the token with Plaid and removes it
  from Redis.
- **Atomic storage**: `lib/storage.ts` now uses Redis hash operations
  (`HSET`/`HDEL`/`HGETALL`) keyed by `item_id` instead of a single
  read-modify-write JSON array, removing the race condition.
- **Duplicate-link warning**: linking an institution you've already
  connected now prompts for confirmation instead of silently creating a
  second entry that double-counts balances.
- **Loading states**: Connect/Refresh buttons now show progress and disable
  themselves mid-request instead of appearing unresponsive.

### Known limitations (not yet fixed)

- No rate limiting (see Security notes above).
- No automated tests.
- PWA offline mode shows the app shell but not last-known balances — data
  is always fetched live from `/api/*`, which is intentionally never
  cached.
- I wasn't able to run `bun install && bun run build` in the environment
  that generated this code (no network access to Bun's install servers),
  so everything here has been syntax-checked but not build-verified. Run a
  real build before deploying with live financial credentials.

### Third-pass fixes

- The service worker cached every non-API request unconditionally: `cache.put()` throws on non-GET requests (an unhandled rejection waiting for the first POST to a page route), and failed/error responses could get cached and later served offline. Now only successful GETs are cached.
- The session cookie was hard-coded `secure: true`, which Safari rejects over `http://localhost` — logging in during local dev would silently fail on Safari. Now Secure only in production (Vercel is always HTTPS).
- Every page load made two sequential round trips (`/api/status`, then `/api/net-worth`) when the second response already contains everything the first one answered. The status check and its route are removed; initial load is one request.

### Second-pass fixes (independent review)

A closer re-read caught four smaller issues, now fixed:
- `verifyPassword` hashed neither side before comparing, so it leaked the real password's length via timing on a mismatch. Now hashes both sides (SHA-256) first, so the comparison is always fixed-length.
- The middleware's auth-exclusion list matched by prefix (`login`, `api/login`), which would have silently let any future route starting with those strings (e.g. a hypothetical `/login-history`) bypass auth. Now anchored to exact paths.
- Disconnecting your *last* linked institution left the UI's `connected` flag stuck on `true` instead of reverting to the initial empty state. `loadNetWorth` now derives `connected` from the actual data every time.
- The README overstated that "the app runs on Bun" — true for the API routes, but Next.js middleware (the auth gate) always runs on Vercel's Edge runtime regardless. Corrected above.

## About the encryption

See "Token encryption" above.

## Extending this

- Add a chart of net worth over time (store daily snapshots in Redis)
- Add cost basis / gain-loss columns (Plaid returns `cost_basis` per holding)
- Add rate limiting on `/api/login`
