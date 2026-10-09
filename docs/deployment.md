# Deployment

Nya runs on Vercel, with Upstash Redis for storage and Plaid for bank data. Bun is the runtime (`vercel.json` sets `bunVersion`).

- [1. Get Plaid API keys](#1-get-plaid-api-keys)
- [2. Create a Vercel project and Redis database](#2-create-a-vercel-project-and-redis-database)
- [3. Environment variables](#3-environment-variables)
- [4. Scheduled jobs](#4-scheduled-jobs)
- [5. Local development](#5-local-development)
- [6. Deploy](#6-deploy)
- [7. Install on your phone](#7-install-on-your-phone)
- [Email notices](#email-notices)
- [Brokerage and retirement connections](#brokerage-and-retirement-connections)
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
| `BACKUP_KEEP_DAYS` | optional | Days of backups to keep (default 30). The deletion receipt and the public Security and Privacy pages read it (and whether a Blob store is connected), so what they say follows it. |
| `PLAID_WEBHOOK_URL` | optional | Public URL of `/api/plaid/webhook`. See [features.md](features.md#keeping-plaid-costs-down). |
| `PLAID_UNUSED_DAYS` | optional | Days before an unused connection is flagged (default 60, minimum 14). |
| `PLAID_BROKERAGE_LINK` | optional | `1` offers **Connect a brokerage or retirement account** beside the bank option. Off by default, and turned on only after this release has run for a while. See [Brokerage and retirement connections](#brokerage-and-retirement-connections). |
| `MAX_TXN_BLOB_CHARS` | optional | Ceiling on one institution's stored transactions (default 8,388,608 characters). See [architecture.md](architecture.md#storage-and-encryption). |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_ALLOWED_USER_IDS` | optional | Sign in with Clerk instead of the shared password. See [authentication.md](authentication.md). |
| `CSP_MODE` | optional | How pages send their Content-Security-Policy: `report-only` (the default), `enforce` or `off`. See [Security headers](#security-headers-and-the-content-security-policy). |
| `CONTAINER_ID` | optional | Which container this deployment serves. See [operations.md](operations.md#containers). |
| `REDIS_PREFIX` | optional | Overrides the key namespace (defaults to the Vercel environment name, or `dev` locally). |
| `DEMO_USER_IDS` | optional | Preview only: one-click demo accounts. |
| `RESEND_API_KEY`, `MAIL_FROM` | optional | Email notices about bank connections that need you, sent through Resend. Both set turns them on; without them nothing is sent and the log says so once. See [Email notices](#email-notices). |
| `NOTIFY_EMAIL` | optional | With the shared password, where those notices go (one address, or a few separated by commas). Without it nothing is sent, and `/privacy` and `/security` name no email service. Ignored with Clerk, where each account's notices go to its own verified address. |
| `APP_URL` | optional | The app's public `https` address, for the link in a notice email (`http://localhost:3000` works locally). Unset, the email says to open Nya without a link. |

## 4. Scheduled jobs

Defined in `vercel.json`. Crons run only on the production deployment.

| Time (UTC) | Route | Job |
| --- | --- | --- |
| 13:00 | `/api/snapshot` | Records each container's daily net-worth snapshot, and sends the [email notices](#email-notices) about its connections. |
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

## Email notices

When a bank connection needs you (a sign-in to redo, a connection to remove and make again, Plaid's warning that it will end, or an outage that has lasted three days), the daily snapshot emails once, again only if what it needs changes, and once more a week later if it still needs you. How that is decided is in [features.md](features.md#email-notices). Email goes through [Resend](https://resend.com)'s HTTP API, with no SDK (`lib/mail.ts`).

1. Create a Resend account and verify the domain you will send from (Resend's Domains page lists the DNS records to add).
2. Create an API key with sending access only, and set it as `RESEND_API_KEY` (mark it Sensitive in Vercel).
3. Set `MAIL_FROM` to an address on that domain, on its own or with a name: `Nya <alerts@example.com>`.
4. Set `APP_URL` to the app's public address, so each email links straight to the Connection health card.
5. With the shared password, set `NOTIFY_EMAIL` to the address to tell. With Clerk, nothing to set: each account's notices go to its primary email address once Clerk has verified it, and to nobody else. Preview's demo accounts are never emailed.

The notices come from the daily snapshot, and crons run only on the production deployment ([Scheduled jobs](#4-scheduled-jobs)), so only production sends them. The record of what was sent is in the backups, so a restored copy doesn't send those again.

An email names the institution and what to do, and for a connection about to end, the day it ends as a UTC date, which is why it says "around". It never carries a balance, an amount or an account number. A send that fails is logged with Resend's status (never the message or the address) and tried again by the next run, at most one email per container per run; one that has nobody to go to is logged as that. Without `RESEND_API_KEY` and `MAIL_FROM`, nothing is sent and the Connection health card on the Accounts tab is the only place a broken connection shows.

The emails go once every container's snapshot has run, so they never use the snapshots' time. They have 30 seconds in all, ending at the latest 285 seconds into the run (inside its 300-second limit), and each is started only if finding the recipient (3 seconds at most) and the send (4 seconds at most) can both end in time. They go one at a time, at most two a second (Resend's default rate limit); a 429 is waited out once when Resend asks for 2 seconds or less. What doesn't fit, and everything after Resend itself fails (no answer, a 5xx, still rate limited), waits for the next run, unmarked: the catch-up two hours later for an account whose snapshot came back unclean, which a broken connection's does, otherwise the next day.

**What the log tells you.** Problems on Nya's side are never emailed to anyone, so the log is where they show: each run lists the connections that fail for a reason on Nya's side, with Plaid's codes (`Connection notices: N connection(s) in M container(s) fail for a reason on Nya's side (INVALID_ACCESS_TOKEN (12))`). `INVALID_ACCESS_TOKEN` across every connection means `PLAID_ENV`, `PLAID_CLIENT_ID` or `PLAID_SECRET` is not the set the connections were made with, a Preview value on Production, say; `INVALID_API_KEYS`, that the client id and secret don't match. Put the settings back and the connections work as before: don't remove them, which would delete their stored transactions and leave them live, and billed, at Plaid. When emails about a cause on Plaid's side or one Nya can't place first become due on the same run in three or more containers with the same Plaid code, the run holds them back and says so, with the code and the day they go (`... those 3 email(s) are held back until October 7 (UTC), and go with that day's run if the problem is still there`); each later run says what is still held. Fix the setup in those three days and the breaks end with nothing sent; otherwise each email goes once, and is never held again. Holds are recorded within the run's mail deadline, a few at a time: one left unrecorded only means that email isn't held, and it goes with the next run. An email about a sign-in or a bank's own problem is never held.

## Brokerage and retirement connections

**Connect a brokerage or retirement account** reaches 401(k) and IRA recordkeepers that the bank option can't list, since those offer Investments but not Transactions ([features.md](features.md#connecting-accounts)). Connections made with it have no Transactions, and the app decides alone whether one ever gets it: a first call for a connection's transactions starts Plaid's Transactions product, billed monthly until the connection is removed, so the transactions sync makes that call only for a connection holding a bank account or a card ([Keeping Plaid costs down](features.md#keeping-plaid-costs-down)).

A release from before this one has no such check, and calls for every connection's transactions on every load. So the option ships turned off, and the release that checks runs for a while before any connection without Transactions exists:

1. Deploy with `PLAID_BROKERAGE_LINK` unset. Only **Connect a bank or card** shows, and the route refuses a brokerage link token.
2. Leave it a week or so, through the daily snapshots. Connect one bank in that time, and check in the Upstash console that its record in `<prefix>:c:<id>:plaid:items` carries `"transactions_billed":true`: the link recorded what Plaid bills.
3. On a Preview deployment with `PLAID_ENV=sandbox`, set `PLAID_BROKERAGE_LINK=1`, connect a Sandbox brokerage with the new option, and check what nothing in Plaid's reference states: that update mode takes `additional_consented_products`, which **Allow transactions** relies on (a connection's card offers it once its first transactions call answered `ADDITIONAL_CONSENT_REQUIRED`). Signed in, run this in the browser console with the connection's id (its `item_id` in the `/api/net-worth` response):

   ```js
   await (await fetch('/api/create-update-link-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_id: '<item_id>', allow_transactions: true }) })).json()
   ```

   It must answer with a `link_token`, and the function log must not show an error just before it: that would be Plaid refusing the field, and the button falling back to a plain update that asks for nothing. Where a card does offer **Allow transactions**, press it too: Link must ask for consent to transactions, and the next load brings them in. Until this holds, keep the option off in Production.
4. Set `PLAID_BROKERAGE_LINK=1` on Production and redeploy. Any other value counts as off.
5. Connect a real 401(k) or IRA, and a brokerage account, with the new option. Each one's record should carry `"transactions_billed":false`: Plaid isn't billing Transactions on it. Its card on the Accounts tab shows its holdings and no error, and nothing on the Activity tab names it as failing.

From then on, never roll back to a release from before this one: see [operations.md](operations.md#rolling-back-once-the-brokerage-option-is-on). Turning the option off again hides the button and refuses new brokerage link tokens; connections already made with it keep working.

## Security headers and the Content-Security-Policy

Every response carries the same security headers, set in `next.config.js` so they also reach static files and the routes `proxy.ts` never sees: `Strict-Transport-Security` (two years, subdomains included, not preloaded), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that turns off device features the app never uses, `X-Frame-Options: DENY`, and `Cross-Origin-Opener-Policy: same-origin-allow-popups` (not `same-origin`, which would cut a bank's sign-in pop-up off from Plaid Link). HSTS covers subdomains of the host Nya is served from: on `*.vercel.app` or a subdomain such as `nya.example.com` that is nothing else, but served at a bare domain it would require HTTPS on every subdomain of it.

Every page also gets a Content-Security-Policy, built per request in `proxy.ts` (`lib/security-headers.ts`, which says where each host in it comes from). Scripts run only with that request's nonce, or when loaded by one that has it (`'strict-dynamic'`); that is how Plaid Link's script, Clerk's scripts and Cloudflare's bot check arrive. Every page already renders per request (the root layout awaits `connection()`), so the nonce costs no static rendering. A browser sent to an `/api/` path that doesn't exist is shown the HTML 404 page, so any request that asks for HTML gets the policy; API calls answered with JSON get none.

It is the only Content-Security-Policy the app sends. A browser enforces every policy it is sent, and how Vercel combines a header from `next.config.js` with one of the same name from the proxy is not documented, so `next.config.js` sends none: framing is forbidden on every response by `X-Frame-Options`, and the enforced page policy says `frame-ancestors 'none'` as well. The report-only policy leaves `frame-ancestors` out, since browsers ignore it there and Chrome logs an error for it on every page.

`CSP_MODE` says how it is sent:

| `CSP_MODE` | Header | Effect |
| --- | --- | --- |
| unset or `report-only` | `Content-Security-Policy-Report-Only` | The browser logs in its console what the policy would block, and blocks nothing. |
| `enforce` | `Content-Security-Policy` | The browser blocks it. |
| `off` | none | No page policy. Framing stays forbidden by `X-Frame-Options`. |

Any other value counts as `report-only` and is logged once per instance, so a typo can never enforce by accident. The Security page (`/security`) says which mode the deployment is in.

### Checking it with a live session, then enforcing it

Plaid Link and Clerk load scripts, frames and connections that only a live session shows, so the policy ships in report-only mode. Check it once on a deployment that uses both, before enforcing it:

1. Deploy with `CSP_MODE` unset, Clerk keys set, and the Plaid environment you will run. Preview with `sandbox` first, then Production.
2. Open the deployment in Chrome in a window without extensions (a guest profile, or Incognito with extensions off), open DevTools on the **Console** tab, and tick **Preserve log**, so messages survive the redirects of signing in.
3. In the **Network** tab, click the request for the page itself and check its response headers include `content-security-policy-report-only` with a `'nonce-...'` and `'strict-dynamic'`.
4. Go through every flow:
   - sign out, open `/sign-in` and sign in with each method turned on in Clerk, including any bot check it shows, and on Preview with a demo button too;
   - open the account menu, **Manage account**, each page of the account window (Data & privacy included), then sign out from it;
   - **Connect a bank or card** and finish Plaid Link with an ordinary institution (in sandbox: any, with `user_good` / `pass_good`) and with one that signs in on the bank's own site in a pop-up (in sandbox: Platypus OAuth Bank), then, with `PLAID_BROKERAGE_LINK=1`, **Connect a brokerage or retirement account** once too;
   - **Reconnect** and **Add or remove accounts** on a connected institution;
   - the Activity tab (merchant logos and category icons) and the Budgets tab;
   - the **Application** tab: the service worker is registered.
5. Read the console. Each violation is a line starting `[Report Only] Refused to load ...` (or `... to connect to`, `... to frame`) naming the URL and the directive. A clean pass has none. For each one from Plaid, Clerk or the app itself, add its host to the matching directive in `lib/security-headers.ts`, saying where it comes from, deploy, and go through the flows again.

   On Preview, the Vercel Toolbar (`vercel.live`) adds its own script and frame to the page, and its lines in the console are not the app's. Turn the toolbar off for the check (in the project's settings, or for your session from the toolbar's own menu), or skip the lines that name `vercel.live`. Never add it to the policy: Production shares it. Once Preview enforces the policy, the toolbar no longer loads there.
6. Do the same pass on an iPhone, the app's main platform: in Safari, and in the app installed to the Home Screen. Turn on Web Inspector on the phone (Settings, Safari, Advanced), connect it to a Mac, and open the page from Safari's Develop menu there; its console shows report-only violations too. Sign in, connect the pop-up bank, and open each tab.
7. When a pass is clean on Production too, set `CSP_MODE=enforce` on Production and Preview and redeploy. In the page's response headers, check that `content-security-policy` is there and that it contains `'nonce-` and `'strict-dynamic'`: that is the policy that protects the scripts, and the Security page should now say this copy enforces it. There should be exactly one `content-security-policy` header. If something in front of the app adds a second, the browser enforces both, so check the second only narrows what the first allows. Then go through the flows once more, on both platforms: anything missed now fails (Link doesn't open, sign-in stalls) with a `Refused to ...` error in the console.
8. If anything breaks after that, set `CSP_MODE=report-only` (or `off`) and redeploy. Nothing else changes.

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
