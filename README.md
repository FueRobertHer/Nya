# Nya

<img src="public\icons\icon-512.png" width="100"/>

A Next.js + React app that connects to your financial accounts — banks
(Ally, Chase), brokerages (Vanguard), credit cards, etc. — via
Plaid. Runs on Bun, deploys to Vercel, installs on your phone as a PWA.

**[Try the live demo](https://nya-git-preview-fueroberthers-projects.vercel.app/?_vercel_share=hsOPuA6Qvofd4jxnrQVjuqXhPVkNqykh)** and press **Use preview account** on the
login screen. It runs against Plaid's sandbox on its own database, so every
account and balance you see there is fake. See
[Preview deployments](#preview-deployments) for how it is wired.

Four tabs (bottom navigation, mobile-first):

- **Home** — net worth with a 30-day delta and an over-time chart (daily
  snapshots + estimated backfill, scrubbable), plus insights and alerts:
  over/approaching budget, low balance, uninvested cash sitting in a brokerage,
  upcoming recurring bills, spending pace vs last month, biggest purchase.
- **Accounts** — per-institution balance sheet; tap any account for its own
  balance history chart; holdings show gain/loss vs cost basis. Money that is
  not actually invested (a settlement fund like Vanguard's VMFXX, a sweep
  account, a plain cash line) is marked on the holding, totalled on the
  Holdings header, and flagged in amber under the account row once it is large
  enough to be worth placing rather than ordinary settlement float; accounts
  that are cash by design, such as a cash management or money market account,
  are left alone. Credit cards and loans carry their real terms — APR, minimum
  payment, and next due date, with statement balance, last payment, escrow and
  payoff date in the expanded row (see "Payment details" below). Investment
  accounts expand to show the last year of activity (buys, sells, dividends,
  fees) and how much has been contributed year to date. Rollovers are counted
  separately from contributions, since a 401k moved into an IRA is existing
  retirement money arriving, not money saved this year. Any account can be
  **hidden**: it keeps syncing but stops counting toward anything (see "Hiding
  accounts" below). Institutions Plaid can't reach can be tracked as **manual
  accounts**: you type the balance, and it counts toward net worth and builds
  its own history like any linked account (see "Manual accounts" below).
- **Activity** — twelve months of transactions with a monthly breakdown:
  spending-by-month trend columns, money in/out/net, top spending
  categories, and search. Each row shows the merchant's logo, and amounts
  render in their own currency. Tap any transaction to recategorize it or
  rename its vendor — a rename applies to every transaction from that merchant
  (keyed on Plaid's merchant id, falling back to institution + name). Both are
  manual overrides that win over Plaid's data and persist. Transfers and loan
  payments are excluded from the totals so credit-card payments don't
  double-count, and a pending charge is de-duplicated against its posted
  version so a purchase isn't counted twice.
- **Budgets** — Mint-style monthly budgets per spending category with
  severity meters (on track → approaching → over); savings goals tracked
  against a linked account's live balance; and recurring-bill detection
  (merchants charging a consistent amount for 3+ months) with estimated next
  charge dates and a monthly total. All stored encrypted in Redis.

Amounts are shown in each transaction's own currency; summed figures (month
totals, budgets, recurring bills) use your most common currency and flag when
a period mixes currencies — full FX conversion isn't done, and account-level
figures (net worth, balances, goals) are still shown in `$`.

A refresh button in the header forces live Plaid data from any tab.

Plaid access tokens are encrypted (AES-256-GCM) before being stored in Upstash
Redis (via the Vercel Marketplace), and the whole app sits behind a password
(see "Security notes" below for why, and what's still not covered).

## Screenshots

_Captured in Plaid `sandbox` mode, so the balances and transactions are test
data. Anything named "Plaid ..." is a sandbox fixture; HealthEquity and Alliant
Credit Union are manual accounts added by hand. The budget meters read $0.00
because the capture was taken on the 2nd of the month, before anything had
posted against them._

The four tabs:

<table>
  <tr>
    <td align="center"><b>Home</b></td>
    <td align="center"><b>Accounts</b></td>
    <td align="center"><b>Activity</b></td>
    <td align="center"><b>Budgets</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/home.png" alt="Home tab: net worth, 30-day delta, over-time chart, and insights" width="210"></td>
    <td><img src="docs/screenshots/accounts.png" alt="Accounts tab: per-institution balance sheet, with a manual account carrying a Manual badge and a credit card showing utilization against its limit" width="210"></td>
    <td><img src="docs/screenshots/activity.png" alt="Activity tab: net-by-month trend columns, income vs spend chart, and month totals" width="210"></td>
    <td><img src="docs/screenshots/budgets.png" alt="Budgets tab: category budgets with severity meters, and savings goals tracked against account balances" width="210"></td>
  </tr>
</table>

Scrolling the Accounts tab: **Manage accounts** reveals the per-account
**Hide** action (plus Update and Delete on manual accounts, Disconnect on
linked institutions), hidden accounts collect in their own card at the bottom,
investment holdings expand with gain/loss against cost basis, and tapping any
account row opens that account's own balance history.

<table>
  <tr>
    <td align="center"><b>Manage accounts</b></td>
    <td align="center"><b>Hidden</b></td>
    <td align="center"><b>Holdings</b></td>
    <td align="center"><b>Per-account history</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/accounts-manage.png" alt="Manage mode: Update, Hide and Delete on a manual account, Disconnect on each linked institution, and Hide on every account row" width="210"></td>
    <td><img src="docs/screenshots/accounts-hidden.png" alt="The collapsed Hidden card, expanded to show a hidden 401k with an Unhide button" width="210"></td>
    <td><img src="docs/screenshots/accounts-holdings.png" alt="Expanded holdings table showing quantity, value, and gain or loss against cost basis per security" width="210"></td>
    <td><img src="docs/screenshots/accounts-history.png" alt="An account row expanded to show that account's own balance history chart" width="210"></td>
  </tr>
</table>

Scrolling Activity gives the transaction list, grouped by day with a running
daily net on each date heading. Scrolling Budgets gives detected recurring
bills with their estimated next charge dates:

<table>
  <tr>
    <td align="center"><b>Transactions by day</b></td>
    <td align="center"><b>Recurring bills</b></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/activity-transactions.png" alt="Transaction list grouped by day with a per-day net summary" width="240"></td>
    <td><img src="docs/screenshots/budgets-recurring.png" alt="Recurring bills detected from repeating charges, each with its institution, streak length, and estimated next charge date" width="240"></td>
  </tr>
</table>

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
   - `CRON_SECRET` — generate with `openssl rand -base64 32`; authenticates
     the daily net-worth snapshot cron (Vercel sends it automatically)
   - `INGEST_SECRET` (optional), generate with `openssl rand -base64 32`;
     authenticates scripted balance pushes to manual accounts. Leave it unset
     to keep that endpoint closed.
   - `OPS_SECRET` and `OPS_ENABLED` (optional), for taking a backup. See
     [Backing up your data](#backing-up-your-data).

## 3. Local development

```bash
bun install
vercel link          # connects this folder to the Vercel project you just made
vercel env pull .env.local   # pulls down KV credentials + your other env vars
bun run dev
```

Open http://localhost:3000 — you'll be redirected to `/login` first.

Two checks worth running before you push:

```bash
bun run typecheck && bun run test
```

The tests need no Redis, no Plaid keys, and no network — storage and the Plaid
client are faked, so they run in well under a second.

> **If you hit `Upstash Redis client was passed an invalid URL … Received: "rediss://…"`:** `vercel env pull` sometimes writes a `rediss://…:6379` connection string into `UPSTASH_REDIS_REST_URL`, but the `@upstash/redis` client needs the HTTPS **REST** endpoint (`https://<name>.upstash.io`). The app now handles this automatically (it derives the REST URL from the host in `lib/storage.ts`), so a restart is enough. If you'd rather fix the env var itself, set `UPSTASH_REDIS_REST_URL` to the `https://…` value — Vercel exposes it as `<db-name>_KV_REST_API_URL` (or legacy `KV_REST_API_URL`).

> Bun is Vercel's officially supported runtime for the API routes (`vercel.json` sets `bunVersion`). One nuance worth knowing: `proxy.ts` (the auth gate — renamed from `middleware.ts` in Next 16) always runs on Vercel's **Edge runtime**, not Bun — that's a Next.js constraint, not a choice made here. It's why `lib/auth.ts` uses the Web Crypto API instead of Node's `crypto`/`Buffer`: that code needs to work on Edge. If a future Vercel CLI/Next.js version changes the Bun config shape, check https://vercel.com/docs/functions/runtimes/bun for the current syntax.

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

### Payment details

Credit cards and loans show what they actually cost: purchase APR, minimum
payment, and next due date on the account row, with statement balance, last
payment, accrued interest, escrow and payoff/maturity date when the row is
expanded. A payment coming due within a week, or one already overdue, also
surfaces as an alert on the Home tab.

This comes from Plaid's Liabilities product, which has to be enabled on an
institution before it will return anything. Newly connected institutions get it
automatically. Institutions you linked before this existed don't, so they show
an **Enable payment details** button on their card — tap it, log back in through
Plaid, and the terms appear.

That button goes through Link's *update mode*, which re-authenticates the
institution you already have rather than adding a second one: the item keeps its
id, and its stored transaction history survives. Not every institution supports
the product; where it isn't supported the button says so rather than failing
silently, and where there's simply nothing to report (no cards or loans) no
button appears at all.

### Hiding accounts

Some accounts you want synced but not counted: a joint account, a business
card, an old account kept linked for records. On the Accounts tab, tap **Manage
accounts** and then **Hide** on any account, linked or manual.

A hidden account keeps syncing and keeps being stored. It's left out of net
worth, the balance sheet, the Activity tab, budgets, insights, recurring-bill
detection, and the goal picker. Hidden accounts collect in a collapsed
**Hidden** card at the bottom of the Accounts tab, where **Unhide** restores
them.

Hiding is **retroactive**: the net-worth chart redraws as though the account was
never counted, rather than showing a cliff on the day you hid it. That works
because nothing is deleted. Snapshots keep recording the true total and every
account's balance, and hiding is applied when the chart is read, so unhiding
brings back the full history including the period while it was hidden.

Hiding is not a security feature: the data is still fetched and stored, it just
isn't shown or counted. To actually remove an account, disconnect it (Plaid) or
delete it (manual).

### When an institution can't be reached

Plaid connections fail: a bank has an outage, a login expires, an item needs
re-authenticating. When that happens Nya shows the institution's **last known
balances** with the date they were taken ("Could not fetch balances · balances
as of Aug 7") rather than a $0.00 card.

That's not cosmetic. Dropping a failed institution from the total silently
understates your debts as well as your assets, and a credit card falling out
makes net worth go *up*: a broken connection that reads as good news. Showing
the last real figures keeps the total honest while the connection is down.

Two stores back this. Balances come from the most recent daily snapshot, which
is only recorded on days when **every** institution answered. Alongside it, each
institution's account list is recorded every time **that** institution answers,
so a card you closed drops out on the next successful load rather than
lingering.

Those two have different conditions, so they drift, and an account can be in one
and not the other. When that happens the card can't show every row, and it says
so: *"2 accounts couldn't be shown, so this total is incomplete."* That matters
more than it sounds, because a missing row is usually a missing debt, and a
missing debt makes net worth look better than it is. Everything is scoped per
institution, so one bank's problems never affect another's recovery.

If the balances are older than **35 days** the card stops showing them and names
the date instead. An institution broken for months shouldn't quietly revert to
zero, and it shouldn't drag a months-old figure into today's total either.

Any institution that can't be reached and can't be recovered is called out under
the Home total, so a total that's missing a whole bank never looks complete.

Recovered balances are **display-only**. They're never written to the net-worth
history, and no snapshot is recorded on a day when any institution failed, so a
stale figure can never be mistaken for a measured one in the chart. The
consequence is a real gap: if a connection stays broken through the end of the
day, that day gets no point at all and nothing back-fills it later. That's
deliberate, because a fabricated flat line in the real history layer would be
permanent: nothing ever rewrites a past date.

An institution that needs re-authenticating keeps the red warning and its
**Reconnect** button, and only says the balances are dated. The softer amber
note is reserved for failures that usually clear on their own, so a dead
connection can't hide behind plausible-looking numbers.

### Manual accounts

Plaid's coverage is wide but uneven: small credit unions, HSAs, 401k
recordkeepers, foreign banks, and anything that isn't a financial institution
at all (property, crypto held off-exchange) may simply not be linkable. Those
get tracked by hand.

Click **Add a manual account** (on the Accounts tab, or on the empty state
before anything is connected), give it a name, an institution, a type, and a
balance. Accounts sharing an institution name group into one card. From then
on it behaves like a linked account: it counts toward net worth, appears in
the Accounts tab, is selectable as a savings-goal source, and gets its own
balance history chart.

The balance holds flat until you change it, and each update is recorded on
the timeline, so the chart shows a step at each update rather than a
pretend-smooth curve. Credit and loan balances are entered as the **amount
owed** (a positive number) and subtract from net worth.

Deleting a manual account is not reversible: re-adding it creates a new
account with a fresh id and an empty history.

#### Updating balances from a script

Retyping balances gets old. If you set `INGEST_SECRET`, anything that can make
an HTTP request can push balances into your manual accounts:

```bash
curl -X POST https://your-app.vercel.app/api/ingest/balance -H "Authorization: Bearer $INGEST_SECRET" -H 'Content-Type: application/json' -d '{"updates":[{"account_id":"manual_...","balance":1234.56}]}'
```

The `account_id` is shown in the account's edit dialog. The response reports
each id's outcome (`updated`, `not_found`, or `invalid`) so a script pointed
at a stale id fails loudly instead of looking healthy. A successful push also
records a net-worth snapshot immediately, so the chart doesn't wait for the
app to be opened.

This is the escape hatch for filling Plaid's gaps however you like. Some
options, roughly in order of how well they hold up:

- **[SimpleFIN Bridge](https://beta-bridge.simplefin.org/)** (~$15/yr,
  read-only, daily refresh) is purpose-built for personal aggregation and is
  what Actual Budget and Firefly III use. It sometimes covers institutions
  Plaid misses.
- **OFX Direct Connect**, the pre-Plaid standard, is still enabled at many
  credit unions (often needing a separate enrollment and PIN) and is
  scriptable with [`ofxtools`](https://github.com/csingley/ofxtools). Check
  the [GnuCash bank list](https://wiki.gnucash.org/wiki/OFX_Direct_Connect_Bank_Settings)
  for a given institution. The industry is migrating away from it, so treat it
  as a bonus where it exists.
- **Other aggregators** (Teller, MX, Akoya, Finicity) generally have
  *narrower* long-tail coverage than Plaid, so they rarely help with the exact
  institutions Plaid is missing.
- **Scraping your own account** is possible but a maintenance treadmill: MFA
  and device binding break it, bank logins from datacenter IPs get flagged (so
  it can't run on Vercel), most bank terms prohibit automated access, and the
  failure mode is a locked account rather than a stale number. If you do it,
  run it on your own machine and push the result here rather than storing bank
  credentials in this app.

Note that the endpoint only *updates* accounts that already exist. It can't
create them, so a leaked token can't invent accounts.

## 5. Deploy

```bash
vercel deploy --prod
```

Vercel gives you a free HTTPS domain automatically — no separate hosting step needed.

**One Plaid-specific step:** in the [Plaid Dashboard](https://dashboard.plaid.com), under Team Settings → API, add your deployed URL to the allowed redirect URIs (some bank logins use OAuth screens that redirect back to a registered domain).

### Preview deployments

Every branch you push gets a stable URL, `https://nya-git-<branch>-<team-slug>.vercel.app`,
which repoints to that branch's newest deployment on every push (slashes in a
branch name become dashes). Each individual build also keeps an immutable
`https://nya-<hash>-<team-slug>.vercel.app` that never moves, which is what to
send someone when you mean one exact version.

This repo keeps a long-lived `preview` branch so that URL is predictable
instead of changing with every feature branch:

**<https://nya-git-preview-fueroberthers-projects.vercel.app/?_vercel_share=hsOPuA6Qvofd4jxnrQVjuqXhPVkNqykh>**

The `?_vercel_share=` token carries visitors through Deployment Protection
without a Vercel account. It is a credential, so rotate it under
**Settings → Deployment Protection** if the link travels further than intended.

Anything on `main` lands there on its own:
[`.github/workflows/sync-preview.yml`](.github/workflows/sync-preview.yml)
merges `main` into `preview` on every push to `main`, which also triggers the
deployment. It merges rather than resets, so the preview-only commits below
survive, and on a conflict it aborts and fails the run, leaving `preview`
untouched for you to resolve by hand.

To see a branch that has *not* merged yet, merge it into `preview` yourself:

```bash
git checkout preview
git merge your-feature-branch
git push
```

Treat `preview` as a throwaway integration target, never a merge source: real
work reaches `main` by pull request. If it tangles,
`git reset --hard origin/main && git push --force-with-lease` starts it over,
at the cost of the login button described below.

#### What preview runs against

Preview is a public demo, so nothing about it is shared with production:

- **Its own Upstash database**, connected to **Preview** only (Storage → Create
  Database, then pick the Preview scope). The integration attaches its
  connection variables to every environment by default, so this has to be set
  deliberately, otherwise preview reads production's data.
- **Its own `APP_PASSWORD`, `SESSION_SECRET` and `PLAID_ENCRYPTION_KEY`**, added
  under Settings → Environment Variables with the **Preview** box ticked. The
  encryption key must match whatever encrypted the tokens in the database it
  reads (`lib/crypto.ts`), so a fresh database takes a fresh key.
- **`PLAID_ENV=sandbox`**, so linked accounts are Plaid's fake ones.

Nothing here is inherited from production. A preview with no variables set
builds fine and then fails at runtime.

#### The preview login button

The `preview` branch carries a **Use preview account** button on the login page
that signs visitors in without a password. It posts `previewLogin` to
`/api/login`, which mints a session only when `VERCEL_ENV` is not `production`.
A production deployment refuses with a 403 and never renders the button.

That commit lives on `preview` only and is deliberately not merged to `main`.
It is what makes the demo openable by anyone holding the link, so it is only
safe while the point above holds and preview has its own database.

#### Gotchas

- Deploys fire on a push of a *new commit*. A branch pointing at a commit that
  has already been deployed will not rebuild; use **Redeploy** in the dashboard
  to force one.
- If no preview builds at all, check **Settings → Git → Deployment Branches**.
  It has to be "All Branches", or a pattern that matches the branch.
- The `/api/snapshot` cron in `vercel.json` only runs on production
  deployments. Call the route by hand with `CRON_SECRET` as a bearer token to
  exercise it on a preview.
- If you use Plaid's OAuth bank logins, add the preview URL to the allowed
  redirect URIs alongside the production one.

### Backing up your data

Some of what Nya stores exists nowhere else: banks stop serving old
transactions after a while, and no bank serves daily balance history at all.
Take a backup before any risky change, and keep it somewhere other than
Upstash.

The export route is off by default. To take one:

1. In Vercel, set `OPS_SECRET` (generate with `openssl rand -base64 32`) and
   `OPS_ENABLED=1` on the environment you want to back up, then redeploy.
2. Download it:

   ```bash
   curl -X POST https://your-app.vercel.app/api/ops/export -H "Authorization: Bearer $OPS_SECRET" -o nya-export.ndjson
   ```

3. Check the last line of the file is a footer (`{"end":true,...}`). If it
   is missing, the download was cut short; take it again.
4. Remove `OPS_ENABLED` and redeploy. While it is unset the route answers 404.

Balances, transactions, budgets, goals and access tokens stay **encrypted** in
the archive, and cannot be read without `PLAID_ENCRYPTION_KEY` (and, once data
keys are in use, `MASTER_KEY`; the data keys themselves are in the archive,
encrypted with it). Keep a copy of those keys somewhere separate from both the
archive and Vercel (a password manager, or on paper). Lose them and the backup
cannot be read.

Not everything in it is encrypted, though, so still treat the file as private:
dates, account and transaction ids, the names of your linked banks, and the
merchant names you have renamed are stored as plain text.

The last line also carries a checksum, so a file damaged in storage or transit
is caught before it is restored. It is not a signature: it will not stop
someone who edits the file on purpose.

Caches and login rate-limit counters are left out on purpose. Avoid running
it around 13:00 UTC, when the daily snapshot writes.

### Restoring a backup

Restore runs on your own machine, not as a web route: a real backup can be
bigger than Vercel lets a request upload, and it keeps anything on the internet
from being able to overwrite your data.

1. `vercel env pull .env.local` so the command has the Upstash credentials.
   Every environment shares one database, so these credentials can reach
   production too. What decides where the restore writes is the prefix.
2. Try it on a scratch namespace first, and check the file without writing:

   ```bash
   REDIS_PREFIX=restore-test bun run restore nya-export.ndjson --target restore-test --dry-run
   REDIS_PREFIX=restore-test bun run restore nya-export.ndjson --target restore-test
   ```

   To look at the result, point a preview deployment at it by setting
   `REDIS_PREFIX=restore-test` on that preview.

The command refuses, and writes nothing, when:

- the file is incomplete, damaged, or from a different key layout;
- `--target` does not match `REDIS_PREFIX` (both are required, so a leftover
  shell variable cannot aim it somewhere you did not mean);
- the target already holds data and `--overwrite` is not given;
- the target is `production` and `--confirm-production` is not given;
- it would replace data with an archive holding no keys (`--allow-empty`
  overrides), or with one taken from a different environment
  (`--allow-different-source` overrides). Restoring into an **empty** target
  from anywhere, like production into `restore-test`, needs neither.
- the target has containers (see **Containers**) and the archive's are not
  the same, for example an archive from before containers existed: restoring
  it would leave `CONTAINER_ID` naming a container that no longer exists.
  `--replace-registry` overrides; afterwards set `CONTAINER_ID` again (or
  create a container, if the archive has none). A dry run reports this too.

With `--overwrite`, it prints how many keys it is about to replace, saves the
target's current contents to a `nya-pre-restore-<target>-<time>.ndjson` file,
and checks that file holds every key it is about to delete. Then it
**replaces** the target entirely (login rate-limit counters aside), so nothing
newer than the archive survives. If the target changes while this is going on,
it stops before deleting anything. It finishes by reading everything back and
comparing it with the archive, and reports success only if they match exactly.
If a restore stops part way, run it again with `--overwrite`.

File paths are resolved from the repo root, since `bun run` runs there, and
that is also where the pre-restore file is written.

Don't use the app while a restore is running, and avoid 13:00 UTC: anything
written to the target mid-restore makes the final comparison fail. If a
deployment serves the target (restoring over production, say), **redeploy it
right after** the restore: a running instance remembers the data key it writes
with for up to a minute, and if the restore replaced that key, anything it
writes meanwhile can never be read.

`.ndjson` files are git-ignored so a backup is never committed by accident.

## 6. Install on your phone

**iPhone (Safari):** open your deployed URL → Share icon → **Add to Home Screen**

**Android (Chrome):** open your deployed URL → ⋮ menu → **Install app**

---

## Security notes

### Password gate

Deploying to Vercel gives the app a public HTTPS URL — anyone who found it
could otherwise view your balances or link their own account into your
Redis store. Every route (except `/login` and the PWA assets needed for install)
is now gated by `proxy.ts` (Next's renamed middleware convention), which
checks a signed, expiring session cookie. Logging in at `/login` sets that
cookie for 30 days.

Sessions can be ended (`lib/auth.ts`, `lib/sessions.ts`):

- **Sign out everywhere** (next to Log out) ends every session on every
  device, this one included. Other devices are sent to the login page within
  a few seconds.
- **Changing `APP_PASSWORD`** (then redeploying) ends every session too.
- A session belongs to the container (see **Containers**) and only works in
  a deployment using that container. **Logging in needs a container to
  exist:** create it before deploying this version to a new environment
  (production already has one). Existing sessions keep working either way;
  without a container, new logins are refused with a message saying how to
  create one. For local development, run the app with `OPS_ENABLED=1` and an
  `OPS_SECRET` once, create the container with the same `curl` against
  `http://localhost:3000`, and set `CONTAINER_ID` in `.env.local`.
- Sessions from before this change stay valid until they expire (at most 30
  days) and do not end on a password change; Sign out everywhere does end them.
- While the container cannot be worked out (a wrong `CONTAINER_ID`, or it is
  being restored), no session is accepted. If the database itself is
  unreachable, requests are let through, since every page needs it anyway.

This is a single shared password, not per-user accounts — appropriate for
one person's personal tracker, not for sharing with others. If you want
real multi-user auth later, swap this for something like NextAuth/Auth.js
or Clerk rather than extending the password system.

### Token encryption

Each Plaid access token is encrypted (AES-256-GCM) with `PLAID_ENCRYPTION_KEY`
before being written to Redis — see `lib/crypto.ts`. That key lives only in
your env vars, never in Redis itself, so a database-only leak doesn't expose
usable tokens.

Balance and transaction responses are also cached in Redis for 15 minutes
(so the dashboard doesn't wait on live Plaid calls every load — the Refresh
button forces a live fetch), encrypted with the same key. See `lib/cache.ts`.
The daily net-worth history behind the Home-tab chart (`lib/history.ts`) is
stored the same way: encrypted values, keyed by date. It has two layers:

- **Real snapshots** — recorded on every clean live fetch, plus daily by a
  Vercel Cron (`vercel.json` → `/api/snapshot`, authenticated with
  `CRON_SECRET`), so the chart stays gapless even on days you don't open
  the app. Per-account balances are snapshotted alongside the total, which
  is what feeds the tap-to-expand account charts. The cron runs each active
  container on its own (`lib/snapshot-job.ts`) and answers 200 with one
  result per container, even when some failed. It answers 500 when nothing
  was snapshotted: the container registry cannot be read (after one retry),
  holds no container, or no container was recorded (every one failed, came
  back unclean, was deferred, or is not active). Nothing linked is not a
  failure. A second entry two
  hours later (`/api/snapshot/catchup`) is the catch-up: containers already
  recorded that day are skipped, the rest (failed, unclean, not started in
  time, or with nothing linked) are run again. Each container's outcomes are kept per date and
  served, newest first, by `GET /api/snapshot-runs`; they describe this
  environment's cron, so exports leave them out and a restore keeps them.
  Until the data moves into containers, only this deployment's container is
  snapshotted, any other is reported as skipped, and nothing runs while a
  container is being restored.
- **Estimated backfill** — on first use (and after linking a new
  institution) the app reconstructs up to a year of history from
  transaction data (`/api/backfill`), at three levels of fidelity:
  cash and credit accounts are walked backward from today's balances,
  un-applying each day's transactions; investment accounts have their
  external flows (deposits, withdrawals, dividends, fees) un-applied the
  same way, but market movement isn't a transaction and can't be recovered,
  so price changes within the window are not modelled; loans and manual
  accounts are held flat, since amortization isn't in the transaction
  stream and a typed balance has no stream at all. The chart draws the
  whole region dashed and labels it estimated. An institution whose
  investments product isn't available falls back to flat for those accounts
  without affecting the rest of the run; one whose data is merely still being
  extracted also falls back, but the run isn't recorded as complete, so the
  next load rebuilds it once the flows have arrived rather than freezing the
  gap in place. New links request 730 days of
  transactions; older Items may only have ~90 days until relinked.
  An investment account whose flows out-run its balance (a $60k rollover into
  an account worth less than that today) is floored at zero from that day
  backward rather than dropped, so a large arrival reads as the step it was on
  that account's chart and on the net-worth line;
  and because a brokerage often reports further back than a bank does, an
  investment account's own series is walked past the oldest cash transaction
  even though the net-worth total stops there.

One deliberate tradeoff: the dashboard keeps the last-known snapshot in the
browser's `localStorage` so the PWA opens instantly and still shows balances
offline. That snapshot is readable on-device without the app password (e.g.
by someone with your unlocked phone) — acceptable for a personal device, but
worth knowing. It's cleared on logout.

**Keep `PLAID_ENCRYPTION_KEY` and `SESSION_SECRET` safe** — losing the
encryption key makes previously stored tokens permanently undecryptable
(you'd need to reconnect all accounts); losing/leaking the session secret
would let someone forge a valid login cookie.

**Encryption keys** (envelope encryption, `lib/crypto.ts`). Data is encrypted
with **data keys** that the app generates and stores in Redis, each locked
with one **master key**, `MASTER_KEY`. `PLAID_ENCRYPTION_KEY` is the original
key, `k0`: everything written before data keys existed is under it.

- **Turning it on:** generate a master key (`openssl rand -base64 32`), save it
  in your password manager, and add it in Vercel as `MASTER_KEY` (Production,
  marked Sensitive). The next write creates the first data key, and from then
  on new data is written under it. Existing data stays under `k0` until the
  re-encryption pass below moves it.
- **Without `MASTER_KEY`** the app keeps writing under `k0`, exactly as before.
  If the data key can't be used for any reason, writes fall back to `k0` and the
  log says so ("Writing with the legacy key", repeated hourly while it lasts),
  so a problem with the master can never block a save.
- Only a deployment with the **current** master creates a data key, never
  while a master rotation is being prepared or is pending, and one at a time.
  An old deployment still running after a rotation writes under `k0` instead.
- **Never remove `PLAID_ENCRYPTION_KEY`** while any value still uses `k0`.
- **Status:** an empty POST to `/api/ops/rotate-master` (with `OPS_ENABLED=1`)
  reports `active_key`, the data key new writes use (`null` means still `k0`),
  `active_key_problem` if this deployment cannot use it, and
  `this_instance_fallback_since` if the instance that answered has been
  writing under `k0` instead.

**Moving existing data to the data key** (the re-encryption pass). Everything
written before `MASTER_KEY` was set is still under `k0`. The pass moves every
value that is not under the active data key to it, safely while the app is
running: a value is only written back if it has not changed since it was read,
and readers see exactly the same data either way.

1. Take a backup first (`/api/ops/export`, above). Don't run the pass while
   a restore is running.
2. With `OPS_ENABLED=1`, check what is left. This changes none of your data
   and creates no key (like any read, it can finish a master rotation that is
   already due):

   ```bash
   curl -sS -X POST https://your-app.vercel.app/api/ops/reencrypt \
     -H "Authorization: Bearer $OPS_SECRET"
   ```

   `to_move` counts values by the key they are under (`k0` is the old one).
   `active_key` is `null` until the first data key exists; the first run
   creates it.
3. Move them, repeating until it answers `"complete": true` (each call stops
   after about 40 seconds and carries on next time):

   ```bash
   curl -sS -X POST https://your-app.vercel.app/api/ops/reencrypt \
     -H "Authorization: Bearer $OPS_SECRET" -H 'Content-Type: application/json' -d '{"run":true}'
   ```

4. Remove `OPS_ENABLED` and redeploy.

It never shows values, only key and field names, counts and reasons. What
the fields mean:

- `unclassified`: a store the pass does not know about. Left alone; a bug to
  report.
- `unreadable`: a value it cannot move, left exactly as it was, with the
  reason: it cannot be decrypted, the key has an unexpected type, it is bound
  to a context, it is listed as plaintext but is encrypted, and so on.
- `changed_meanwhile`: saved by the app while being moved; picked up next call.
- `deleted_meanwhile`: deleted by the app while being moved; nothing to do.

If a call stops with "the active data key changed", something replaced the
key store mid-pass (a restore, most likely): nothing was written under a key
that no longer exists. Call it again once that is finished.

**Keep `PLAID_ENCRYPTION_KEY` in Vercel even after the pass completes.** It
costs nothing, the app still falls back to it if the data key is ever
unavailable, and if it is marked Sensitive in Vercel (so cannot be read back
out) and you have no other copy, removing it is permanent: any value still under `k0` then (an old backup, a fallback write)
could never be read again.

**Containers** (preparing for more than one user, #53). Every record will
belong to a *container*; today there is one, and nothing uses it yet. It is
created once, by you, never automatically (two requests racing to create one
would split your data between two):

1. With `OPS_ENABLED=1`, create it:

   ```bash
   curl -sS -X POST https://your-app.vercel.app/api/ops/containers -H "Authorization: Bearer $OPS_SECRET" \
     -H 'Content-Type: application/json' -d '{"create":true}'
   ```

   It answers with the new id. Asking again is refused.
2. In Vercel, set `CONTAINER_ID` to that id (Production) and redeploy.
3. Check: an empty POST to the same route lists the containers and should
   say `"container_id_status": "ok"`.
4. Remove `OPS_ENABLED` and redeploy.

Preview has its own container (a separate prefix, a separate registry): do
the same there if you use preview.

The caches are the first thing kept inside the container. Without a usable
`CONTAINER_ID` the app still works, just uncached (every load fetches live),
and the log says `Caching is off: the container could not be resolved`.

**Rotating the master key** never touches your data, only the locks on the
data keys, and never needs a second key in Vercel.

1. Generate a new key (`openssl rand -base64 32`) and save it in your password
   manager first.
2. Set `OPS_ENABLED=1` (and `OPS_SECRET`, as for a backup), redeploy, then
   send the new key to the running app, which still has the current one.
   Reading it with `read -rs` keeps it out of your shell history:

   ```bash
   read -rs NEW_KEY   # paste the new key, press Enter
   printf '{"new_master_key":"%s"}' "$NEW_KEY" | curl -sS -X POST \
     https://your-app.vercel.app/api/ops/rotate-master \
     -H "Authorization: Bearer $OPS_SECRET" -H 'Content-Type: application/json' --data-binary @-
   ```

   Every data key gets a second lock for the new key, checked before it is
   saved. **Only continue if this returns `"prepared"`.** If it returns an
   error, nothing was switched over; fix the cause and send it again.
3. Check the `new_master_fingerprint` it returns matches the key you saved:

   ```bash
   { printf 'nya master key fingerprint:'; printf '%s' "$NEW_KEY" | openssl base64 -d -A; } \
     | openssl dgst -sha256 -r | cut -c1-16
   ```

4. In Vercel, set `MASTER_KEY` to the new key, remove `OPS_ENABLED`, and
   redeploy.

That's all. Twenty-four hours later the app removes the old locks by itself;
until then you can still roll back to the previous deployment. After that, the
old key opens nothing in the database.

- **Checking progress:** POST an empty body to the same URL (with
  `OPS_ENABLED=1`). It answers `none`, `prepared` (the new key isn't deployed
  yet), or `grace` with the time the old locks go.
- **If something went wrong** (the new deployment can't read its data, you
  sent a key you didn't save, or you never did step 4): roll back or keep the
  current deployment, then send a new key. A new request replaces an
  unfinished one.
- **Preview** has its own key store. If it shares the master key, rotate it
  separately, or scope `MASTER_KEY` to Production only.
- **Backups** taken before a rotation still need the old key.
- **What this does not do:** someone who already has a copy of the database or
  a backup *and* the old key can still read that copy, and the data keys in it
  don't change. After a real leak, the data keys need replacing too, which
  comes with the re-encryption pass.

**Keep `MASTER_KEY` in your password manager.** Without it, nothing encrypted
with a data key can be read, from the database or from any backup.

### Login rate limiting

`/api/login` allows at most 10 failed attempts per IP per 15 minutes
(tracked in Redis; a successful login clears the counter, and the limiter
fails open if Redis is unreachable). This blunts brute-forcing of
`APP_PASSWORD` on the public URL.

### What's still not covered

- **Single household password**, not per-person accounts: anyone with the
  password gets full access, including the ability to disconnect your
  accounts. Sessions can be ended everywhere, but not one device at a time.
- Rate limiting covers only the login endpoint, not the data routes (those
  already require a valid session).

## Limitations

- **Test coverage is narrow by design.** `bun test` covers the pure logic where
  a silent wrong answer is worst: the net-worth history layers
  (`lib/history.ts` — real-vs-estimated merging, retention across recomputes,
  and hidden-account subtraction), the backward balance walk behind the
  estimated layer (`lib/backfill.ts`), Plaid's investment sign conventions and
  pagination (`lib/investments.ts`), liability normalization
  (`lib/liabilities.ts`), the credit/loan sign rule that every total depends on
  (`lib/balance.ts`), last-known-balance recovery for a failed institution
  (`lib/last-known.ts`), and which holdings count as uninvested cash and when
  that is worth flagging (`lib/cash.ts`). Routes, React components and anything talking to live
  Plaid are not covered.
- **Liabilities is a paid Plaid product.** Free in `sandbox`, but billed per
  Item per month in `production`, so enabling payment details on many
  institutions has a running cost. Investments (holdings and activity) is
  billed the same way.
- **Reconstructed investment history ignores market movement.** The estimated
  region removes contributions and withdrawals, so it no longer applies this
  year's deposits retroactively, but Plaid exposes no historical prices — a
  portfolio that doubled looks flat until real snapshots take over. Dividends
  a broker reports as a single reinvestment row are counted as internal and
  missed entirely.
- **Manual balances are only as fresh as your last update.** They hold flat
  between updates, so a stale one quietly overstates or understates net worth.
  Each card shows when it was last updated. Automate it with
  `/api/ingest/balance` if a given account matters.
- **Offline is read-only last-known data** — the PWA opens with the last
  snapshot from `localStorage`, but refreshing, linking, and transactions
  need a network connection (`/api/*` responses are never cached by the
  service worker).

## Extending this

- Push notifications (PWA web push) for budget alerts and upcoming bills
- Goal target dates with required-monthly-savings math
- Currency-aware account-level figures — transaction views already render each
  amount in its own currency and flag mixed-currency totals, but net worth,
  balances, and goals still show `$` because the live-balance path doesn't
  surface a currency code yet.
- Debt payoff planning on top of the new liabilities data: interest paid per
  month, avalanche vs snowball ordering, a debt-free date on the net-worth chart.
- Plaid webhooks (`SYNC_UPDATES_AVAILABLE`, `ITEM_LOGIN_REQUIRED`) to replace
  the 15-minute cache and daily cron with near-live updates, and to surface a
  broken institution before you next open the app.

The `plaid-data-unlock` GitHub issues that tracked the earlier round of
unused-Plaid-field features are all closed and shipped.
