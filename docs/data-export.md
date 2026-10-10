# Downloading your data

Everything Nya stores about you can be downloaded, decrypted, in open formats: one JSON file with all of it, CSV files of your transactions and your balance history for a spreadsheet, or one bank account's or card's transactions as an OFX statement for another money app. Any of them can be protected with a passphrase. This page says how to get it, what is in it field by field, what is left out and why, and how to open a protected file. The code is `lib/user-export.ts` (with `lib/ofx-export.ts` for OFX and `lib/protected-download.ts` for the passphrase), the route `app/api/my-data/route.ts`, and the card `components/DownloadMyData.tsx`.

- [Getting a copy](#getting-a-copy)
- [What is not in it](#what-is-not-in-it)
- [Conventions](#conventions)
- [The JSON file](#the-json-file)
- [The CSV files](#the-csv-files)
- [One account as OFX](#one-account-as-ofx)
- [Protecting the file with a passphrase](#protecting-the-file-with-a-passphrase)
- [Every stored key, and where it goes](#every-stored-key-and-where-it-goes)
- [How it differs from the operator backup](#how-it-differs-from-the-operator-backup)
- [Adding a store](#adding-a-store)

## Getting a copy

On the Accounts tab, tap **Manage**, then **Download my data** at the bottom. Pick a format:

| Format | File | What it holds |
| --- | --- | --- |
| Everything (JSON) | `nya-data-<date>.json` | Every part described below. |
| Transactions (CSV) | `nya-transactions-<date>.csv` | Every transaction, one per row: those stored from your banks, and those on manual accounts, entered by hand or imported. |
| Balance history (CSV) | `nya-balances-<date>.csv` | Net worth and each account's balance, day by day. |
| Bank or card statement (OFX) | `nya-<institution>-<account>-<date>.ofx` | One bank account's or card's posted transactions, for another money app, or to import into Nya again ([below](#one-account-as-ofx)). |

Any of them can be **protected with a passphrase**: it is then saved encrypted, with `.age` at the end of its name ([below](#protecting-the-file-with-a-passphrase)).

**A fresh sign-in comes first.** With Clerk, the download needs a sign-in verified in the last ten minutes (Clerk's "strict" level: the second factor if the account has one, the first otherwise). If yours is older, Clerk's own window asks you to confirm it is you, and the download carries on. With the shared password, the card asks for the password again; wrong ones count against the same limit as the login page (10 per IP per 15 minutes), so this can't be used to guess the password faster.

**Five downloads an hour**, per account, whatever the format, protected or not. A sixth is refused with how long to wait. The number is `DOWNLOADS_PER_WINDOW` in `lib/download-limit.ts`, which both the limit and the card's text read.

**An email each time.** With email set up ([deployment.md](deployment.md#email-notices)), each download emails the owner (with Clerk, the account's verified address; with the shared password, `NOTIFY_EMAIL`): when it happened, in UTC, which format, whether a passphrase protects it, and what to do if it wasn't them (sign out every session, and change the password). Never a balance, an amount, an account number, the name of an account or a bank, or anything from the file: a download nobody asked for means someone else has signed in, and the email says only that. The download never waits for the email and never fails because of it: the email is started as the file is, and one that can't be sent is logged with the email service's status alone, never the address or the text. Each download's email has an idempotency key of its own, so the one retry (after a rate limit, no answer, or an error of the email service's own) is delivered once. Making an API token sends the same kind of email (`lib/download-notice.ts`). Without email set up, nothing is sent.

**Nothing missing without a word.** Every store is read before the first byte is sent, and what can't be read is named, not quietly left out (with the two exceptions below). What happens when something can't be read depends on why:

- **The deployment can't read it** (the database out of reach, an encryption key missing or unavailable): nothing is downloaded, and the error says which part, as when anything else goes wrong. Try again later.
- **An entry is damaged, or saved in a form this version of Nya doesn't know** (by a later version, say): the download goes ahead with everything else, and the file names what it is missing under [`problems`](#problems), by part and id, and says so in words under `notes`. The response says so too (**When the file is incomplete**, below), and the card says plainly that the file is incomplete, with what is missing. One damaged record would otherwise stop the download for good, with nothing in the app to clear it. That holds for every store on the [storage seam](#stores-built-on-the-storage-seam), for your balance history (`net_worth_history`, `account_history`), your manual accounts (`manual_accounts`), your budgets and goals (each then `null`), and for the records in [`sharing`](#sharing), each marked where it belongs.
- **An entry of an older store the rest of the file is read against is damaged**: nothing is downloaded, and the error says which part, because left out, such an entry would read as something else elsewhere in the file. Your linked institutions and accounts (an account's balances and transactions with no account to belong to), transactions and investment transactions (the categories, names and exclusions you set on a row pointing at nothing), categories and merchant names (a transaction without the one you set on it), links (one account read as two) and hidden accounts (a hidden account shown as not hidden). These stores join the rest as they move onto the storage seam.

The two exceptions are older readers that pass over, without a word, what they can't parse, as the app itself does, so the file holds what the app shows: sharing's (a connection whose record doesn't parse is left out, a share that doesn't parse reads as sharing nothing, and an account shared at a level this version doesn't know is left out of what you share), and the accounts each bank last reported (a record in the shape used before they were kept per bank, which the app no longer reads, and an account in one without an id or a type). Neither is named under `problems` yet.

Nothing is removed or changed either way: what can't be read stays stored as it was, and the download only reports it. Without `MASTER_KEY` ([deployment.md](deployment.md#3-environment-variables)), a damaged value can't be told from a replaced `PLAID_ENCRYPTION_KEY`, which would make every value fail alike, so it stops the download as the deployment's problem rather than being reported as damage.

**A whole file or none.** Before sending anything, the route writes the file out once only to count its bytes, keeping none of them, then streams it, and says how many bytes to expect twice: `Content-Length`, and `X-Nya-Export-Bytes`, the same number, which is the one the page checks (a proxy that compresses the response changes or drops `Content-Length`, and leaves this one alone). The page counts what arrives and saves the file only when that count is there and matches; otherwise it saves nothing and says the download was cut off, to try again. So a connection that drops part way, or a response ended early by the platform or a proxy, never leaves a short file that looks whole. The route may run for up to 300 seconds, for a large file over a slow connection.

**When the file is incomplete.** The response carries `X-Nya-Export-Incomplete`: the parts of the JSON file this file is made from that are missing something, by their keys, separated by commas (`manual_accounts, holdings:history`), and `X-Nya-Export-Notes`, the notes that say what is missing in words (a URL-encoded JSON list, as the caveats travel). Both are there for a CSV and an OFX statement too, which have nowhere inside to say it, and for a protected file, which can't be read until it is opened, but only for the parts the file is made from: a transactions CSV is never called incomplete for a holdings record it doesn't hold. A CSV's notes say what that CSV lacks (for a manual account that can't be read, the name on its rows) and point to the JSON download for the list. Neither header is sent with a whole file. The card shows the notes, after a line saying the file is incomplete.

**How big.** About 1.7 KB of JSON per transaction, and about 0.6 KB in the transactions CSV; history adds little. An account with 60,000 transactions and ten years of daily balances for 20 accounts comes to about 106 MB of JSON, 34 MB of transactions CSV and 7 MB of balance history CSV.

**Never written down.** The stores are read and decrypted in memory, and the file's text is written out a piece at a time as it streams to your browser (encrypted as it goes, when a passphrase protects it), never held whole on the server. Nothing writes it to storage, a log or a blob store on the way, and the response tells caches not to keep it. Unless you protect it with a passphrase, the file itself is not encrypted, so keep it somewhere safe.

**Not built yet.** Bringing a download into another copy of Nya, or into a new account: restoring from this file is planned (#43). Until then, an OFX statement imports into a manual account ([features.md](features.md#importing-files)).

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
| `version` | `2`. It goes up when a field is removed or changes meaning; an added field leaves it alone. Version 2 is the file that names what it couldn't read under `problems` instead of not being made at all: since then a part can be short, and `budgets`, `goals` and a value store's field can be `null`, because something couldn't be read, which only `problems` tells apart. A reader written for version 1, which was whole or not made, could take such a file as whole. |
| `exported_at` | When the file was made. |
| `documentation` | A link to this page. |
| `not_included` | What the file leaves out, and why ([above](#what-is-not-in-it)). |
| `notes` | Caveats about this download, if any: for example that the newest transactions from an institution could not be saved, so they may be missing, or that part of the file is missing what couldn't be read (one note for each such part). Usually empty. |
| `problems` | What is stored but couldn't be read into the file ([below](#problems)). Usually empty. |
| `institutions` | Your linked connections. |
| `accounts` | Every account the file mentions anywhere, apart from the manual accounts you have now. |
| `manual_accounts` | Accounts you track by hand. |
| `hidden_accounts` | Accounts you hid. |
| `net_worth_history` | Your net worth by day. |
| `account_history` | Each account's balance by day. |
| `transactions` | Every transaction stored from your banks. Those on manual accounts, entered by hand or imported, are in `manual-transactions`. |
| `category_overrides` | Every category you set on a transaction. |
| `merchant_renames` | Every merchant you renamed. |
| `investment_transactions` | Every stored investment transaction. |
| `investment_history_coverage` | Which days the stored investment transactions are known to be complete for. |
| `account_links` | Accounts you linked across a reconnect, offers you declined, and categories carried across. |
| `budgets` | Your monthly budgets. |
| `goals` | Your savings goals. |
| `api_tokens` | The API tokens you made, by name, with when each was made and last used. |
| `sharing` | Your side of sharing, with both records of when shared accounts were shown on each connection; `null` with the shared password, unless records from before are still stored. |
| *each store on the storage seam* | Then one field per store built on the storage seam and declared exportable, named after the store, in name order ([below](#stores-built-on-the-storage-seam)). Today: `allocation-settings`, `carried-annotations`, `connection-notices`, `connection-syncs`, `connection-warnings`, `fire-plan`, `holdings:history`, `import-settings`, `imports`, `manual-transactions`, `planned-items` and `transaction-annotations`. (`sharing-access-log` is in `sharing`.) |

### `problems`

Empty when the file has everything. Otherwise one entry for each part of the file that is missing something, and each reason, in the order the parts come:

```json
{ "section": "holdings:history", "problem": "unreadable", "ids": ["4f6c0d2e-...", "9a1b..."] }
```

| Field | Meaning |
| --- | --- |
| `section` | The part of the file: its field, such as `manual_accounts`, `account_history` or `holdings:history`. |
| `problem` | `unreadable`: the stored data is damaged, so nothing in it can be read, by this version of Nya or any other. `unrecognised`: it looks intact, but was saved in a form this version of Nya doesn't know (a later version may have written it); it is kept as it is, and a version that knows it reads it. In `sharing`, also `unavailable` and `record_id_unreadable` ([below](#sharing)). |
| `ids` | What is missing, by the id it is stored under, in order: an entry's `id` for a store on the storage seam, a UTC day (`YYYY-MM-DD`) for `net_worth_history` and `account_history`, an account's id for `manual_accounts`. Absent for a part that is one value (`budgets`, `goals`, `allocation-settings`, `fire-plan`, `planned-items`), which is then `null` in the file, for `sharing`, which names no ids and marks each record it can't give where it belongs, and for `api_tokens`, which has `count` instead. |
| `count` | How many are missing, in place of `ids`, for a part whose ids are kept out of the file: `api_tokens`, since a token's id is part of the token. |

A day of `net_worth_history` that is named has no point in the file, and no estimate stands in for it (the app's chart has none that day either). A day of `account_history` that is named is one whose stored balances couldn't all be read: a record of that day is damaged or in a form this version doesn't know, or holds a balance that isn't a number (the numbers beside it are in the file). On it an account has the balance another record of that day holds, or none. A recorded day that can't be read gets no estimate in its place; a measurement that can't be read, on a day with nothing recorded, falls back to that day's estimate, marked `estimated`, as the chart does. A manual account that is named is not in `manual_accounts`, nor listed in `accounts` as one since removed; its balance history is still in `account_history`, under its id.

Nothing in `problems` was removed: it is all still stored as it was. Nya doesn't offer to clear damaged records from here. What removing one would do differs from store to store (an exclusion record gone puts a transaction back in your totals; a record of an email gone may send the email again; an import's record gone loses its undo), so a repair belongs where the record is used, as holdings history's is ([architecture.md](architecture.md#holdings-history)) and sharing's is (the Sharing drawer).

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
| `latest_balance` | `{ balance, date }`: its newest recorded balance (never an estimate) and the UTC day it was recorded, or `null`. A recorded day that can't be read is passed over ([`problems`](#problems)), so the date says which day it is. |

An account known only by its id has `null` for everything Nya never learned about it.

### `manual_accounts[]`

`account_id`, `name`, `institution_name`, `type`, `subtype` (`cash` for one you marked as cash on hand, with the type `depository`), `balance` (as you last set it or pushed it), `updated_at` (when that was), and `hidden`, `hidden_at`. Manual balances carry no currency; the app shows them in US dollars. A manual account that can't be read is named under [`problems`](#problems) instead.

### `hidden_accounts[]`

What you hid, as stored: `account_id`, `type` (kept so a hidden account can be taken out of past totals even while its bank is unreachable), `hidden_at`.

### `net_worth_history`

```json
{ "includes_hidden_accounts": true, "points": [{ "date": "2026-01-01", "total": 1000, "kind": "recorded" }] }
```

One point per day. `kind` is `recorded` for a total Nya measured that day, or `estimated` for one reconstructed from your transactions for a day before it started recording (or a day it couldn't record). Where a day has both, the recorded total is given and the estimate, superseded, is not. A day whose total can't be read is named under [`problems`](#problems), and has no point.

**Totals include hidden accounts.** Hiding takes an account out of what the app shows, not out of what was recorded, so unhiding brings it back exactly. On a recorded day, the total the app charts is this total minus each hidden account's balance that day from `account_history` (plus it, for a hidden credit card or loan, whose balance was subtracted). On an estimated day the app also takes out a balance the estimate held flat, which is not in this file; it leaves out a day where it can't tell what a hidden account held; and it draws a straight line between two recorded days in place of the estimates between them. So the chart can differ from these totals on estimated days. (Forgetting a hidden earlier account takes it out of the stored totals for good, so a forgotten account is in neither.)

### `account_history[]`

```json
{ "account_id": "...", "points": [{ "date": "2026-01-01", "balance": 1500, "kind": "recorded" }] }
```

Each account's own balance by day, one point per day, by the same rules the app's account chart uses: a balance measured on a day one of your banks failed (so no total was recorded) counts as recorded, and comes before the recorded map for that day; then the recorded map; then the estimate (the newer of the two estimate layers first). A day whose recorded map doesn't name the account has no point: it wasn't there that day. Accounts you linked across a reconnect keep their own ids here; the app joins them using `account_links.links`. A day whose balances can't all be read is named under [`problems`](#problems).

### `transactions[]`

Every transaction stored from your banks, all of history (not just the year the Activity tab shows), newest first. Each has every field Nya stores, as Plaid sent it (transactions on manual accounts, entered by hand or imported, are in [`manual-transactions`](#manual-transactions)):

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

Budgets: `category`, `monthly_amount`. Goals: `id`, `name`, `target`, and `account_id` (the account it tracks, or `null`). Each is stored as one value: saved but unreadable, or in a form this version doesn't know, it is `null` and named under [`problems`](#problems) (`{ "section": "budgets", "problem": "unreadable" }`), and the rest of the file is still in it. Never saved is an empty list.

### `api_tokens[]`

The tokens you made for the read-only API and the MCP server (see `/developers` in the app), oldest first: `label` (the name you gave it), `created_at`, and `last_used_at` (when it last read your data, to within a minute, or `null` if never). Never the token, the hash Nya keeps of its secret, or its id; revoked tokens are gone, and so are their entries. A token whose record can't be read is left out and counted under [`problems`](#problems), never named by its id (`{ "section": "api_tokens", "problem": "unreadable", "count": 1 }`), and the rest of the file is still in it. The API tokens card lists it too, and can remove a damaged one.

### `sharing`

`null` with the shared password, unless records of showings from when it had accounts are still stored (then only `unmatched` has anything in it). With Clerk, your side of each connection, never theirs, and both records of when what was shared on it was shown (`lib/access-log.ts`): yours, and theirs of showings to you, which is about you, and the same one they see.

| Field | Meaning |
| --- | --- |
| `connections[]` | `name` (what you call them), `my_introduction` (the name you gave when connecting), `connected_at`, `shared[]` (`account_id` and `level`: `exists`, `balance` or `transactions`), `shared_updated_at`, `shared_until` (when what you share with them ends, a time that may have passed, from which on they see none of it, or `null` for no end), `record_since` (when the records on it began, or `null` before the first showing on a connection from before records, or when its record id can't be read), `shown_to_them` (each time what you share was shown to them: your record) and `shown_to_me` (each time what they share was shown to you: their record). |
| `blocked[]` | `name`: people you blocked, by what you called them. |
| `unmatched[]` | Records of yours that no connection in the file is matched to: `shown_to_them`, or `null` with `problem`. Either a connection's that has ended, until the nightly pass deletes it (a removal deletes its records at once; one that stopped part way leaves them to that pass), or the record of a connection whose record id can't be read, which that connection says (`record_id_unreadable`): which record is its can't be known then, so it is here rather than called ended. |

Each record is a list, oldest first, of the quarter hours (UTC) in which something was shown: `at` (the quarter hour's start), `times` (how many times it was shown in it) and `read` (what was shown: each account's id, at the widest level shown in that quarter hour). It holds what was counted, and only since `record_since`: an empty list means nothing was recorded, not that nothing was looked at. A record that can't be read is `null`, with `shown_to_them_problem`, `shown_to_me_problem` or `problem` saying why: `unreadable` (damaged), `unrecognised` (saved by a version of Nya this one doesn't know), `unavailable` (their container couldn't be reached: being deleted or restored), or `record_id_unreadable` (the connection's record id is damaged, so its records can't be found by it; yours, if there is one, is among `unmatched`). A record holds the last 90 days at most: a showing drops older quarter hours from its record, and so does the nightly pass. What is still stored is in the file, all of it. Each kind of record sharing can't give is also named once under [`problems`](#problems) (`{ "section": "sharing", "problem": "unreadable" }`), so the response can say the file is incomplete.

No id is in it. A connection's id is made from the two people's sign-in ids, so it stays in the app, and the records are kept under a random id each connection gets, which says nothing either; each record is beside the connection it belongs to.

### Stores built on the storage seam

Newer stores are built on the storage seam (`lib/repo.ts`, see [architecture.md](architecture.md#storage-seam)), and each one declares whether it belongs in this download. Each that does is a field of its own, named after the store, after `sharing`: a store holding one value has that value (`null` if you never saved one), and a store holding one value per id has a list of `{ "id": ..., "value": ... }`, in id order. Values are as the store keeps them. An entry that is damaged, or saved in a form this version doesn't know, is left out and named under [`problems`](#problems) (a store holding one value is then `null`), and everything else is in the file; storage that can't be reached stops the download, naming the store. They are in the JSON file only, but for `manual-transactions`, whose transactions are in the transactions CSV too.

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

#### `imports`

Each file you imported into a manual account ([Importing files](features.md#importing-files)): one entry per import, `id` the import's own (`import:` and a random id, the `import_id` of the transactions it added in [`manual-transactions`](#manual-transactions)), and `value`:

| Field | Meaning |
| --- | --- |
| `version` | The shape's version: 1. |
| `account_id` | The manual account it was imported into. |
| `format`, `source` | `ofx` (OFX or QFX), `csv` or `qif`, and the `source` its transactions carry (`import:ofx`, `import:csv`, `import:qif`). |
| `file_name`, `file_bytes`, `encoding` | The file's name as your device gave it, its size in bytes, and how its text was read: `utf-8`, `utf-16le`, `utf-16be` or `windows-1252`. The file itself is not kept. |
| `imported_at` | When it was imported. |
| `currency`, `first_date`, `last_date` | The currency most of its transactions are in, and the days they cover. |
| `counts` | `imported` (added), `present` (already in the account), `repeated` (listed twice in the file) and `unreadable` (lines that couldn't be read), and when there were any, `replaced` (transactions already here replaced with the file's version) and `skipped` (rows skipped as you chose). |
| `read` | How it was read: `options`, what you chose (the statement, a CSV's columns by number, how money out is written, the order of the dates, the decimal mark, the currency, whether amounts were read the other way round), and what was found: `date_order`, `date_style` (how most dates were written: `iso`, `compact`, `named`, `mdy` or `dmy`), `decimal`, and a CSV's `delimiter`, `header_line` and the lines `skipped` above it. |
| `statement` | For an OFX file, the statement imported: `kind` (`bank` or `creditcard`), `label`, `bank_id` (its routing number), `mask` (the account number's last four characters: the whole number is never kept), `type`, `currency`, `start` and `end` (the days it covers), and `ledger` (`amount` as the file wrote it, which on a card is negative while money is owed, and `as_of`). For a QIF file holding several accounts, the one chosen (its `label`). `null` otherwise. |
| `columns` | A CSV file's column names, or `null`. |
| `balance_update` | When the import also set the account's balance to the statement's: `from`, `to`, and the statement's `as_of`. Absent otherwise. |
| `records[]` | Every transaction the file held, in file order: `line` (where it starts in the file), `outcome` (`imported`, `present`, `replaced`, `skipped`, `repeated` or `unreadable`), `row_id` (the transaction it became, the one it was found as, the one it replaced, or the one whose bank id it shared when it was skipped), `before` (for `replaced`, that transaction as it was before: `date`, `amount`, `currency`, `name`, `category`, `note` and `transaction_code`, which undoing the import puts back), `reason` (why it couldn't be read, or was skipped), and `raw`, the record as the file had it: an OFX transaction's fields by their tags (`TRNTYPE`, `DTPOSTED`, `TRNAMT`, `FITID`, `NAME`, `MEMO` and any others; an account number in one, a transfer's other account, keeps only its last four characters), a CSV line's cells, or a QIF record's lines, as the file had them. |

A field over 1,000 characters is cut to that length in `raw` (its line wasn't read). Undoing the import deletes its entry, and so does deleting the account. The list of past imports reads a summary of each entry kept beside it (`import-summaries`), which isn't in the download: it holds nothing the entry doesn't, but for `taken_over`, how many transactions an earlier import added were kept for this one when that one was undone, which the transactions themselves show (their `import_id` is this import's).

#### `import-settings`

How the last file imported into each manual account was read, so the next one from the same bank needs no questions: one entry per account (`id` its account id), with `version` (1), `updated_at`, and for each format imported into it:

- `csv`: `columns` (`date`, `description`, `amount` or `debit` and `credit`, `category`, `note` and `currency`, each the name of the column it was read from), `sign` (`negative-out` or `positive-out`: how money out was written in one amount column), `decimal`, `date_order` (`mdy` or `dmy`, or `null` when the dates didn't depend on one), `delimiter` and `currency`.
- `ofx`: `statement`, the account the statement was for (`kind`, `bank_id`, `mask` and `type`, so a file for another account is caught), `flip`, whether amounts were read the other way round, and `currency`, the one chosen for a statement that didn't say its own (absent until then).
- `qif`: `date_order`, `decimal`, `flip` and `currency`.

Deleting the account deletes its entry.

#### `manual-transactions`

Transactions on manual accounts (`lib/manual-txns.ts`), entered by hand or imported from a file, all of them, not just the year the Activity tab shows. One entry per manual account: `id` is the account's id (as in `manual_accounts`), and `value` holds `version` (the shape's version: 1) and `rows`, the account's transactions in the order they were added:

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
| `source` | Where it came from: `manual` for one entered in the app; `import:ofx`, `import:csv` or `import:qif` for one imported from a file. |
| `source_id` | The source's own id for it, which is how a later file recognizes it: an OFX file's FITID; for a CSV or QIF file, which have no ids, what the file said when it was imported (its date, currency, amount in the currency's smallest unit and its description, lower-cased with only letters and digits, joined by `\|`). `null` for one entered by hand. |
| `source_key` | For one imported from an OFX file, the same summary of what the file said, hashed to 16 characters: with the FITID, it tells a later file's version of it that is exactly what was imported, however you changed it since. Absent otherwise. |
| `transaction_code` | Plaid's code for what its file said it was, when the file says so outright: `atm` for an OFX file's ATM transaction, which the spending rules read as they read a bank's. Absent otherwise. |
| `import_id` | The import it came in with (in [`imports`](#imports)), so that import can be taken out whole; absent or `null` for one entered by hand. |
| `balance_update` | When adding it also updated the account's balance: `from`, the balance the form showed, `to`, the one it became, and `account_id`, the account whose balance it was (absent on one noted before that was kept). Absent otherwise. |
| `created_at`, `updated_at` | When it was entered, and last changed in the app. An import that replaces it with its file's version, and the undo of that, leave `updated_at` as it was: neither is your change. |

Adding one doesn't change the account's balance unless you asked, so the rows need not add up to it: the balance is in `manual_accounts`, its history in `account_history`. Each row is also a row of the [transactions CSV](#nya-transactions-datecsv).

#### `planned-items`

What you told the cash forecast (`lib/planned.ts`, [Recurring bills and the cash forecast](features.md#recurring-bills-and-the-cash-forecast)), or `null` if you never saved any: `version` (the shape's version: 1), `items`, `dismissed` and `threshold`. The forecast itself is never stored, so it is not here.

| Field | Meaning |
| --- | --- |
| `items[]` | Each expense or income you planned: `id` (random), `name`, `kind` (`expense` or `income`), `amount` (positive, in `currency`), `currency` (its ISO 4217 code), `date` (the day it falls on, or the first day of one that repeats) and `cadence` (`once`, `weekly`, `biweekly`, `monthly`, `quarterly`, `semiannual` or `yearly`). |
| `dismissed[]` | The detected bills and income you marked not recurring, each as the series was when you did: its kind, institution, account, merchant (lower-cased), currency and amount in cents, joined by `\|`, the amount marked `=` when the series was one of a merchant's subscriptions told apart by amount. Each applies to the series of that account and merchant nearest its amount, or its price before a change: exactly when either is marked so, otherwise within 25% or 50 cents, so it holds as a bill's amount moves. |
| `threshold` | The figure the forecast warns below, as `amount` and the `currency` it was set in (`null` for one saved before currencies were kept, read in the forecast's), or `null` for the default (100 in the forecast's currency). |

#### `transaction-annotations`

What you said about a transaction (`lib/txn-annotations.ts`), one entry per transaction: `id` is its transaction id (a bank's, as in `transactions`, or a manual one's, as in `manual-transactions`), and `value` holds `excluded` (`true` when you left it out of budgets and reports, `false` when you put it back) and `updated_at`. A transaction you said nothing about has no entry. One whose transaction the bank removed goes once a sync saves the removal, as do those of an institution you disconnect, after the ones you excluded are kept in `carried-annotations`; none goes while a store of transactions can't be read, and one saved by a version of Nya this one doesn't know is kept for it.

#### `carried-annotations`

Transactions you excluded at an institution you have since disconnected, kept so that linking a re-added account to the old one excludes them again (`lib/txn-annotations.ts`, as categories carry: `account_links.carried_categories`). One entry per earlier account: `id` is its account id, and `value` holds `version` (1) and `rows`, keyed by the transaction's account, date, amount in cents and the bank's own description (lower-cased), joined by `|`, each `{ "excluded": true }`, or `null` where two identical transactions were excluded only one way, so nothing carries. Forgetting the earlier account deletes its entry.

## The CSV files

Both follow RFC 4180: a header row, records ending in CRLF, and a field holding a comma, a double quote or a line break enclosed in double quotes, with quotes inside doubled. UTF-8, starting with a byte order mark (the bytes `EF BB BF`), which is how Excel on Windows knows the file is UTF-8 and shows accented and non-Latin merchant names as they are. Spreadsheets and most CSV readers skip the mark; in Python, open the file with `encoding="utf-8-sig"`.

**Formula guard.** A spreadsheet runs a cell that starts with `=`, `+`, `-` or `@` as a formula, and a leading tab or carriage return can smuggle one in too. Merchant names and bank descriptions come from outside, so any cell that starts with one of those and isn't a number gets a `'` in front of it, which makes the spreadsheet treat it as text. The `'` is not part of the data (the JSON file has the value as stored). Negative amounts are numbers and are left alone.

### `nya-transactions-<date>.csv`

One row per transaction, newest first: every one stored from your banks, with the [transaction fields](#transactions) flattened, and every one on a manual account, entered by hand or imported ([`manual-transactions`](#manual-transactions)), in the same columns. Columns, in order:

`date`, `account_name`, `institution_name`, `name`, `merchant_name`, `your_merchant_name`, `amount`, `iso_currency_code`, `category`, `your_category`, `your_category_from_earlier_account`, `category_detailed`, `category_confidence`, `pending`, `superseded_by_posted`, `account_hidden`, `authorized_date`, `datetime`, `authorized_datetime`, `payment_channel`, `transaction_code`, `transaction_type`, `check_number`, `account_owner`, `website`, `location_address`, `location_city`, `location_region`, `location_postal_code`, `location_country`, `location_lat`, `location_lon`, `location_store_number`, `payment_reference`, `payment_processor`, `payment_payee`, `payment_payer`, `payment_method`, `counterparties` (each as `name (type)`, separated by `; `), `unofficial_currency_code`, `transaction_id`, `pending_transaction_id`, `account_id`, `item_id`, `merchant_entity_id`, `vendor_key`, `logo_url`, `category_icon_url`, `source`, `note`.

`source` says where a row came from: `plaid` for a bank's; for one on a manual account, `manual` (entered in the app), or `import:ofx`, `import:csv` or `import:qif` (imported from a file). A manual account's row has its own `name` (who was paid, or who paid you), `amount`, `iso_currency_code` (its currency), `category` (its own, so `your_category` is empty) and `note`, the `transaction_code` its file gave (`atm`) where it gave one, and its account's `account_name`, `institution_name`, `account_id` and `account_hidden`, as in `manual_accounts`; the columns only a bank fills are empty, and so is `item_id`, since a manual account has no connection. On the same day, rows with a time come first. A manual account that can't be read leaves its rows' account names empty, and a book of rows that can't be read leaves those rows out; either way the response says the file is incomplete ([above](#getting-a-copy)).

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

`net_worth` rows include hidden accounts, as [stored](#net_worth_history). Don't add `account` rows to `net_worth` rows: the total already counts them. A manual account that can't be read keeps its `account` rows, under its id, with its name empty; when it is hidden, `account_type` and `account_hidden` are still filled in, from `hidden_accounts`. The response says the file is incomplete ([above](#getting-a-copy)).

## One account as OFX

`nya-<institution>-<account>-<date>.ofx`: one bank account's or credit card's transactions as an OFX statement (`lib/ofx-export.ts`), the format most banks let you download, for another money app or to import into Nya again. Choose the account under the format: the card lists your bank accounts and cards, linked and manual, hidden ones too.

**Which OFX, and why.** OFX 1.0.2 in SGML, written as banks write it: the headers, then one tag a line, values without end tags, lines ending CRLF, in Windows-1252 (`ENCODING:USASCII`, `CHARSET:1252`). It is what most banks' downloads are (Quicken's QFX is the same with a tag of its own), so it is what money apps' importers are built and tested against; an app that reads OFX 2 (XML) reads it too, while some readers read only 1.x.

| App | What to expect |
| --- | --- |
| GnuCash | Imports it (File, Import, Import OFX/QFX), and asks once which of its accounts the file's account is. |
| Actual Budget | Imports it into an account, and uses each transaction's FITID to leave out what it already has. |
| YNAB | Its file import takes OFX and QFX files. |
| Quicken | Imports these files only from banks it works with, which it tells by an id their files carry, so it may refuse this one. |
| Monarch | Its import takes CSV files: use the transactions CSV. |
| Nya | Imports it into a manual account, as any bank's file ([below](#bringing-it-back-into-nya)). |

**Which accounts.** A bank account (`depository`) is a bank statement, with `ACCTTYPE` `SAVINGS` for a savings account, `MONEYMRKT` for a money market account and `CHECKING` for every other kind of bank account. A credit card is a card statement. A loan has no statement in OFX 1.0.2, and an investment account's statement lists holdings, trades and the securities they are in, which Nya doesn't write, so neither is offered as OFX rather than passed off as a bank account: their history is in the JSON file, and the route refuses them with a 400 that says so.

**What is in it.**

| | |
| --- | --- |
| Transactions | The account's posted transactions, oldest first: from the bank, or on a manual account entered by hand or imported. Pending ones are left out, and the notes say how many: a bank gives a transaction a new id when it posts, so an app that imported it pending would count it twice. |
| `FITID` | The transaction's own id: Plaid's transaction id, or a manual transaction's `manual-txn:...` id. It doesn't change from one download to the next (until a bank is removed and added back: see `ACCTID`), so importing the same file twice, into Nya or any app that honours FITIDs, adds nothing. |
| `TRNAMT` | OFX's sign, the account holder's: positive is money in, on a card as on a bank account. Nya keeps Plaid's (positive is money out), so each amount is negated. Written with the currency's decimals (two for dollars, none for yen), or more where the amount has them: never rounded. |
| `TRNTYPE` | `CREDIT` or `DEBIT` by that sign, unless the bank said more, through Plaid's transaction code: `ATM`, `FEE` (a bank charge), `XFER` (a transfer), `CHECK` (with `CHECKNUM`, where there is a check number), `INT`, `DIRECTDEBIT` or `REPEATPMT`. Never a guess from a category. |
| `DTPOSTED`, `DTUSER` | The day it posted, and the day it happened where Plaid says and it differs, as the bank's days, written at 10:59 with no time zone (`20260905105900`). OFX reads a time without a zone as GMT, and 10:59 GMT is the same day everywhere from UTC-10 to UTC+13, so an app that turns it into its own time zone still shows the bank's day, from Hawaii to New Zealand, Tonga and Samoa. Only at UTC-11 (American Samoa, Niue) or past UTC+13 (Kiribati's Line Islands, the Chatham Islands in summer) can such an app show the day before or after; an app that reads the date as written shows it everywhere. |
| `NAME` | The payee as the app shows it: your name for the merchant, else Plaid's, else the bank's own words. OFX allows 32 characters; a longer name is cut there, and given whole in the memo. |
| `MEMO` | Up to 255 characters, in order: "Excluded from budgets and reports in Nya" for a transaction you excluded, the whole name if it was cut, the bank's own words where they aren't the name, and your note. An excluded transaction is still listed, marked: the money did move, and a statement without it wouldn't add up to the balance. |
| Currencies | One statement per currency the account's transactions are in, for the same account: its own currency first, then the others. OFX has one currency per statement, and a rate to convert at isn't Nya's to invent, so nothing is converted. |
| `LEDGERBAL` | The latest balance Nya knows, with the day it is as of (`DTASOF`), as a day where you are: the card sends your device's time zone, and without one the day is UTC's. For a linked account, its newest recorded balance, never an estimate, on the day Nya recorded it; Nya keeps balance history by UTC day, so it is that UTC day where Nya didn't keep the time, or measured the balance on a day only some banks answered. For a manual account, its balance as you last set it, on the day you set it. A card's is negative while money is owed, as OFX writes it. It is in the statement of its own currency only; with none known, there is none, and the notes say why. OFX asks every statement for one, so an app that insists may refuse such a file. |
| `ACCTID` | An id Nya makes for the account, since it never has the full account number: `NYA-`, 12 characters derived from the id Nya first knew the account by, and its last digits where the bank gave them (`NYA-3F9A1C2B7D4E-1111`). When a bank is removed and added back and you link the new account to the old one ([features.md](features.md#removing-an-institution-and-adding-it-back)), the file keeps the old account's id, so an app files it with the same account. The bank gives every transaction a new id then, though, so their FITIDs change: an app that matches transactions by FITID may add again what a file from before gave it. Import from the day after your last import, or let the app's own duplicate check catch them. |
| `BANKID` | `NYA`, in a bank statement. It is not a routing number, which Nya doesn't know, but OFX requires one there, and a strict reader refuses a bank statement without it. A card statement has none. |

**Characters.** A character Windows-1252 lacks is written as its plain letter where it has one (an accent it lacks dropped, `ł` as `l`), and as `?` otherwise, such as letters of non-Latin scripts; the notes count the transactions that touched. The JSON and CSV files have every character. Control characters become spaces, and `&`, `<` and `>` are escaped.

**Not in it.** Categories: OFX has no field for them (the CSV and JSON files have them). Investment transactions, and loans' and investment accounts' balances: in the JSON file.

**When something couldn't be read.** A manual account whose transactions can't be read gives a statement without them, and whether a transaction was excluded, if its record can't be read, isn't marked either way; each is said in the notes, and the response calls the file incomplete (`manual-transactions`, `transaction-annotations`, or `carried-annotations` for exclusions carried from an earlier account), as for the CSV files.

### Bringing it back into Nya

Import it into a manual account ([features.md](features.md#importing-files)): every transaction comes back with its date, amount, sign and currency, and its FITID as the source id, so importing the same file again, or another download that overlaps it, adds nothing. The memo becomes the note; a name longer than 32 characters comes back cut, with the whole name in the note; categories don't come back, except what the bank's code said (an ATM withdrawal, a fee, a transfer), which Nya reads from any bank's file. Imported into the manual account it was made from, a transaction is recognized only by its date, amount, currency and name, so one whose name OFX had to cut or change would be added a second time: import it into another account. The test suite holds this round trip, through Nya's own OFX parser, for every row.

## Protecting the file with a passphrase

Tick **Protect the file with a passphrase** on the card and type one twice, of at least 12 characters: four or more words you'll remember that don't belong together, with spaces between them, make one that is strong and easy to type. The file, whatever its format, is then saved encrypted, with `.age` at the end of its name: `nya-data-2026-10-10.json.age`.

**Nya never keeps the passphrase.** It goes to the server with the request, over HTTPS, is used once to lock the file's key, and is never stored, logged, sent anywhere else, or put in the email. A lost passphrase can't be recovered, by you or by whoever runs Nya, and the file can't be opened without it: download it again with a new one.

### Opening it

- **In your browser**, on Nya's **Open a protected download** page (`/open-download` on your Nya, linked from the card): choose the file, type the passphrase, and the opened file is saved. The page opens it on your device and never uploads it, and needs no sign-in, so a file still opens after the account it came from is deleted. Unlocking takes a few seconds, on purpose, and about 256 MB of memory. The page reads the file a few megabytes at a time, and hands what it has opened to the browser a few megabytes at a time rather than holding it all itself, but an older phone may still stop the page, or say it can't spare the memory: open a large file on a computer.
- **With the age app**, without Nya at all: `age -d -o nya-data-2026-10-10.json nya-data-2026-10-10.json.age` asks for the passphrase and writes the opened file. age runs on macOS (`brew install age`), Linux (`apt install age` on Debian and Ubuntu) and Windows (`winget install --id FiloSottile.age`), and other implementations of the format open it too. The test suite opens Nya's files with the age command where it is installed, and opens the age command's own files with Nya's page code.

### The format

A protected download is an [age](https://age-encryption.org/v1) file, version 1, locked with a passphrase: an existing, documented format with free tools on every platform, built only from standard primitives (scrypt, HKDF-SHA256, HMAC-SHA256 and ChaCha20-Poly1305). `lib/age/age.ts` writes and reads it. The server derives the key with Node's own scrypt (`lib/protected-download.ts`), and the browser page with `lib/age/scrypt.ts`; ChaCha20-Poly1305 is `lib/age/chacha20poly1305.ts`, since Web Crypto has none. The test suite holds them to their RFCs' test vectors and to the age project's own. Byte by byte:

1. A text header, each line ending in a line feed:

   ```
   age-encryption.org/v1
   -> scrypt <salt> 18
   <the sealed file key>
   --- <the MAC>
   ```

   Base64 is the standard alphabet without padding. The salt is 16 random bytes (22 characters). 18 is the work factor: scrypt's N is 2^18, with r = 8 and p = 1, about a second of a computer's time and 256 MB of memory for each guess at a passphrase, which is age's own setting. The file key is 16 random bytes, sealed with ChaCha20-Poly1305 under a nonce of 12 zero bytes and the key scrypt(passphrase, salt = `age-encryption.org/v1/scrypt` followed by the 16 salt bytes): 32 bytes (43 characters). The MAC is HMAC-SHA256 of the header up to and including `---`, keyed with HKDF-SHA256 of the file key, with no salt and the info `header`: 32 bytes (43 characters). A protected download's header is always 150 bytes.
2. A nonce: 16 random bytes.
3. The file's bytes, in chunks of 64 KiB (65,536 bytes; the last may be shorter, and is empty only when the whole file is), each sealed with ChaCha20-Poly1305 under the payload key, HKDF-SHA256 of the file key, salted with the nonce, with the info `payload`. Each chunk's 12-byte nonce is its number, counting from 0, as 11 bytes big-endian, then a byte that is 1 for the last chunk and 0 for every other. Each sealed chunk is the chunk and its 16-byte tag.

So a protected file is 150 + 16 + the file's size + 16 for each chunk, which is how its size is announced before the first byte, and the download is still streamed: each chunk is sealed as the file is written out. A chunk changed, cut short, swapped with another, moved, or taken from another file fails its tag, and a file that ends without its last chunk, or goes on after it, fails too, so a file opens whole or not at all: the page saves nothing until every chunk has opened.

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
| Stores built on the storage seam (`lib/stores.ts`) | Each one declared exportable: a field of its own ([above](#stores-built-on-the-storage-seam)), unless a part of the file above has it already: `sharing-access-log`, your records of when what you share was shown, is in [`sharing`](#sharing). The others are left out: `api-tokens`, whose hashes are credential material (each token's name and dates are in [`api_tokens`](#api_tokens) instead), `api-requests` and `download-count`, the counters behind each API token's requests a minute and the five downloads an hour, `import-requests` and `import-reads`, the counters behind the hundred file imports and previews and the three hundred reads of the list of imports an hour, `import-summaries`, each import's entry without its records, which `imports` holds whole, and `holdings:history:index`, which says only which id each month of `holdings:history` is stored under and the first and last day each account was recorded, both of which the months themselves hold. |

Sharing settings are not in your container (connections are between two people) and are read as your side only. Your records of when what you share was shown are in your container (`sharing-access-log`, a store on the seam); the other person's record of when what they share was shown to you is in theirs, and read from there, as they see it.

## How it differs from the operator backup

There are two exports, and they are kept apart on purpose (#55): one that did both jobs would be too decrypted to be safe, or too complete to be portable.

| | Download my data | Operator export and nightly backup |
| --- | --- | --- |
| For | You, to keep or take elsewhere | Whoever runs Nya, to recover from losing the database |
| Covers | One person | The whole environment, every person |
| Values | Decrypted, in documented fields | Encrypted, byte for byte as stored, and unreadable without the keys; dates, account and transaction ids, bank names and the merchant names you renamed are in plain text ([operations.md](operations.md#taking-a-backup-by-hand)) |
| Formats | JSON, CSV, OFX, any of them protected with your passphrase if you choose | NDJSON of raw database keys, with a checksum |
| Leaves out | Credentials and the app's machinery | Only what would be wrong after a restore (caches, locks, counters, job records) |
| Restores | Not yet: restoring from this file is planned (#43). An OFX statement from it, or a file from your bank, can be imported into a manual account ([features.md](features.md#importing-files)) | `bun run restore` ([operations.md](operations.md#restoring-a-backup)) |
| Gets it | You, after a fresh sign-in, 5 an hour | The operator, with `OPS_SECRET`, or the nightly cron |

Deleting your account deletes your data now, and the nightly backups expire it later; the receipt at the end gives the date ([authentication.md](authentication.md#deleting-an-account)). A file you downloaded is yours, and deleting your account doesn't reach it.

## Adding a store

A new store is built on the storage seam (`lib/repo.ts`), and declaring it `exportable: true` is all it takes to be in this download: `declaredSections()` in `lib/user-export.ts` gives it a field of its own and reads it with the seam's reports (`getAllReport`, `getReport`), so an entry it can't read is named under `problems` rather than stopping the download, unless an entry of `SECTIONS` exports it itself and names it in `covers` (as `sharing` does `sharing-access-log`, to put each record beside its connection). Describe what it holds on this page. Its name must not be one the file already uses (`notes`, `accounts`), which would fail every download; `test/user-export.test.ts` checks that.

The older stores are read by hand. One that stands alone (nothing else needs to read it to build the file) is an entry in `SECTIONS`: its key in the file, its name for errors, a reader that returns the store already in its exported shape and throws on anything that says nothing about the data (storage, keys), and either throws on an entry it can't read or names it (`problems`, by the seam's rules: `openStored` in `lib/repo.ts`), and, if it names accounts, which ids it names, so `accounts` lists them. Its key goes in `STORED_KEYS`. A store the core sections cross-reference (accounts, history, transactions) is read in `collectUserData` and built in `buildUserExport`.
