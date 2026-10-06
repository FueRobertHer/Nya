# Deployment

Nya runs on Vercel, with Upstash Redis for storage and Plaid for bank data. Bun is the runtime (`vercel.json` sets `bunVersion`).

- [1. Get Plaid API keys](#1-get-plaid-api-keys)
- [2. Create a Vercel project and Redis database](#2-create-a-vercel-project-and-redis-database)
- [3. Environment variables](#3-environment-variables)
- [4. Scheduled jobs](#4-scheduled-jobs)
- [5. Local development](#5-local-development)
- [6. Deploy](#6-deploy)
- [7. Install on your phone](#7-install-on-your-phone)
- [Security headers and the Content-Security-Policy](#security-headers-and-the-content-security-policy)
- [Preview deployments](#preview-deployments)

## 1. Get Plaid API keys

1. Sign up free at <https://dashboard.plaid.com/signup>.
2. Go to **Team Settings > Keys** and copy your `client_id` and `sandbox` secret.

## 2. Create a Vercel project and Redis database

1. Push this repo to GitHub.
2. In the [Vercel dashboard](https://vercel.com), import the repo as a new project.
3. Open the project's **Storage** tab, choose **Create Database**, pick **Upstash for Redis** (the Marketplace successor to the retired Vercel KV), and connect it to the project. This adds `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to the project's environment variables. A store that was auto-migrated from Vercel KV uses the legacy `KV_REST_API_URL` and `KV_REST_API_TOKEN` names instead; the app supports both.
4. Add the environment variables in the next section under **Settings > Environment Variables**.

> **`Upstash Redis client was passed an invalid URL ... Received: "rediss://..."`:** `vercel env pull` sometimes writes a `rediss://...:6379` connection string into `UPSTASH_REDIS_REST_URL`, but the client needs the HTTPS **REST** endpoint (`https://<name>.upstash.io`). The app derives the REST URL from the host (`lib/storage.ts`), so a restart is enough. To fix the variable itself, set it to the `https://...` value, which Vercel exposes as `<db-name>_KV_REST_API_URL` (or the legacy `KV_REST_API_URL`).

## 3. Environment variables

Generate every secret or key with `openssl rand -base64 32`. [`.env.example`](../.env.example) lists them all with comments.

| Variable | Needed | Purpose |
| --- | --- | --- |
| `PLAID_CLIENT_ID`, `PLAID_SECRET` | yes | Plaid credentials. |
| `PLAID_ENV` | yes | `sandbox` to start; `production` for real banks. |
| `PLAID_ENCRYPTION_KEY` | yes | Encrypts Plaid access tokens and any data written before data keys existed. See [operations.md](operations.md#encryption-keys). |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | yes | Set by the Upstash integration. |
| `APP_PASSWORD` | yes, without Clerk | The password you open the app with. |
| `SESSION_SECRET` | yes, without Clerk | Signs session cookies. |
| `CRON_SECRET` | yes | Authenticates the crons; Vercel sends it automatically. |
| `MASTER_KEY` | recommended | Envelope encryption master key. Save it in a password manager first. |
| `INGEST_SECRET` | optional | Authenticates scripted balance pushes to manual accounts. Unset keeps `/api/ingest/balance` closed. |
| `OPS_SECRET`, `OPS_ENABLED` | optional | Backups and other operations, only while you run one. |
| `BLOB_READ_WRITE_TOKEN` | optional | Set for you when a private Blob store is connected; turns on nightly backups. |
| `BACKUP_KEEP_DAYS` | optional | Days of backups to keep (default 30). The public Security and Privacy pages state 30, so change them with it. |
| `PLAID_WEBHOOK_URL` | optional | Public URL of `/api/plaid/webhook`. See [features.md](features.md#keeping-plaid-costs-down). |
| `PLAID_UNUSED_DAYS` | optional | Days before an unused connection is flagged (default 60, minimum 14). |
| `MAX_TXN_BLOB_CHARS` | optional | Ceiling on one institution's stored transactions (default 8,388,608 characters). See [architecture.md](architecture.md#storage-and-encryption). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_ALLOWED_USER_IDS` | optional | Sign in with Clerk instead of the shared password. See [authentication.md](authentication.md). |
| `CSP_MODE` | optional | How pages send their Content-Security-Policy: `report-only` (the default), `enforce` or `off`. See [Security headers](#security-headers-and-the-content-security-policy). |
| `CONTAINER_ID` | optional | Which container this deployment serves. See [operations.md](operations.md#containers). |
| `REDIS_PREFIX` | optional | Overrides the key namespace (defaults to the Vercel environment name, or `dev` locally). |
| `DEMO_USER_IDS` | optional | Preview only: one-click demo accounts. |

## 4. Scheduled jobs

Defined in `vercel.json`. Crons run only on the production deployment.

| Time (UTC) | Route | Job |
| --- | --- | --- |
| 13:00 | `/api/snapshot` | Records each container's daily net-worth snapshot. |
| 15:00 | `/api/snapshot/catchup` | Runs again for any container that failed, came back unclean, was deferred, or had nothing linked. |
| 16:00 | `/api/backup` | Nightly off-site backup. |
| 17:00 | `/api/plaid/check-items` | Flags connections that cost money and do nothing. |

## 5. Local development

```bash
bun install
vercel link                  # connects this folder to the Vercel project
vercel env pull .env.local   # pulls Redis credentials and your other variables
bun run dev
```

Open <http://localhost:3000>; you are redirected to `/login` first. Logging in with the shared password needs a container to exist; see [operations.md](operations.md#containers) for creating one and setting `CONTAINER_ID` in `.env.local`.

Two checks worth running before you push:

```bash
bun run typecheck && bun run test
```

The tests need no Plaid keys and no network: storage and the Plaid client are faked. A few tests exercise the Lua scripts against a real Redis; they are skipped locally when none is available and fail under CI rather than pass unseen (CI installs one).

Next.js is pinned to a canary build (see `package.json`) and `next.config.js` enables `experimental.useTypeScriptCli`, so `next build` and `next dev` use the local native `tsc` (TypeScript 7). `proxy.ts` is the auth gate (Next's renamed middleware convention); `lib/auth.ts` uses the Web Crypto API so the same code runs in the proxy, Bun and Node.

## 6. Deploy

```bash
vercel deploy --prod
```

Vercel gives you a free HTTPS domain automatically.

**One Plaid-specific step:** in the [Plaid Dashboard](https://dashboard.plaid.com), under Team Settings > API, add your deployed URL to the allowed redirect URIs. Some bank logins use OAuth screens that redirect back to a registered domain.

## 7. Install on your phone

**iPhone (Safari):** open your deployed URL, tap the Share icon, then **Add to Home Screen**.

**Android (Chrome):** open your deployed URL, open the menu, then **Install app**.

## Security headers and the Content-Security-Policy

Every response carries the same security headers, set in `next.config.js` so they also reach static files and the routes `proxy.ts` never sees: `Strict-Transport-Security` (two years, subdomains included, not preloaded), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that turns off device features the app never uses, `X-Frame-Options: DENY` with a `Content-Security-Policy` of `frame-ancestors 'none'`, and `Cross-Origin-Opener-Policy: same-origin-allow-popups` (not `same-origin`, which would cut a bank's sign-in pop-up off from Plaid Link). HSTS covers subdomains of the host Nya is served from: on `*.vercel.app` or a subdomain such as `nya.example.com` that is nothing else, but served at a bare domain it would require HTTPS on every subdomain of it.

Every page also gets a full Content-Security-Policy, built per request in `proxy.ts` (`lib/security-headers.ts`, which says where each host in it comes from). Scripts run only with that request's nonce, or when loaded by one that has it (`'strict-dynamic'`); that is how Plaid Link's script, Clerk's scripts and Cloudflare's bot check arrive. Every page already renders per request (the root layout awaits `connection()`), so the nonce costs no static rendering. `CSP_MODE` says how it is sent:

| `CSP_MODE` | Header | Effect |
| --- | --- | --- |
| unset or `report-only` | `Content-Security-Policy-Report-Only` | The browser logs in its console what the policy would block, and blocks nothing. |
| `enforce` | `Content-Security-Policy` | The browser blocks it. |
| `off` | none | No page policy. Framing stays forbidden by the headers above. |

Any other value counts as `report-only` and is logged once per instance, so a typo can never enforce by accident. The Security page (`/security`) says which mode the deployment is in.

### Checking it with a live session, then enforcing it

Plaid Link and Clerk load scripts, frames and connections that only a live session shows, so the policy ships in report-only mode. Check it once on a deployment that uses both, before enforcing it:

1. Deploy with `CSP_MODE` unset, Clerk keys set, and the Plaid environment you will run. Preview with `sandbox` first, then Production.
2. Open the deployment in Chrome in a window without extensions (a guest profile, or Incognito with extensions off), open DevTools on the **Console** tab, and tick **Preserve log**, so messages survive the redirects of signing in.
3. In the **Network** tab, click the request for the page itself and check its response headers include `content-security-policy-report-only` with a `'nonce-...'` and `'strict-dynamic'`.
4. Go through every flow:
   - sign out, open `/sign-in` and sign in with each method turned on in Clerk, including any bot check it shows;
   - open the account menu, **Manage account**, each page of the account window (Data & privacy included), then sign out from it;
   - **Connect an account** and finish Plaid Link with an ordinary institution (in sandbox: any, with `user_good` / `pass_good`) and with one that signs in on the bank's own site in a pop-up (in sandbox: Platypus OAuth Bank);
   - **Reconnect** and **Add or remove accounts** on a connected institution;
   - the Activity tab (merchant logos and category icons) and the Budgets tab;
   - the **Application** tab: the service worker is registered.
5. Read the console. Each violation is a line starting `[Report Only] Refused to load ...` (or `... to connect to`, `... to frame`) naming the URL and the directive. A clean pass has none. For each one from Plaid, Clerk or the app itself, add its host to the matching directive in `lib/security-headers.ts`, saying where it comes from, deploy, and go through the flows again.
6. When a pass is clean on Production too, set `CSP_MODE=enforce` on Production and Preview and redeploy. Check the page's response header is now `content-security-policy`, and go through the flows once more: anything missed now fails (Link doesn't open, sign-in stalls) with a `Refused to ...` error in the console.
7. If anything breaks after that, set `CSP_MODE=report-only` (or `off`) and redeploy. Nothing else changes.

There is no reporting endpoint: violations go only to the console of the browser that met them.

## Preview deployments

Every branch you push gets a stable URL, `https://nya-git-<branch>-<team-slug>.vercel.app`, which repoints to that branch's newest deployment on every push (slashes in a branch name become dashes). Each individual build also keeps an immutable `https://nya-<hash>-<team-slug>.vercel.app` that never moves, which is what to send someone when you mean one exact version.

This repo keeps a long-lived `preview` branch so that URL is predictable instead of changing with every feature branch. Anything on `main` lands there on its own: [`.github/workflows/sync-preview.yml`](../.github/workflows/sync-preview.yml) merges `main` into `preview` on every push to `main`, which also triggers the deployment. It merges rather than resets, so the preview-only commits below survive, and on a conflict it aborts and fails the run, leaving `preview` untouched for you to resolve by hand.

To see a branch that has *not* merged yet, merge it into `preview` yourself:

```bash
git checkout preview
git merge your-feature-branch
git push
```

Treat `preview` as a throwaway integration target, never a merge source: real work reaches `main` by pull request. If it tangles, `git reset --hard origin/main && git push --force-with-lease` starts it over, at the cost of the login button described below.

A `?_vercel_share=` query parameter on the URL carries visitors through Deployment Protection without a Vercel account. It is a credential, so rotate it under **Settings > Deployment Protection** if the link travels further than intended.

### What preview runs against

Preview is a public demo, so nothing about it is shared with production:

- **Its own Upstash database**, connected to **Preview** only (Storage, Create Database, then pick the Preview scope). The integration attaches its connection variables to every environment by default, so this has to be set deliberately, otherwise preview reads production's data.
- **Its own `APP_PASSWORD`, `SESSION_SECRET` and `PLAID_ENCRYPTION_KEY`**, added under Settings > Environment Variables with the **Preview** box ticked. The encryption key must match whatever encrypted the tokens in the database it reads (`lib/crypto.ts`), so a fresh database takes a fresh key. If you use a `MASTER_KEY`, give Preview its own or scope yours to Production only.
- **`PLAID_ENV=sandbox`**, so linked accounts are Plaid's fake ones.
- **Its own container**: create it as described in [operations.md](operations.md#containers), in the preview environment.

Nothing here is inherited from production. A preview with no variables set builds fine and then fails at runtime.

### Demo access

Two mechanisms let visitors in without credentials, both on Preview only:

- **Demo accounts (Clerk).** One-click buttons on the sign-in page, on Plaid's sandbox. See [authentication.md](authentication.md#demo-accounts-preview-only).
- **The preview login button.** The `preview` branch carries a **Use preview account** button on the shared-password login page that signs visitors in without a password. It posts `previewLogin` to `/api/login`, which mints a session only when `VERCEL_ENV` is not `production`; a production deployment refuses with a 403 and never renders the button. That commit lives on `preview` only and is deliberately not merged to `main`. It is only safe while preview has its own database.

### Gotchas

- Deploys fire on a push of a *new commit*. A branch pointing at a commit that has already been deployed will not rebuild; use **Redeploy** in the dashboard to force one.
- If no preview builds at all, check **Settings > Git > Deployment Branches**. It has to be "All Branches", or a pattern that matches the branch.
- The crons only run on production deployments. Call a route by hand with `CRON_SECRET` as a bearer token to exercise it on a preview.
- If you use Plaid's OAuth bank logins, add the preview URL to the allowed redirect URIs alongside the production one.
