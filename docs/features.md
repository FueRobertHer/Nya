# Features in depth

How the main behaviours work, and why. The [README](../README.md) has the overview.

- [Connecting accounts](#connecting-accounts)
- [Removing an institution and adding it back](#removing-an-institution-and-adding-it-back)
- [Payment details](#payment-details)
- [Hiding accounts](#hiding-accounts)
- [When an institution can't be reached](#when-an-institution-cant-be-reached)
  - [Connection health](#connection-health)
  - [Reconnect soon](#reconnect-soon)
  - [Email notices](#email-notices)
- [Manual accounts](#manual-accounts)
- [Keeping Plaid costs down](#keeping-plaid-costs-down)

## Connecting accounts

Log in, then click **Connect an Account**. Click it again for each additional institution. Each one is added to your dashboard with a running net worth total.

Bank connections work for US institutions only: both link-token routes ask Plaid for `CountryCode.Us`. The app says so beside **Connect an account** and on the login and sign-in pages, and points anything else to a [manual account](#manual-accounts), saying that its balance is entered in US dollars, the only currency manual accounts take for now.

### More accounts at an institution you already have

To add (or remove) accounts at an institution that's already connected, tap **Manage** on the Accounts tab, then **Add or remove accounts** on its card. This opens Plaid's account picker on the connection you already have, so it stays one connection: no duplicate accounts, and no second connection for Plaid to bill.

If you start **Connect an Account** and pick an institution you've already connected, Nya stops before you sign in and offers to add the accounts to the existing connection instead. Choose **It's a different login** for a genuinely separate login (a joint or business login, say); that one gets its own connection.

When Plaid notices new accounts at a connected institution (it needs webhooks, below), the card says so and offers **Review accounts**, which opens the same picker.

Removing an account in the picker stops Nya receiving new data for it. Its balance history and stored transactions are kept, as they are when you disconnect a whole institution. Recorded past totals don't change, but the estimated part of the chart (before Nya started recording) is rebuilt from the accounts connected now whenever an account is added, so a removed account drops out of those estimates then. Chase doesn't let accounts be removed this way; hide the account, or disconnect Chase, instead.

If Plaid Link asks you to reconnect an institution (shown as a **Reconnect** button on its card), the bank's credentials or MFA changed on their end. Click it and log back in through Plaid to fix it; there is no need to disconnect and relink from scratch. The [Connection health](#connection-health) card says which institutions need this, and why.

In `sandbox` mode, Plaid Link shows fake test institutions. Search for any name (for example "Chase") and log in with username `user_good` and password `pass_good`.

## Removing an institution and adding it back

Sometimes a connection has to be removed and added again (it broke badly, the bank moved platforms, or you are coming back after a while). Plaid then gives every account a new id, so on its own the re-added account would start a new, empty history beside the old one.

Instead, the Accounts tab (under **Manage accounts**, in **Reconnected accounts**) offers to link each new account to the one it replaces, with the evidence and a chart preview. Nothing is linked until you say so. Once linked:

- its **balance history** continues from the old account's;
- if you had **hidden** the old account, the new one is hidden too (a hidden account stays hidden after you disconnect it, listed as disconnected in the Hidden card, where you can still unhide it);
- **categories you set** on the old account's transactions show on the same transactions under the new account (matched by date, amount and the bank's own description of the transaction), and the link says how many carried over. A category you set on a new transaction wins. Two identical transactions on the same day that you categorized differently (or only one of) can't be told apart, so they carry nothing.

Anything not offered can be linked with **Link an earlier account by hand**: there is no time limit, and it works even after you said an offer was not the same account. **Unlink** undoes a link completely; nothing stored is changed by linking.

### What is kept, and forgetting it

After you disconnect an institution, Nya keeps each of its accounts' balance history, name, mask and institution, and the categories you set, so a re-added account can pick them up, even months later. You decide how long: **Earlier accounts** lists the accounts of institutions you disconnected, and **Forget** deletes one's balance history, name and saved categories for good.

- Your past net-worth totals don't change (they were your net worth on those days).
- A hidden account stays out of them: forgetting it takes its amount out of each stored total, so the chart looks as it did while it was hidden, and nothing about the account is kept. Two differences: a day the chart left out because it couldn't tell what the account held that day is deleted, if the account existed then; and a day it left out from before the account existed or after it was last seen comes back, since the account had no part in it.
- While that is under way the account can't be unhidden; if it stops part way, Forget again finishes it.
- Unlink a linked account first.
- An account of an institution that is still connected (a card you closed, say) is listed there once you disconnect the institution.

Forget can't reach copies made before it: a backup you downloaded (see [operations.md](operations.md#backups)) still has the account, and restoring that backup brings it back, and a file from [Download my data](data-export.md) still lists it. A goal that pointed at the account keeps pointing at it (as an account id only) until you change the goal.

Disconnecting ends the connection at Plaid as well as in Nya, but it can't reach the records Plaid keeps itself, under its own privacy policy. The confirmation links to the [Plaid Portal](https://my.plaid.com), where you can see and delete them.

## Payment details

Credit cards and loans show what they actually cost: purchase APR, minimum payment, and next due date on the account row, with statement balance, last payment, accrued interest, escrow and payoff or maturity date when the row is expanded. A payment coming due within a week, or one already overdue, also surfaces as an alert on the Home tab.

This comes from Plaid's Liabilities product, which has to be enabled on an institution before it will return anything. Newly connected institutions get it automatically. Institutions you linked before this existed don't, so they show an **Enable payment details** button on their card: tap it, log back in through Plaid, and the terms appear.

That button goes through Link's *update mode*, which re-authenticates the institution you already have rather than adding a second one: the item keeps its id, and its stored transaction history survives. Not every institution supports the product; where it isn't supported the button says so rather than failing silently, and where there's simply nothing to report (no cards or loans) no button appears at all.

## Hiding accounts

Some accounts you want synced but not counted: a joint account, a business card, an old account kept linked for records. On the Accounts tab, tap **Manage accounts** and then **Hide** on any account, linked or manual.

A hidden account keeps syncing and keeps being stored. It's left out of net worth, the balance sheet, the Activity tab, budgets, insights, recurring-bill detection, and the goal picker. Hidden accounts collect in a collapsed **Hidden** card at the bottom of the Accounts tab, where **Unhide** restores them.

Hiding is **retroactive**: the net-worth chart redraws as though the account was never counted, rather than showing a cliff on the day you hid it. That works because nothing is deleted. Snapshots keep recording the true total and every account's balance, and hiding is applied when the chart is read, so unhiding brings back the full history including the period while it was hidden.

Hiding is not a security feature: the data is still fetched and stored, it just isn't shown or counted. To actually remove an account, disconnect it (Plaid) or delete it (manual). A disconnected account that was hidden stays hidden (its history is kept, so unhiding it would change past totals) until you unhide it.

## When an institution can't be reached

Plaid connections fail: a bank has an outage, a login expires, an item needs re-authenticating. When that happens Nya shows the institution's **last known balances** with the date they were taken ("Could not fetch balances, balances as of Aug 7") rather than a $0.00 card.

That's not cosmetic. Dropping a failed institution from the total silently understates your debts as well as your assets, and a credit card falling out makes net worth go *up*: a broken connection that reads as good news. Showing the last real figures keeps the total honest while the connection is down.

Two stores back this. Balances come from the most recent daily snapshot, which is only recorded on days when **every** institution answered. Alongside it, each institution's account list is recorded every time **that** institution answers, so a card you closed drops out on the next successful load rather than lingering. Those two have different conditions, so they drift, and an account can be in one and not the other. When that happens the card can't show every row, and it says so: *"2 accounts couldn't be shown, so this total is incomplete."* That matters because a missing row is usually a missing debt, and a missing debt makes net worth look better than it is. Everything is scoped per institution, so one bank's problems never affect another's recovery.

If the balances are older than **35 days** the card stops showing them and names the date instead. An institution broken for months shouldn't quietly revert to zero, and it shouldn't drag a months-old figure into today's total either. Any institution that can't be reached and can't be recovered is called out under the Home total by name, with when it was last seen ("Chase needs reconnecting, last seen Sep 12, and isn't counted in this total"), so a total that's missing a whole bank never looks complete. The other notes under the total name their institutions too, rather than only counting them.

Recovered balances are **display-only**. They're never written to the net-worth history, and no snapshot is recorded on a day when any institution failed, so a stale figure can never be mistaken for a measured one in the chart. The consequence is a real gap: if a connection stays broken through the end of the day, that day gets no point at all and nothing back-fills it later. That's deliberate, because a fabricated flat line in the real history layer would be permanent: nothing ever rewrites a past date.

An institution that needs re-authenticating keeps the red warning and its **Reconnect** button, and only says the balances are dated. The softer amber note is reserved for failures that usually clear on their own, so a dead connection can't hide behind plausible-looking numbers.

A related case: an account that disappears from an otherwise successful fetch (a closed account some banks simply stop returning) holds the snapshot for three days, called out under the Home total, and is then accepted as closed. A glitch resolves itself inside that window; a real closure costs a few days of gap rather than a wrong total written permanently.

The same honesty reaches **Activity**. When an institution's transactions couldn't be loaded, or its connection is broken and last synced before a month ended, that month's totals say so under the figures ("Chase hasn't synced since Sep 12, so this month may be missing some of its transactions"). A month that ended before the connection last synced is left alone: nothing it holds is missing. The month's budgets on the Budgets tab say the same, since spending that is short makes a budget look safer than it is.

### Connection health

On the Accounts tab, the **Connection health** card lists every linked institution in one place. It stays collapsed to one line while everything works and opens on its own when something doesn't. For each institution it shows:

- its state: working, reconnect soon (with the date), needs reconnecting, not updating (an outage or a temporary error), needs connecting again, no open accounts, or missing accounts;
- when it last synced, as a date. Every load that reaches the institution and the daily snapshot record it;
- whose side the problem is on: your sign-in at the bank, the bank, Plaid, or Nya itself. A broken link looks like a Nya problem from the outside, so it says which;
- which accounts are affected, and how much of your net worth is shown from last known balances rather than measured now, labeled as such. Accounts with nothing to recover are named as not counted;
- the one thing to do about it.

Plaid's error codes decide the state, in one mapping (`lib/connection-state.ts`), and the action follows from it:

| What happened | Plaid's codes, for example | What to do |
| --- | --- | --- |
| Your sign-in needs redoing: a changed password, a new security step, a consent that ran out | `ITEM_LOGIN_REQUIRED`, `INVALID_CREDENTIALS`, `ACCESS_NOT_GRANTED`; `ITEM_LOCKED` and `USER_SETUP_REQUIRED` need something done at the bank first | **Reconnect**, which goes through Plaid's update mode: it keeps the connection and its history, and takes a minute. |
| The bank or Plaid is having trouble | `INSTITUTION_DOWN`, `INSTITUTION_NOT_RESPONDING`, `INTERNAL_SERVER_ERROR`, rate limits, no answer at all | Nothing: it usually recovers on its own. |
| The connection is gone and can't be repaired | `USER_PERMISSION_REVOKED`, `ITEM_NOT_FOUND`, `INVALID_ACCESS_TOKEN` | **Remove** it and connect the bank again. The new accounts get new ids, and [linking them to the old ones](#removing-an-institution-and-adding-it-back) carries the history over. Where Plaid can't reach the institution any more (`ITEM_NOT_SUPPORTED`, `INSTITUTION_NO_LONGER_SUPPORTED`), connecting again won't help, so only removal is offered; the history is kept. |
| Accounts were closed at the bank | `NO_ACCOUNTS`, or an account missing from an otherwise good answer | If you closed them, remove the connection (history is kept) or, for one missing account, nothing: it is counted as closed after three days. If not, check with **Add or remove accounts**. |

A code Plaid adds later reads as "not updating" with the code shown, never as a guess at one of the others. The **Reconnect** button on an institution's card follows the same mapping, so the card and the health view always agree.

### Reconnect soon

Plaid warns about a week ahead when a working connection is going to end: `PENDING_EXPIRATION` when the consent the bank gave runs out (with the time it does), and `PENDING_DISCONNECT` when the bank is ending connections, for example while it moves to a new connection method (with no time; Plaid says it sends it seven days ahead, so the date shown is an estimate, said as "around"). Nya records each warning for its connection, encrypted, and the institution's card shows a **Reconnect soon** badge with the date and a **Reconnect** button. Three days before the date, Home raises it too. Some banks' consent has an end date Plaid reports on every fetch; within a week of it, the card says Reconnect soon even when no webhook arrived (webhooks need `PLAID_WEBHOOK_URL`, [below](#keeping-plaid-costs-down)).

Reconnecting through update mode clears the warning, and so does Plaid's `LOGIN_REPAIRED` (a repair made in another app) or removing the connection. A warning a repair outran, such as one Plaid delivered again afterwards, ends by itself once the connection answers past the date it named, or Plaid reports the consent renewed.

### Email notices

When a connection breaks, the daily snapshot sends one email, and one reminder a week later if it is still broken. Nothing more: an email every day is an email nobody reads. A break begins at the first daily run that finds it and ends at the first run that finds the connection working again, or when you reconnect or remove it; the next break gets its own email.

- **What is worth an email:** a sign-in to redo, a connection to remove and make again, a bank reporting no open accounts, and Plaid's warning that a connection will end. An outage needs nothing from you, so it is emailed only once it has lasted three days since the connection last answered. A missing account settles itself within three days and is not emailed.
- **One email per run**, naming each connection that needs you and what to do, with a link that opens the Connection health card (`APP_URL/?view=connections`).
- **Never twice.** Each break is recorded before its email goes and marked sent only once the email service accepts it, so a run again (the catch-up two hours later, or a cron delivered twice) sends nothing new, and a failed send is tried again by the next run. Each email also carries an idempotency key, so a retry after an answer that never arrived isn't delivered twice.
- **What an email says:** the institution's name, what to do, and for a connection about to end, around which day. Never a balance, an amount or an account number.
- **Who gets it:** with Clerk, the primary email address of the account that owns the data, once Clerk has verified it. With the shared password, `NOTIFY_EMAIL`, and only for the deployment's own data.

Email is sent through [Resend](https://resend.com) and needs `RESEND_API_KEY` and `MAIL_FROM` ([deployment.md](deployment.md#email-notices)). Without them nothing is sent, the log says so once, and the Connection health card is the only place a broken connection shows.

## Manual accounts

Plaid's coverage is wide but uneven: small credit unions, HSAs, 401k recordkeepers, foreign banks, and anything that isn't a financial institution at all (property, crypto held off-exchange) may simply not be linkable. Those get tracked by hand.

Click **Add a manual account** (on the Accounts tab, or on the empty state before anything is connected), give it a name, an institution, a type, and a balance. Accounts sharing an institution name group into one card. From then on it behaves like a linked account: it counts toward net worth, appears in the Accounts tab, is selectable as a savings-goal source, and gets its own balance history chart.

The balance holds flat until you change it, and each update is recorded on the timeline, so the chart shows a step at each update rather than a pretend-smooth curve. Credit and loan balances are entered as the **amount owed** (a positive number) and subtract from net worth. Deleting a manual account is not reversible: re-adding it creates a new account with a fresh id and an empty history.

### Updating balances from a script

Retyping balances gets old. If you set `INGEST_SECRET`, anything that can make an HTTP request can push balances into your manual accounts:

```bash
curl -X POST https://your-app.vercel.app/api/ingest/balance -H "Authorization: Bearer $INGEST_SECRET" -H 'Content-Type: application/json' -d '{"updates":[{"account_id":"manual_...","balance":1234.56}]}'
```

The `account_id` is shown in the account's edit dialog. The response reports each id's outcome (`updated`, `not_found`, or `invalid`) so a script pointed at a stale id fails loudly instead of looking healthy. A successful push also records a net-worth snapshot immediately, so the chart doesn't wait for the app to be opened. The endpoint only *updates* accounts that already exist. It can't create them, so a leaked token can't invent accounts.

This is the escape hatch for filling Plaid's gaps however you like. Some options, roughly in order of how well they hold up:

- **[SimpleFIN Bridge](https://beta-bridge.simplefin.org/)** (about $15 a year, read-only, daily refresh) is purpose-built for personal aggregation and is what Actual Budget and Firefly III use. It sometimes covers institutions Plaid misses.
- **OFX Direct Connect**, the pre-Plaid standard, is still enabled at many credit unions (often needing a separate enrollment and PIN) and is scriptable with [`ofxtools`](https://github.com/csingley/ofxtools). Check the [GnuCash bank list](https://wiki.gnucash.org/wiki/OFX_Direct_Connect_Bank_Settings) for a given institution. The industry is migrating away from it, so treat it as a bonus where it exists.
- **Other aggregators** (Teller, MX, Akoya, Finicity) generally have *narrower* long-tail coverage than Plaid, so they rarely help with the exact institutions Plaid is missing.
- **Scraping your own account** is possible but a maintenance treadmill: MFA and device binding break it, bank logins from datacenter IPs get flagged (so it can't run on Vercel), most bank terms prohibit automated access, and the failure mode is a locked account rather than a stale number. If you do it, run it on your own machine and push the result here rather than storing bank credentials in this app.

## Keeping Plaid costs down

Plaid bills per linked institution (Item) per month for Transactions, Investments and Liabilities, and per request for its live-balance call. Nya is built to stay on the cheap side of that:

- **One connection per login.** Adding accounts at an institution you already have goes through Plaid's account picker on that connection rather than creating a second one (see [More accounts at an institution you already have](#more-accounts-at-an-institution-you-already-have)).
- **Balances come from `/accounts/get`**, the balances Plaid already holds, not the billed live-balance call. They are as fresh as the last transactions update, which is plenty for a daily net-worth snapshot. The cost is that the header's Refresh button re-reads from Plaid but cannot pull a truly live balance.
- **Webhooks** (optional). Set `PLAID_WEBHOOK_URL` to the public URL of `/api/plaid/webhook` on your deployment and Plaid tells Nya when new data is ready. Nya then serves dashboard loads from its own stored data for up to six hours instead of fifteen minutes, and drops that stored copy the moment Plaid says something changed. Refresh still goes to Plaid. Webhooks are verified against Plaid's signature; an unsigned request does nothing. Items linked before you set it are registered by the daily check below, or by reconnecting them.
- **Unused connections (admin only).** A daily check (`/api/plaid/check-items`) flags a connection, in any account, once Plaid has been unable to read it for 60 days (login expired, consent withdrawn) or every account on it has been hidden for 60 days. **It never removes anything.** The admin, meaning whoever owns the deployment's own account (normally the first to sign in with Clerk, or the password holder), sees the flagged ones under Manage on the Accounts tab, labelled by owner. Other accounts see nothing and the route answers them with a 404. Review and disconnect asks for the institution's name, and the server checks the connection again first: if its owner has reconnected it or unhidden an account, or Plaid does not answer, nothing is removed. Any success starts the count again; an outage or timeout counts for nothing. Change the period with `PLAID_UNUSED_DAYS` (minimum 14).

Liabilities and Investments are paid Plaid products: free in `sandbox`, but billed per Item per month in `production`, so enabling payment details or linking brokerages on many institutions has a running cost.
