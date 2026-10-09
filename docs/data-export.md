# Downloading your data

Everything Nya stores about you can be downloaded, decrypted, in open formats: one JSON file with all of it, or CSV files of your transactions and your balance history for a spreadsheet. This page says how to get it, what is in it field by field, and what is left out and why. The code is `lib/user-export.ts`, the route `app/api/my-data/route.ts`, and the card `components/DownloadMyData.tsx`.

- [Getting a copy](#getting-a-copy)
- [What is not in it](#what-is-not-in-it)
- [Conventions](#conventions)
- [The JSON file](#the-json-file)
- [The CSV files](#the-csv-files)
- [Every stored key, and where it goes](#every-stored-key-and-where-it-goes)
- [How it differs from the operator backup](#how-it-differs-from-the-operator-backup)
- [Adding a store](#adding-a-store)

## Getting a copy

On the Accounts tab, tap **Manage**, then **Download my data** at the bottom. Pick a format:

| Format | File | What it holds |
| --- | --- | --- |
| Everything (JSON) | `nya-data-<date>.json` | Every part described below. |
| Transactions (CSV) | `nya-transactions-<date>.csv` | Every transaction stored from your banks, one per row. Those you entered by hand are in the JSON file. |
| Balance history (CSV) | `nya-balances-<date>.csv` | Net worth and each account's balance, day by day. |

**A fresh sign-in comes first.** With Clerk, the download needs a sign-in verified in the last ten minutes (Clerk's "strict" level: the second factor if the account has one, the first otherwise). If yours is older, Clerk's own window asks you to confirm it is you, and the download carries on. With the shared password, the card asks for the password again; wrong ones count against the same limit as the login page (10 per IP per 15 minutes), so this can't be used to guess the password faster.

**Five downloads an hour**, per account. A sixth is refused with how long to wait. The number is `DOWNLOADS_PER_WINDOW` in `lib/download-limit.ts`, which both the limit and the card's text read.

**All or nothing.** Every store is read before the first byte is sent. If any part can't be read (a value that won't decrypt, a database error), nothing is downloaded and the error says which part, rather than handing over a file that looks complete and isn't. One kind of entry is named in the file instead: a record of when shared accounts were shown that can't be read is marked as such where it belongs, in [`sharing`](#sharing), never left out or shown as empty. The other person's record of what they share being shown to you is theirs to clear, so a damaged one would otherwise stop your download with nothing you could do about it.

**A whole file or none.** Before sending anything, the route writes the file out once only to count its bytes, keeping none of them, then streams it, and says how many bytes to expect twice: `Content-Length`, and `X-Nya-Export-Bytes`, the same number, which is the one the page checks (a proxy that compresses the response changes or drops `Content-Length`, and leaves this one alone). The page counts what arrives and saves the file only when that count is there and matches; otherwise it saves nothing and says the download was cut off, to try again. So a connection that drops part way, or a response ended early by the platform or a proxy, never leaves a short file that looks whole. The route may run for up to 300 seconds, for a large file over a slow connection.

**How big.** About 1.7 KB of JSON per transaction, and about 0.6 KB in the transactions CSV; history adds little. An account with 60,000 transactions and ten years of daily balances for 20 accounts comes to about 106 MB of JSON, 34 MB of transactions CSV and 7 MB of balance history CSV.

**Never written down.** The stores are read and decrypted in memory, and the file's text is written out a piece at a time as it streams to your browser, never held whole on the server. Nothing writes it to storage, a log or a blob store on the way, and the response tells caches not to keep it. The download itself is not encrypted, so keep the file somewhere safe.

**Not built yet.** Protecting the file with a passphrase of your own (today it is plain JSON or CSV), an OFX file for the money apps that import those, and an email telling you a download happened (#51): Nya can send email now (the notices about bank connections, `lib/mail.ts`), but a download doesn't send one yet, and the route marks where it would.

## What is not in it

The JSON file lists these itself, under `not_included`.

- **Bank access tokens.** The credentials Nya uses to reach your banks through Plaid. They are credentials, not your data, and they work only for Nya.
- **Your API tokens themselves.** Nya never keeps a token's secret, only a hash of it to check it against, and the hash is credential material too, so neither is in the file, and nor is the token's id, which is part of the token. Each token's name and dates are in, under [`api_tokens`](#api_tokens).
- **Your sign-in.** With Clerk, your email address and sign-in methods are kept by Clerk, not Nya; Clerk's account window shows them. With the shared password, the password itself.
- **Internal ids and the app's machinery.** Your storage container's id, caches, locks, sync cursors, whether Plaid included transactions when each connection was linked, rate-limit counters, and the records of scheduled jobs (snapshots, backups, checks on connections, and accounts a bank stopped reporting, held while the snapshot waits to be sure). They are about running the app, not about you.
- **The balances an estimate held flat.** For an account the estimate could not walk back through its transactions (investments, loans, manual accounts), estimated net-worth totals use that account's balance on the day the estimate was made. That copied balance is part of the estimated totals, but it is not a history of the account, so it is not listed as one.
- **Other people's data.** What people you are connected with share with you, what they call you, and how they introduced themselves. Their record of each time what they share was shown to you is in, under `sharing`: it is about you, and the same one they see.
- **Unused invite links.** They work for 72 hours and are then gone.

## Conventions

- **Amounts** are plain numbers in the account's currency. Nothing is converted between currencies.
- **Transaction signs** follow Plaid: positive is money leaving the account (a purchase), negative is money coming in (a refund, a paycheck). Investment transactions are the same: positive when cash is debited (a buy).
- **Balances** of credit cards and loans are positive amounts owed. Net worth adds every other account and subtracts those.
- **Dates.** History is kept per UTC day (`YYYY-MM-DD`). Times (`..._at`, `datetime`) are ISO 8601 instants in UTC, except `investment_transactions[].seen_at`, which is a UTC day. `first_seen` and `last_seen` are days too.
- **`null`** means not known or never stored, never zero. A time Nya never recorded is `null`, not a made-up date.
- **Ids** are Plaid's (`account_id`, `item_id` for a connection, `transaction_id`) or Nya's own (`manual_...` for manual accounts). They tie the parts of the file together.

## The JSON file

One object, UTF-8, laid out to be read: each top-level field starts a line, its lists run an entry per line, and each record (an account, a transaction, one day's balance) is on a line of its own, with everything it holds. Any JSON reader reads it the same as any other layout. Indenting every field as well would make the file about a third bigger, and much slower to write. Its top-level fields, in order:

| Field | What it is |
| --- | --- |
| `format` | Always `"nya-export"`. |
| `version` | `1`. It goes up when a field is removed or changes meaning; an added field leaves it alone. |
| `exported_at` | When the file was made. |
| `documentation` | A link to this page. |
| `not_included` | What the file leaves out, and why ([above](#what-is-not-in-it)). |
| `notes` | Caveats about this download, if any: for example that the newest transactions from an institution could not be saved, so they may be missing. Usually empty. |
| `institutions` | Your linked connections. |
| `accounts` | Every account the file mentions anywhere, apart from the manual accounts you have now. |
| `manual_accounts` | Accounts you track by hand. |
| `hidden_accounts` | Accounts you hid. |
| `net_worth_history` | Your net worth by day. |
| `account_history` | Each account's balance by day. |
| `transactions` | Every transaction stored from your banks. Those you entered by hand are in `manual-transactions`. |
| `category_overrides` | Every category you set on a transaction. |
| `merchant_renames` | Every merchant you renamed. |
| `investment_transactions` | Every stored investment transaction. |
| `investment_history_coverage` | Which days the stored investment transactions are known to be complete for. |
| `account_links` | Accounts you linked across a reconnect, offers you declined, and categories carried across. |
| `budgets` | Your monthly budgets. |
| `goals` | Your savings goals. |
| `api_tokens` | The API tokens you made, by name, with when each was made and last used. |
| `sharing` | Your side of sharing, with both records of when shared accounts were shown on each connection; `null` with the shared password, unless records from before are still stored. |
| *each store on the storage seam* | Then one field per store built on the storage seam and declared exportable, named after the store, in name order ([below](#stores-built-on-the-storage-seam)). Today: `allocation-settings`, `carried-annotations`, `connection-notices`, `connection-syncs`, `connection-warnings`, `fire-plan`, `holdings:history`, `manual-transactions` and `transaction-annotations`. (`sharing-access-log` is in `sharing`.) |

### `institutions[]`

| Field | Meaning |
| --- | --- |
| `item_id` | Plaid's id for the connection. |
| `institution_name` | The bank's name, as Plaid Link gave it. |
| `institution_id` | Plaid's id for the bank, or `null` for a connection made before it was stored. |
| `provider` | `"plaid"`. |

### `accounts[]`

Every account the file mentions anywhere, apart from the manual accounts you have now (those are in `manual_accounts`): connected ones, earlier ones whose institution you disconnected (kept for their history), and any id known only from its balance history, a link, a declined offer, a goal or something you share. Each detail comes from the freshest record that has it: what the last good balance fetch remembered, then the directory of every account seen, then the transaction store, then the investment store.

| Field | Meaning |
| --- | --- |
| `account_id` | Plaid's id for the account, or Nya's (`manual_...`) for a manual account you removed. |
| `provider` | `"plaid"`; `"manual"` for a manual account you removed, which only its history (or a goal or share naming it) still mentions; `null` when nothing stored says. |
| `item_id` | The connection it belongs to, or `null` if unknown. |
| `institution_name`, `institution_id` | Its bank. |
| `connected` | Whether its connection is still linked. |
| `name`, `official_name` | Its names at the bank. |
| `type`, `subtype` | Plaid's kind of account: `depository`, `credit`, `loan`, `investment` or `other`, and for example `checking`. |
| `mask` | The last digits of the account number. |
| `currency` | Its currency code, when known. |
| `credit_limit` | A card's credit line, when known. |
| `persistent_account_id` | Plaid's id for the account across reconnects, where the bank offers one. |
| `first_seen`, `last_seen` | The first and last day Nya knew the account. |
| `hidden`, `hidden_at` | Whether you hid it, and when. Hiding one id of an account you linked hides every id it has had. |
| `latest_balance` | `{ balance, date }`: its newest recorded balance (never an estimate) and the UTC day it was recorded, or `null`. |

An account known only by its id has `null` for everything Nya never learned about it.

### `manual_accounts[]`

`account_id`, `name`, `institution_name`, `type`, `subtype` (`cash` for one you marked as cash on hand, with the type `depository`), `balance` (as you last set it or pushed it), `updated_at` (when that was), and `hidden`, `hidden_at`. Manual balances carry no currency; the app shows them in US dollars.

### `hidden_accounts[]`

What you hid, as stored: `account_id`, `type` (kept so a hidden account can be taken out of past totals even while its bank is unreachable), `hidden_at`.

### `net_worth_history`

```json
{ "includes_hidden_accounts": true, "points": [{ "date": "2026-01-01", "total": 1000, "kind": "recorded" }] }
```

One point per day. `kind` is `recorded` for a total Nya measured that day, or `estimated` for one reconstructed from your transactions for a day before it started recording (or a day it couldn't record). Where a day has both, the recorded total is given and the estimate, superseded, is not.

**Totals include hidden accounts.** Hiding takes an account out of what the app shows, not out of what was recorded, so unhiding brings it back exactly. On a recorded day, the total the app charts is this total minus each hidden account's balance that day from `account_history` (plus it, for a hidden credit card or loan, whose balance was subtracted). On an estimated day the app also takes out a balance the estimate held flat, which is not in this file; it leaves out a day where it can't tell what a hidden account held; and it draws a straight line between two recorded days in place of the estimates between them. So the chart can differ from these totals on estimated days. (Forgetting a hidden earlier account takes it out of the stored totals for good, so a forgotten account is in neither.)

### `account_history[]`

```json
{ "account_id": "...", "points": [{ "date": "2026-01-01", "balance": 1500, "kind": "recorded" }] }
```

Each account's own balance by day, one point per day, by the same rules the app's account chart uses: a balance measured on a day one of your banks failed (so no total was recorded) counts as recorded, and comes before the recorded map for that day; then the recorded map; then the estimate (the newer of the two estimate layers first). A day whose recorded map doesn't name the account has no point: it wasn't there that day. Accounts you linked across a reconnect keep their own ids here; the app joins them using `account_links.links`.

### `transactions[]`

Every transaction stored from your banks, all of history (not just the year the Activity tab shows), newest first. Each has every field Nya stores, as Plaid sent it (transactions you entered by hand are in [`manual-transactions`](#manual-transactions)):

| Field | Meaning |
| --- | --- |
| `transaction_id` | Plaid's id. |
| `pending_transaction_id` | On a posted transaction, the pending one it replaced. |
| `account_id` | The account. |
| `amount` | Plaid's sign: positive is money out. |
| `iso_currency_code`, `unofficial_currency_code` | Its currency (the second for ones without an ISO code, such as crypto). |
| `date` | The posting date. |
| `authorized_date`, `authorized_datetime`, `datetime` | When it happened, where the bank says. |
| `name` | The bank's own description of it. |
| `merchant_name`, `merchant_entity_id`, `website`, `logo_url` | The merchant as Plaid identified it. |
| `personal_finance_category` | Plaid's category: `primary`, `detailed` and `confidence_level`. |
| `personal_finance_category_icon_url` | Its icon. |
| `pending` | Not yet posted. |
| `payment_channel` | `online`, `in store` or `other`. |
| `transaction_code`, `transaction_type` | The bank's kind of transaction, where given. |
| `check_number`, `account_owner` | Where given. |
| `location` | `address`, `city`, `region`, `postal_code`, `country`, `lat`, `lon`, `store_number`. |
| `payment_meta` | `reference_number`, `ppd_id`, `payee`, `by_order_of`, `payer`, `payment_method`, `payment_processor`, `reason`. |
| `counterparties` | Who was on the other side: each with `name`, `type` (`merchant`, `payment_app`...), `entity_id`, `website`, `logo_url`, `confidence_level`. |
| `category` | Plaid's primary category, in words (`food and drink`). |
| `account_name`, `institution_name` | As they were when the transaction was stored. |

Transactions stored before Nya kept every field carry only the date, description, amount, pending flag, category and names; the rest is `null`.

And what Nya adds, your own edits beside the bank's, never over them:

| Field | Meaning |
| --- | --- |
| `item_id` | The connection it came from. |
| `vendor_key` | The merchant's key for renames: `mid:<merchant id>`, or `nm:<institution>::<name>` without one. |
| `your_category` | A category you set on this transaction, or `null`. |
| `your_category_from_earlier_account` | A category you set on the same transaction under an earlier account you linked to this one, or `null`. |
| `your_merchant_name` | Your name for this merchant, or `null`. |
| `superseded_by_posted` | A pending transaction its posted one replaced. The app hides these so nothing counts twice. |
| `account_hidden` | Its account is hidden. |

The app shows `your_category`, else `your_category_from_earlier_account`, else `category`; and `your_merchant_name`, else `merchant_name`, else `name`.

### `category_overrides[]` and `merchant_renames[]`

Every category you set (`transaction_id`, `category`), including any whose transaction is no longer stored (the bank removed it), and every merchant you renamed (`vendor_key`, `name`).

### `investment_transactions[]`

Every stored investment transaction, newest first, with every field Plaid sent (`investment_transaction_id`, `account_id`, `security_id`, `date`, `name`, `quantity`, `price`, `amount`, `fees`, `type`, `subtype`, `iso_currency_code`, `unofficial_currency_code`, `cancel_transaction_id`), and:

| Field | Meaning |
| --- | --- |
| `item_id` | The connection it came from. |
| `security` | The security as Plaid described it: `name`, `ticker_symbol`, `type`, `is_cash_equivalent`, `cusip`, `isin`, `iso_currency_code`; or `null`. |
| `seen_at` | The last day a sync returned it. |
| `missing_since` | When a complete check of its dates first didn't return it, or `null`. |
| `excluded` | The app leaves it out: two complete checks a day apart didn't return it, or the bank cancelled it. It is kept, not deleted, and comes back if the bank returns it. |
| `cancelled` | The bank sent a cancellation for it. |

### `investment_history_coverage[]`

`item_id`, `account_id`, `from`, `through`: the days for which the stored investment transactions of that account were checked complete. Outside them, a quiet month and an unfetched one look the same.

### `account_links`

| Field | Meaning |
| --- | --- |
| `links[]` | `earlier_account_id`, `account_id` (what it is linked to), `linked_at`, and `evidence` (what the offer was based on when you linked it). |
| `declined_suggestions[]` | `earlier_account_id`, `account_id` (the offer you said wasn't the same account, or `null` for "None of these"), `declined_at`. |
| `carried_categories[]` | For each earlier account: `rows[]` of `date`, `amount`, `description` (the bank's, lower-cased) and `category`, the categories you set before it was reconnected. `category` is `null` where two identical transactions were categorized differently, so nothing carries. |

### `budgets[]` and `goals[]`

Budgets: `category`, `monthly_amount`. Goals: `id`, `name`, `target`, and `account_id` (the account it tracks, or `null`).

### `api_tokens[]`

The tokens you made for the read-only API and the MCP server (see `/developers` in the app), oldest first: `label` (the name you gave it), `created_at`, and `last_used_at` (when it last read your data, to within a minute, or `null` if never). Never the token, the hash Nya keeps of its secret, or its id; revoked tokens are gone, and so are their entries. Read as strictly as every other part: a token whose record can't be read stops the download, naming API tokens, until you remove it on the API tokens card.

### `sharing`

`null` with the shared password, unless records of showings from when it had accounts are still stored (then only `unmatched` has anything in it). With Clerk, your side of each connection, never theirs, and both records of when what was shared on it was shown (`lib/access-log.ts`): yours, and theirs of showings to you, which is about you, and the same one they see.

| Field | Meaning |
| --- | --- |
| `connections[]` | `name` (what you call them), `my_introduction` (the name you gave when connecting), `connected_at`, `shared[]` (`account_id` and `level`: `exists`, `balance` or `transactions`), `shared_updated_at`, `shared_until` (when what you share with them ends, a time that may have passed, from which on they see none of it, or `null` for no end), `record_since` (when the records on it began, or `null` before the first showing on a connection from before records, or when its record id can't be read), `shown_to_them` (each time what you share was shown to them: your record) and `shown_to_me` (each time what they share was shown to you: their record). |
| `blocked[]` | `name`: people you blocked, by what you called them. |
| `unmatched[]` | Records of yours that no connection in the file is matched to: `shown_to_them`, or `null` with `problem`. Either a connection's that has ended, until the nightly pass deletes it (a removal deletes its records at once; one that stopped part way leaves them to that pass), or the record of a connection whose record id can't be read, which that connection says (`record_id_unreadable`): which record is its can't be known then, so it is here rather than called ended. |

Each record is a list, oldest first, of the quarter hours (UTC) in which something was shown: `at` (the quarter hour's start), `times` (how many times it was shown in it) and `read` (what was shown: each account's id, at the widest level shown in that quarter hour). It holds what was counted, and only since `record_since`: an empty list means nothing was recorded, not that nothing was looked at. A record that can't be read is `null`, with `shown_to_them_problem`, `shown_to_me_problem` or `problem` saying why: `unreadable` (damaged), `unrecognised` (saved by a version of Nya this one doesn't know), `unavailable` (their container couldn't be reached: being deleted or restored), or `record_id_unreadable` (the connection's record id is damaged, so its records can't be found by it; yours, if there is one, is among `unmatched`). A record holds the last 90 days at most: a showing drops older quarter hours from its record, and so does the nightly pass. What is still stored is in the file, all of it.

No id is in it. A connection's id is made from the two people's sign-in ids, so it stays in the app, and the records are kept under a random id each connection gets, which says nothing either; each record is beside the connection it belongs to.

### Stores built on the storage seam

Newer stores are built on the storage seam (`lib/repo.ts`, see [architecture.md](architecture.md#storage-seam)), and each one declares whether it belongs in this download. Each that does is a field of its own, named after the store, after `sharing`: a store holding one value has that value (`null` if you never saved one), and a store holding one value per id has a list of `{ "id": ..., "value": ... }`, in id order. Values are as the store keeps them. They are read as strictly as everything else: if any entry can't be read, nothing is downloaded and the error names the store. They are in the JSON file only.

#### `allocation-settings`

What you set under Allocation on the Plan tab ([features.md](features.md#allocation)), or `null` if you never set anything: only your choices, never an allocation Nya worked out.

| Field | Meaning |
| --- | --- |
| `v` | The shape's version: 1. |
| `buckets[]` | The tax bucket you gave an account, over what its type says: `account_id`, and `bucket`, one of `taxable`, `tax-deferred`, `roth`, `hsa` or `education`. |
| `funds[]` | The split you gave a security: `ticker` (as Plaid sends it, upper case, up to 40 characters), or `name` for one with no ticker (up to 200), and `split`. |
| `accounts[]` | The split you gave an account's money that no position it lists explains (a manual investment account, say): `account_id` and `split`. |
| `target` | Your target allocation, a `split`, or `null`. |

A `split` is percents by asset class, each above 0 with at most one decimal, adding up to 100: `us-stocks`, `intl-stocks`, `stocks` (stocks of any region), `bonds`, `cash`, `real-estate`, `crypto` and `other`. A class it doesn't name holds none: `{ "us-stocks": 60, "bonds": 40 }`.

#### `connection-notices`

The record of each problem with one of your bank connections that Nya kept for its emails (#51): one entry per connection that has a problem now, under the connection's `item_id`. It goes once the connection works again, or is reconnected or removed.

| Field | Meaning |
| --- | --- |
| `episode` | An id Nya made for this problem, which the email's idempotency key is built from. |
| `since` | When the daily job first saw it. |
| `state` | What it was when last seen: `reconnect_soon`, `needs_reauth`, `outage`, `relink` or `closed` ([Connection health](features.md#connection-health)). |
| `side` | Whose side it was on then: `you`, `bank`, `plaid`, `nya` or `unknown`. Absent from a record kept before it was. |
| `notified_at` | When Nya last emailed you about it, or `null` if it hasn't. |
| `reminded_at` | When it sent that email's one reminder, or `null`. |
| `told` | The states its emails were about, in order. Absent from a record kept before it was. |
| `due_since` | When its next email first became due, while it hasn't gone. |
| `held_at` | When that email was held back, because the same problem reached several accounts at once and looked like a fault in Nya's setup or at Plaid. It goes three days later if the problem is still there. |

#### `connection-syncs`

When each of your bank connections last answered without an error, under its `item_id`: `at`, a time. It is the "Last synced" date on the Connection health card. It goes when the connection is removed.

#### `connection-warnings`

Plaid's warnings that a working connection is going to end, under its `item_id`, as Nya recorded them from Plaid's webhook. It goes once the connection is reconnected or removed, or answers past the end it named.

| Field | Meaning |
| --- | --- |
| `kind` | `pending_expiration`: the consent you gave the bank runs out. `pending_disconnect`: the bank is ending the connection. |
| `received_at` | When the first warning arrived. |
| `ends_at` | When the connection ends: Plaid's time for a pending expiration; for a pending disconnect, which carries none, Nya's estimate, a week after the warning. |
| `ends_estimated` | Whether `ends_at` is Nya's estimate. |
| `reason` | Plaid's reason for a pending disconnect (`INSTITUTION_MIGRATION`), or `null`. |

#### `fire-plan`

The Plan tab's saved assumptions (`lib/fire/plan.ts`), or `null` if you never saved any. Only what you chose or typed: nothing Nya measures, and no result. A plan saved by an earlier release comes with any field added since filled in, as the tab reads it.

| Field | Meaning |
| --- | --- |
| `version` | The shape's version: 1. |
| `age`, `targetAge` | Your age and the age you plan to stop working, or `null`. |
| `spending`, `savings`, `assets` | A figure you typed over Nya's, or `null` to use what Nya measures. |
| `includeCash` | Whether checking and savings count as invested. |
| `withdrawalRate`, `realReturn`, `taxRate` | Fractions: `0.04` is 4%. |
| `partTimeIncome` | Barista FI's part-time income a year, after tax; 0 leaves it out. |
| `method`, `rule`, `start`, `startBalance`, `horizon` | The simulation: `historical` or `monte-carlo`, the withdrawal rule, where it starts (`fi-number`, `assets`, or `custom` with `startBalance`), and its length in years (`null` runs to age 95). |
| `stocksPct`, `bondsPct`, `rebalance`, `fee`, `floor`, `ceiling` | The mix in whole percents (cash is the rest), how often it is rebalanced, the fund fee, and the floor and ceiling rule's bounds. |
| `income[]` | `id`, `label`, `amount` a year after tax, `fromAge`, `inflationAdjusted`. |
| `expenses[]` | `id`, `label`, `amount`, `atAge`. |
| `planFunding[]` | How you said each workplace plan is paid into: `account_id`, and `paidFrom`, `payroll` or `bank`. A plan not listed is not set. |

#### `holdings:history`

What each investment account held, day by day, as recorded from Plaid's holdings (see [architecture.md](architecture.md#holdings-history)): one entry per month, under a random id, with the month inside it. Plaid keeps no past holdings, so this starts on the day Nya first recorded them.

| Field | Meaning |
| --- | --- |
| `v` | The shape's version: 1. |
| `month` | The month, `YYYY-MM`. |
| `securities[]` | Every security a position that month names, once each: `security_id` (Plaid's), `ticker`, `name`, `security_type` and `is_cash_equivalent`, as last described that month, each `null` where Plaid gave none. A position names its security by its place in this list, counting from 0. |
| `days` | Each recorded UTC day (`YYYY-MM-DD`), and in each, every account recorded that day by its id: `observed_at` (when that day's latest observation was taken) and `positions[]`. |
| `positions[]` | `security` (its place in `securities`), `quantity`, `price` (the institution's), `price_as_of` (the day that price was current, when the institution says), `value`, `cost_basis`, `currency` (the ISO code), and `unofficial_currency` only when Plaid gave one (a cryptocurrency, say). A figure Plaid didn't give is `null`. |

An account with an empty `positions[]` was listed by that day's holdings answer with no positions, which is not to say it held nothing: money an institution doesn't list as a position (cash, often) has none, and the account's balance that day is in `account_history`. A day missing for an account was not recorded: its institution couldn't be reached, say, or its answer was incomplete, which is never recorded as a whole day. Hidden accounts are here like the others (see `hidden_accounts`). Account ids are as recorded: positions recorded under an account's earlier id, before a reconnect, keep that id, and `account_links` says which ids are the same account.

#### `manual-transactions`

Transactions you entered by hand on manual accounts (`lib/manual-txns.ts`), all of them, not just the year the Activity tab shows. One entry per manual account: `id` is the account's id (as in `manual_accounts`), and `value` holds `version` (the shape's version: 1) and `rows`, the account's transactions in the order they were added:

| Field | Meaning |
| --- | --- |
| `id` | The transaction's id: `manual-txn:` and a random id. It is its `transaction_id` in the app, and the key of anything said about it in `transaction-annotations`. |
| `account_id` | The manual account. |
| `date` | The day it happened, as you entered it. |
| `amount` | Plaid's sign: positive is money out. |
| `currency` | Its currency's ISO 4217 code. |
| `name` | Who was paid, or who paid you. |
| `category` | Its category, or `null`. |
| `note` | Your note, or `null`. |
| `source` | Where it came from: `manual` for one entered in the app. |
| `source_id` | The source's own id for it, from an import; `null` for one entered by hand. |
| `import_id` | The import it came in with, so that import can be taken out whole; absent or `null` for one entered by hand (no import exists yet: #43). |
| `balance_update` | When adding it also updated the account's balance: `from`, the balance the form showed, `to`, the one it became, and `account_id`, the account whose balance it was (absent on one noted before that was kept). Absent otherwise. |
| `created_at`, `updated_at` | When it was entered, and last changed. |

Adding one doesn't change the account's balance unless you asked, so the rows need not add up to it: the balance is in `manual_accounts`, its history in `account_history`.

#### `transaction-annotations`

What you said about a transaction (`lib/txn-annotations.ts`), one entry per transaction: `id` is its transaction id (a bank's, as in `transactions`, or a manual one's, as in `manual-transactions`), and `value` holds `excluded` (`true` when you left it out of budgets and reports, `false` when you put it back) and `updated_at`. A transaction you said nothing about has no entry. One whose transaction no longer exists (the bank removed it) is kept until you change it; those of an institution you disconnect go with it, after the ones you excluded are kept in `carried-annotations`.

#### `carried-annotations`

Transactions you excluded at an institution you have since disconnected, kept so that linking a re-added account to the old one excludes them again (`lib/txn-annotations.ts`, as categories carry: `account_links.carried_categories`). One entry per earlier account: `id` is its account id, and `value` holds `version` (1) and `rows`, keyed by the transaction's account, date, amount in cents and the bank's own description (lower-cased), joined by `|`, each `{ "excluded": true }`, or `null` where two identical transactions were excluded only one way, so nothing carries. Forgetting the earlier account deletes its entry.

## The CSV files

Both follow RFC 4180: a header row, records ending in CRLF, and a field holding a comma, a double quote or a line break enclosed in double quotes, with quotes inside doubled. UTF-8, starting with a byte order mark (the bytes `EF BB BF`), which is how Excel on Windows knows the file is UTF-8 and shows accented and non-Latin merchant names as they are. Spreadsheets and most CSV readers skip the mark; in Python, open the file with `encoding="utf-8-sig"`.

**Formula guard.** A spreadsheet runs a cell that starts with `=`, `+`, `-` or `@` as a formula, and a leading tab or carriage return can smuggle one in too. Merchant names and bank descriptions come from outside, so any cell that starts with one of those and isn't a number gets a `'` in front of it, which makes the spreadsheet treat it as text. The `'` is not part of the data (the JSON file has the value as stored). Negative amounts are numbers and are left alone.

### `nya-transactions-<date>.csv`

One row per transaction stored from your banks, newest first, with the [transaction fields](#transactions) flattened (transactions you entered by hand are in the JSON file, under [`manual-transactions`](#manual-transactions)). Columns, in order:

`date`, `account_name`, `institution_name`, `name`, `merchant_name`, `your_merchant_name`, `amount`, `iso_currency_code`, `category`, `your_category`, `your_category_from_earlier_account`, `category_detailed`, `category_confidence`, `pending`, `superseded_by_posted`, `account_hidden`, `authorized_date`, `datetime`, `authorized_datetime`, `payment_channel`, `transaction_code`, `transaction_type`, `check_number`, `account_owner`, `website`, `location_address`, `location_city`, `location_region`, `location_postal_code`, `location_country`, `location_lat`, `location_lon`, `location_store_number`, `payment_reference`, `payment_processor`, `payment_payee`, `payment_payer`, `payment_method`, `counterparties` (each as `name (type)`, separated by `; `), `unofficial_currency_code`, `transaction_id`, `pending_transaction_id`, `account_id`, `item_id`, `merchant_entity_id`, `vendor_key`, `logo_url`, `category_icon_url`.

`amount` keeps Plaid's sign (positive is money out). To total your spending, leave out rows where `superseded_by_posted` is `true`.

### `nya-balances-<date>.csv`

Oldest day first; on each day the net-worth row comes before the accounts. Columns:

| Column | Meaning |
| --- | --- |
| `date` | The UTC day. |
| `record` | `net_worth` for the day's total, `account` for one account's balance. |
| `account_id`, `account_name`, `institution_name`, `account_type` | The account (empty on `net_worth` rows). |
| `balance` | The total, or the account's balance (positive is owed for credit and loans). |
| `currency` | The account's currency, when known. |
| `kind` | `recorded` or `estimated`. |
| `account_hidden` | The account is hidden (empty on `net_worth` rows). |

`net_worth` rows include hidden accounts, as [stored](#net_worth_history). Don't add `account` rows to `net_worth` rows: the total already counts them.

## Every stored key, and where it goes

Each key a person's container can hold, and what the download does with it. The same list is `STORED_KEYS` in `lib/user-export.ts`, and a test fails if the code builds a container key that isn't on it, so a new store can't go missing from downloads unnoticed.

| Key | In the download |
| --- | --- |
| `plaid:items` | `institutions` (the access token in each record is left out) |
| `accounts:meta`, `accounts:directory` | `accounts` |
| `manual:accounts` | `manual_accounts` |
| `hidden:accounts` | `hidden_accounts`, and `accounts[].hidden` |
| `history:net-worth`, `history:net-worth:est` | `net_worth_history` (recorded, estimated) |
| `history:accounts`, `history:accounts:partial` | `account_history` (recorded) |
| `history:accounts:est`, `history:accounts:est:ext` | `account_history` (estimated) |
| `history:accounts:est:flatd`, `history:accounts:est:flat` | Left out: balances an estimate held flat (see above) |
| `txns:<connection>` | `transactions` (the sync cursor, and when Plaid last refused its transactions, are left out) |
| `invtxns:<connection>` | `investment_transactions`, `investment_history_coverage` |
| `txn-category-overrides` | `category_overrides`, and `transactions[].your_category` |
| `txn-vendor-renames` | `merchant_renames`, and `transactions[].your_merchant_name` |
| `txn-category-carry` | `account_links.carried_categories`, and `transactions[].your_category_from_earlier_account` |
| `account-links`, `account-links:dismissed` | `account_links.links`, `account_links.declined_suggestions` |
| `budgets`, `goals` | `budgets`, `goals` |
| `txns-blocked:`, `txns-unsaved:` | `notes`, when a store is behind what the app showed |
| `cache:`, `accounts:vanished`, `plaid:new-accounts`, `history:backfill-done`, `history:backfill-pending`, `history:forgetting:`, `invtxns-lock:`, `account-links:lock`, `sessions:`, `snapshot:`, `move:` | Left out: the app's machinery |
| Stores built on the storage seam (`lib/stores.ts`) | Each one declared exportable: a field of its own ([above](#stores-built-on-the-storage-seam)), unless a part of the file above has it already: `sharing-access-log`, your records of when what you share was shown, is in [`sharing`](#sharing). The others are left out: `api-tokens`, whose hashes are credential material (each token's name and dates are in [`api_tokens`](#api_tokens) instead), `api-requests` and `download-count`, the counters behind each API token's requests a minute and the five downloads an hour, and `holdings:history:index`, which says only which id each month of `holdings:history` is stored under and the first and last day each account was recorded, both of which the months themselves hold. |

Sharing settings are not in your container (connections are between two people) and are read as your side only. Your records of when what you share was shown are in your container (`sharing-access-log`, a store on the seam); the other person's record of when what they share was shown to you is in theirs, and read from there, as they see it.

## How it differs from the operator backup

There are two exports, and they are kept apart on purpose (#55): one that did both jobs would be too decrypted to be safe, or too complete to be portable.

| | Download my data | Operator export and nightly backup |
| --- | --- | --- |
| For | You, to keep or take elsewhere | Whoever runs Nya, to recover from losing the database |
| Covers | One person | The whole environment, every person |
| Values | Decrypted, in documented fields | Encrypted, byte for byte as stored, and unreadable without the keys; dates, account and transaction ids, bank names and the merchant names you renamed are in plain text ([operations.md](operations.md#taking-a-backup-by-hand)) |
| Formats | JSON, CSV | NDJSON of raw database keys, with a checksum |
| Leaves out | Credentials and the app's machinery | Only what would be wrong after a restore (caches, locks, counters, job records) |
| Restores | Not yet: an import is planned (#43) | `bun run restore` ([operations.md](operations.md#restoring-a-backup)) |
| Gets it | You, after a fresh sign-in, 5 an hour | The operator, with `OPS_SECRET`, or the nightly cron |

Deleting your account deletes your data now, and the nightly backups expire it later; the receipt at the end gives the date ([authentication.md](authentication.md#deleting-an-account)). A file you downloaded is yours, and deleting your account doesn't reach it.

## Adding a store

A new store is built on the storage seam (`lib/repo.ts`), and declaring it `exportable: true` is all it takes to be in this download: `declaredSections()` in `lib/user-export.ts` gives it a field of its own and reads it strictly, unless an entry of `SECTIONS` exports it itself and names it in `covers` (as `sharing` does `sharing-access-log`, to put each record beside its connection). Describe what it holds on this page. Its name must not be one the file already uses (`notes`, `accounts`), which would fail every download; `test/user-export.test.ts` checks that.

The older stores are read by hand. One that stands alone (nothing else needs to read it to build the file) is an entry in `SECTIONS`: its key in the file, its name for errors, a strict reader (one that throws on anything it can't read) that returns the store already in its exported shape, and, if it names accounts, which ids it names, so `accounts` lists them. Its key goes in `STORED_KEYS`. A store the core sections cross-reference (accounts, history, transactions) is read in `collectUserData` and built in `buildUserExport`.
