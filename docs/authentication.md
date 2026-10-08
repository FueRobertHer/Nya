# Authentication and sharing

Nya has two ways to sign in. Without Clerk keys set, one shared password protects the whole app. With Clerk configured, people sign in with their own accounts and each gets their own data.

- [Password gate](#password-gate)
- [Signing in with Clerk](#signing-in-with-clerk)
- [Sharing between people](#sharing-between-people)
- [Demo accounts (Preview only)](#demo-accounts-preview-only)
- [What is not covered](#what-is-not-covered)

## Password gate

Deploying to Vercel gives the app a public HTTPS URL. Anyone who found it could otherwise view your balances or link their own account into your Redis store. So every route is gated by `proxy.ts` (Next's renamed middleware convention), which checks a signed, expiring session cookie. Logging in at `/login` sets that cookie for 30 days.

The exceptions are the login page and API, the PWA assets needed for install, and routes that authenticate themselves: the crons (`CRON_SECRET`), the balance ingest (`INGEST_SECRET`), Plaid's webhook (its signature), the ops routes (`OPS_SECRET`, off unless `OPS_ENABLED=1`) and the demo sign-in. See the header of `proxy.ts`.

Sessions can be ended (`lib/auth.ts`, `lib/sessions.ts`):

- **Sign out everywhere** (next to Log out) ends every session on every device, this one included. Other devices are sent to the login page within a few seconds.
- **Changing `APP_PASSWORD`** (then redeploying) ends every session too.
- A session belongs to a container (see [operations.md](operations.md#containers)) and only works in a deployment using that container. **Logging in needs a container to exist:** create it before deploying to a new environment. Existing sessions keep working either way; without a container, new logins are refused with a message saying how to create one.
- Sessions from before containers stay valid until they expire (at most 30 days) and do not end on a password change; Sign out everywhere does end them.
- While the container cannot be worked out (a wrong `CONTAINER_ID`, or it is being restored), no session is accepted. If the database itself is unreachable, requests are let through, since every page needs it anyway.

`/api/login` allows at most 10 failed attempts per IP per 15 minutes. The counter lives in Redis, a successful login clears it, and the limiter fails open if Redis is unreachable. This blunts brute-forcing of `APP_PASSWORD` on the public URL.

The password is a single shared secret, appropriate for one person's tracker. For more than one person, use Clerk.

## Signing in with Clerk

Clerk handles sign-in for people with their own accounts. It is off until its keys are set; without them the shared password works exactly as before.

1. Create a Clerk application (clerk.com) and turn on the sign-in methods you want. Invite-only fits for now: turn off public sign-ups and invite people from Clerk's dashboard.
2. In Vercel, on the environment to try it on (Preview first), set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from Clerk's API keys page, and redeploy. The publishable key is public by design (it is sent to every browser), so Vercel won't mark it Sensitive; add it as a plain variable. Mark `CLERK_SECRET_KEY` Sensitive.
3. Sign in at `/sign-in`. You land on "Not allowed yet" with your Clerk user id: set `CLERK_ALLOWED_USER_IDS` to it (comma-separated for more people) and redeploy.

Only people on that list get in; an empty list lets nobody in. An entry is either a Clerk user id (`user_...`) or an email address, mixed freely: `user_2abc..., partner@example.com`. An email lets in whichever account has it as a verified address (any case), so you can list someone before they have signed up. If one person matches two entries (their id and their email), they are simply allowed; to turn them away, remove both. The proxy asks Clerk for an account's emails only when its id isn't listed, and reuses the answer for a minute, so removing an address from an account takes up to a minute to count. Keep yourself listed by id: an email needs Clerk to answer (an answer up to ten minutes old covers a short outage), an id never does. "Verified" is Clerk's: with a social or SSO connection turned on, it trusts that provider's word for the address.

The first account on the list to sign in becomes the owner of the data already in this environment (its container), once. After that, each request reaches the container its signed-in account owns, so `CONTAINER_ID` isn't needed with Clerk. Sign in yourself before adding anyone else: the first account to sign in takes the existing data.

### Adding someone

Add their email to `CLERK_ALLOWED_USER_IDS`, redeploy, and invite them in Clerk (or have them sign in once and add the id "Not allowed yet" shows them). On their next sign-in they get a new, empty container of their own: they link their own banks and see only their own data. Background jobs without a signed-in account (the balance ingest, the password fallback) keep using the first container, the one marked primary. The nightly snapshot runs every account's container.

### Which account owns which container

That mapping is kept environment-wide under `owners`, and is in the backups. To hand a container to another account (a recreated Clerk user, say), move that one entry in the Upstash console: `HSET <env>:owners <new user id> <container id>`, then `HDEL <env>:owners <old user id>`.

Never delete the whole `owners` key once there is more than one container: with nothing mapped the app refuses every account rather than let whoever signs in first take the first container. (With a single container, deleting it is fine: the next sign-in claims it.) After restoring an archive into a namespace you'll open with a different Clerk instance, map your account there the same way: the archive's owners are accounts of the instance it came from.

### Deleting an account

In the account window (the avatar menu, then Manage account), the **Data & privacy** page has "Delete my account" (type DELETE to confirm). It disconnects that person's banks at Plaid, deletes everything stored for them, ends all sharing to and from them, and deletes their Clerk sign-in. If it stops part way, their data is already out of reach, and running it again finishes. The primary account (the first, the owner's) can't be deleted from the app. Take the person off `CLERK_ALLOWED_USER_IDS` too. To keep a copy first, they can download everything ([data-export.md](data-export.md)).

It ends with a **receipt**, shown on the sign-in page it signs out to, with Copy and Download as text (`lib/deletion-receipt.ts`):

- **Deleted now:** banks disconnected at Plaid (and any Plaid wouldn't disconnect), accounts, transactions, investment transactions, days of balance history, connections where sharing ended, and the sign-in. Accounts are counted as the person knows them: the accounts of the banks still connected and the manual ones, an account linked across a reconnect once. Accounts of banks they had disconnected, kept for their history, are listed apart.
- **Counting never holds up the deletion.** What is stored is counted after the container is archived and before any bank is disconnected, and the count gets ten seconds (`COUNT_LIMIT_MS` in `lib/account-deletion.ts`); past that, or if something can't be read, the deletion goes on and the receipt shows those figures as unavailable, never as a wrong number. A retry, which finds the container archived already, doesn't count again: part of the data may be gone by then. If an attempt stopped part way, the page keeps what it had counted and done, and the retry's receipt includes it. A bank Plaid no longer has (it answers `ITEM_NOT_FOUND`, for example because the first attempt already removed it) counts as disconnected; `INVALID_ACCESS_TOKEN` doesn't, since a token from another Plaid environment gets that answer too, while its connection may still exist.
- **Expires later:** the date the last nightly backup holding the data is gone. Those copies keep the data as it was stored: its values encrypted, but dates, account and transaction ids, bank names and the merchant names the person renamed in plain text ([operations.md](operations.md#taking-a-backup-by-hand)). Copies older than `BACKUP_KEEP_DAYS` (30 by default) are deleted by the next successful nightly run, but the newest 7 are always kept, so the last copy goes `BACKUP_KEEP_DAYS` + 1 days after the deletion, or 7 days when that is longer. The cron can start up to an hour late, so the receipt adds a day: 32 days by default. That holds while the nightly backup keeps running, and the receipt says when it has stopped. Without a blob store there are no backups, and it says that instead.
- **What stays, and why:** Plaid's own copy of what it collected, under its own policy, with a link to the [Plaid Portal](https://my.plaid.com) where people can see and delete it; server logs, which hold no amounts or balances; and any file they downloaded themselves.

### Turning it on in production

Create a production instance in Clerk (it asks for a domain you own), set its keys on Production, sign in once to get your production user id (it differs from the development one), add it to `CLERK_ALLOWED_USER_IDS` there, and redeploy. Your existing data is claimed on that first sign-in.

To turn Clerk off, remove the two keys and redeploy: the password sign-in is back.

## Sharing between people

Sharing is read-only and only between people who chose to connect. Nobody can find or list anyone else in the app.

- **Connecting.** Under Manage accounts, Sharing, make an invite link (optionally with your name as they'll see it, and what you call them) and send it to them yourself. It works once, for 72 hours; opening it (after signing in, if needed: they must already be on `CLERK_ALLOWED_USER_IDS`) and choosing Connect connects you. Each of you names the other; the app never shows anyone's real name or email. Each can introduce themselves too, and each side sees the other's introduction and the day you connected: if a link reached the wrong person, remove them before sharing anything.
- **What you share.** Per connection, choose for each of your accounts: Not shared, That it exists, Balance, or Balance and transactions (the last 30 days), and Save. They see it read-only on their Accounts tab under "Shared by <what they call you>" and can never change it. The Sharing card always says what each connection can see of yours.
- **Guarantees.** Nothing is shared until you choose it, hidden accounts are never shared, and a change takes effect at once. Balances are the ones your own loads and the nightly snapshot recorded: sharing never calls your bank on the other person's behalf. Hiding an account pauses its sharing until you unhide it.
- **Ending it.** Remove ends everything shared both ways. Block does too and stops any new link between you from working (only you can unblock).

Connections are kept environment-wide under `connections` (in the backups, so restoring an older backup brings back connections removed since). Unused invite links live under `invites:` (not in the backups). The `grants` key from the first version of sharing is no longer read and can be deleted.

## Demo accounts (Preview only)

One-click buttons on the sign-in page that sign anyone in as a shared demo account, on Plaid's sandbox. To set them up:

1. In the Clerk instance Preview uses (the development one), create two users (Users, Create user). A `+clerk_test` address such as `alex+clerk_test@example.com` needs no real inbox. Copy their ids.
2. On Vercel's Preview environment set `DEMO_USER_IDS` to them, each with a label: `user_abc:Alex, user_def:Sam`, and redeploy. The sign-in page then offers each one as a demo account.

They work only on Preview (`VERCEL_ENV=preview`) or a local `next dev`: set on Production, the variable does nothing. Demo accounts don't need to be on `CLERK_ALLOWED_USER_IDS`, can link sandbox banks (username `user_good`, password `pass_good`), connect and share like anyone, but can't be deleted. Everyone who tries them shares them.

Before making Preview public (turning off Vercel's protection for it), give it its own database and `MASTER_KEY`, as described in [deployment.md](deployment.md#what-preview-runs-against).

## What is not covered

- **The shared password is one secret for everyone who has it.** Anyone with it gets full access, including the ability to disconnect accounts. Sessions can be ended everywhere, but not one device at a time. Use Clerk for more than one person.
- **Rate limiting covers signing in and data downloads only**: wrong passwords per IP (shared by the login and the password asked for before a download), demo sign-ins per IP, and five downloads of your data an hour per account. The other data routes already require a valid session.
- **The on-device snapshot is readable without the app password.** The dashboard keeps its last-known snapshot in the browser's `localStorage` so the PWA opens instantly and shows balances offline. Someone with your unlocked phone can read it. That is acceptable for a personal device, but worth knowing. It is cleared on logout (and per signed-in account with Clerk).
