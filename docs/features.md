# Features in depth

How the main behaviours work, and why. The [README](../README.md) has the overview.

- [Connecting accounts](#connecting-accounts)
- [Removing an institution and adding it back](#removing-an-institution-and-adding-it-back)
- [Payment details](#payment-details)
- [Hiding accounts](#hiding-accounts)
- [When an institution can't be reached](#when-an-institution-cant-be-reached)
- [Manual accounts](#manual-accounts)
- [Keeping Plaid costs down](#keeping-plaid-costs-down)
- [Planning](#planning)

## Connecting accounts

Log in, then click **Connect an Account**. Click it again for each additional institution. Each one is added to your dashboard with a running net worth total.

### More accounts at an institution you already have

To add (or remove) accounts at an institution that's already connected, tap **Manage** on the Accounts tab, then **Add or remove accounts** on its card. This opens Plaid's account picker on the connection you already have, so it stays one connection: no duplicate accounts, and no second connection for Plaid to bill.

If you start **Connect an Account** and pick an institution you've already connected, Nya stops before you sign in and offers to add the accounts to the existing connection instead. Choose **It's a different login** for a genuinely separate login (a joint or business login, say); that one gets its own connection.

When Plaid notices new accounts at a connected institution (it needs webhooks, below), the card says so and offers **Review accounts**, which opens the same picker.

Removing an account in the picker stops Nya receiving new data for it. Its balance history and stored transactions are kept, as they are when you disconnect a whole institution. Recorded past totals don't change, but the estimated part of the chart (before Nya started recording) is rebuilt from the accounts connected now whenever an account is added, so a removed account drops out of those estimates then. Chase doesn't let accounts be removed this way; hide the account, or disconnect Chase, instead.

If Plaid Link asks you to reconnect an institution (shown as a **Reconnect** button on its card), the bank's credentials or MFA changed on their end. Click it and log back in through Plaid to fix it; there is no need to disconnect and relink from scratch.

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

Forget can't reach copies made before it: a backup you downloaded (see [operations.md](operations.md#backups)) still has the account, and restoring that backup brings it back. A goal that pointed at the account keeps pointing at it (as an account id only) until you change the goal.

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

If the balances are older than **35 days** the card stops showing them and names the date instead. An institution broken for months shouldn't quietly revert to zero, and it shouldn't drag a months-old figure into today's total either. Any institution that can't be reached and can't be recovered is called out under the Home total, so a total that's missing a whole bank never looks complete.

Recovered balances are **display-only**. They're never written to the net-worth history, and no snapshot is recorded on a day when any institution failed, so a stale figure can never be mistaken for a measured one in the chart. The consequence is a real gap: if a connection stays broken through the end of the day, that day gets no point at all and nothing back-fills it later. That's deliberate, because a fabricated flat line in the real history layer would be permanent: nothing ever rewrites a past date.

An institution that needs re-authenticating keeps the red warning and its **Reconnect** button, and only says the balances are dated. The softer amber note is reserved for failures that usually clear on their own, so a dead connection can't hide behind plausible-looking numbers.

A related case: an account that disappears from an otherwise successful fetch (a closed account some banks simply stop returning) holds the snapshot for three days, called out under the Home total, and is then accepted as closed. A glitch resolves itself inside that window; a real closure costs a few days of gap rather than a wrong total written permanently.

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

## Planning

The **Plan** tab answers two questions: how much you need to be financially independent (FI), and how a retirement on that money would have lasted through US market history. Everything is in today's dollars. The results are hypothetical: they come from US history, or sequences resampled from it, and are not a prediction and not advice. The tab says so beside every result, with the assumptions behind it.

### The FI figures

- **FI number**: your annual spending divided by the withdrawal rate (4% by default), grossed up for the tax on withdrawals: `spending / (1 - tax) / rate`. Spending $40,000 at 4% with no tax needs $1,000,000.
- **Years to FI**: how long your invested assets take to reach the FI number, adding your annual savings at the end of each year and earning a steady real return (5% a year after inflation by default). It says "Not at this rate" when savings and growth never get there.
- **Coast FI**: what you need invested today for it to grow to the FI number by your target age with nothing more added, at the same return.
- **Barista FI**: the FI number when part-time income (after tax) covers part of your spending, so the portfolio covers only the rest.
- **At your target age**: the balance projected at the steady return. Real markets don't move steadily, which is what the simulation is for.

### Where the inputs come from

Each input says where it came from, over what dates, and what may be missing from it, and any of them can be typed over. A typed figure stays until you switch back to Nya's.

- **Annual spending**: the last 365 days of money out, with the first and last day shown beside it. It starts from the Activity tab's rule, which leaves out transfers between your own accounts and card payments (paying a card off settles purchases already counted on the card), and then counts what that rule leaves out for reasons that don't hold for planning (`lib/fire/inputs.ts`; the Activity tab's own totals are unchanged):
  - **Loan payments** that Plaid's detail says are on a mortgage, car, student or personal loan. Their principal is really saving, but it is spending until the loan ends, which is what a plan starting today has to fund. The label says how much of the figure they are; if a loan ends before you stop working, type your own figure. The loan account's side of a payment (money in) is never counted, so a payment from one linked account to another counts once.
  - **Cash withdrawals** (at an ATM or a teller) and **bank charges**.
  - **Refunds**: money back in a spending category (food, shopping, travel, bills and the like) is taken off spending rather than counted as income, which would overstate both. Money in under income, a transfer or "other" is never a refund. The total and the largest refund are shown beside the figure, so an odd large one (a deposit returned, an insurance payout) can be seen and typed over.

  Paying a card off never counts, whatever the row was recategorized as: it settles purchases already counted on the card. Anything else filed under loan payments (no detail, Plaid's "other payment", which can be a store card, or a row recategorized there whose detail says something else, a card payoff among them) can't be told from a card payment, so it is left out and its total is named beside the figure, never guessed. A pending charge whose posted version has arrived was already dropped. With less than a year of history the total is scaled up to a year, and the label says from how many days or months. Under four weeks gives no figure.
- **Invested assets**: your investment accounts at their balances when the dashboard last loaded them (the time is shown), without hidden ones, plus checking and savings if you tick the box. Debts are not subtracted. Every investment account counts, a 529 or an HSA included, since tax buckets aren't modelled yet: type your own total to leave one out.
- **Annual savings**: an estimate. A year of income minus spending from bank data, plus what went into workplace retirement plans over the year through payroll: a 401(k), 403(b), 457(b), TSP, SIMPLE IRA and similar, by the account's type, from Nya's verified investment transactions, an employer's match included where the plan reports it as a contribution. Payroll contributions never pass through a bank account, so bank data alone misses them. Nothing is counted twice:
  - a contribution that a transfer out of your accounts paid for (the same amount within a dollar or 1%, within five days) already counts as saved, so it is not added again;
  - each workplace plan has a **Paid through payroll** switch under Edit, on by default. Turn it off for a plan you pay into from your bank account (a Solo 401(k), say), and nothing paid into it is added. The switch is saved with your plan.

  Contributions to brokerages and IRAs are not added: they are usually paid from a bank account, where income minus spending has already counted them. The label says what was added, what was not and why. A plan whose verified record covers less than the year is named with the day it starts; the server decides that on its own days, so it never depends on your time zone. With no workplace plan linked, the label says pre-tax contributions and a match are missing.
- **Ages and assumptions**: typed by you. Your age places Social Security, pensions and one-off expenses in the plan. The target age can't be before your age: if you have already stopped working, use your age. A pension that doesn't rise with inflation is entered in today's dollars, not the amount quoted for the year it starts.

A figure that may be short says so beside it, and the FI number and the progress under it repeat the warning for spending and invested assets. In particular:

- An institution whose transactions couldn't all be read (it needs reconnecting, is still syncing, or its stored history couldn't be read) is named beside spending and savings. If the transactions couldn't be loaded at all, spending says that rather than "not enough transactions".
- An institution that couldn't be reached is named beside invested assets: not counted when nothing was recovered from it, or counted at its last-known balances, with their date. Accounts it is known to have that couldn't be shown, and accounts with no balance, are counted in the same notes.
- A workplace plan whose activity couldn't be read is named beside savings.
- Nya doesn't convert currencies. Investments in one currency and spending in another, or either one mixing several, are said beside the figures.

### Will it last?

The simulation runs a retirement through market history, withdrawing by a rule each year, for the length you choose: to age 95 by default, or 30 years when no age is set. Where it starts sets what the first year spends, and the card says which:

- **Your FI number at your target age** (the default): the first year withdraws your withdrawal rate of it, which after tax is your spending, since that is how the FI number was set.
- **Your invested assets today**, or **a balance you type**: the first year withdraws your spending (grossed up for tax), at whatever rate that implies, so the result answers whether what you spend now would have lasted from there. The card shows the rate and says when it is above the one your FI number assumes. The grid adds it as a row up to 20%.

VPW is the exception: it sets its own spending from the balance and the years left, so the card compares its first year with what you spend.

There are two methods:

- **Historical cycles** start the plan in every month from January 1871 that leaves its whole length inside the data (1,470 starts for 30 years) and live through what actually followed, the idea behind cFIREsim and FIRECalc, on monthly rather than annual data.
- **Monte Carlo** runs 5,000 sequences, each built from five-year blocks of consecutive months drawn at random from the same history (a circular block bootstrap). A block keeps the months together, so stocks, bonds and inflation stay matched, as do runs of good or bad years shorter than a block; longer cycles are cut at block edges, so the results spread wider than the history's. The draws are seeded, so the same plan always gives the same answer.

While a new answer is worked out, the last one keeps its place but is hidden, since it answered other assumptions.

**Success** means the portfolio never ran out: every year's withdrawal was paid in full to the end of the plan. The success rate is the share of starts (or runs) that succeeded. A flexible rule (all but the constant one) lasts by cutting spending when markets fall, so its success rate comes with a second figure: the lowest year's spending as a share of the first year's, in the worst start (or run) that lasted. The fan chart shows the balance each year at the 10th, 25th, 50th, 75th and 90th percentiles, with a table of the same figures. The worst starting years are those that ran out soonest, or, when none did, came closest (the lowest spending, then the lowest balance left), listed once per calendar year.

**The grid** repeats the plan at 3% to 5% and 20 to 50 years, plus your own rate and length, with everything else as in the plan. For a flexible rule each cell carries the second figure too, and VPW, which has no rate to vary, gets one row. In historical cycles each length has its own starts, every month that leaves the whole length inside the data: a 30-year plan can start up to June 1993, a 50-year one only up to June 1973. Each column says where its starts end, and the note under the grid gives each one's count and span. A longer column leaves out the latest starts, so it can read safer than a shorter one: at 4%, 60 years can beat 50 by missing the late-1960s retirements. Monte Carlo columns share the same runs, each extended to the longer lengths, so for a rule that ignores the length (constant, percent of portfolio, floor and ceiling) a longer column never reads safer; guardrails and VPW withdraw by the years left, so theirs can differ slightly either way. A one-off dated after the plan ends is shown as such: only the grid's longer columns reach it.

Each plan year, in order:

1. The rule sets the year's withdrawal from the balance at the start of the year.
2. Other income (Social Security, a pension, after tax) pays part of that year's spending, so the portfolio withdraws less; income beyond the spending is invested. One-off expenses are added. What the portfolio pays is grossed up for the flat tax.
3. If that is more than the balance, the plan has run out that year.
4. The rest earns the next twelve months' returns, at your mix, rebalanced every year by default (every month, or never, are the options).
5. Fund fees are charged (0.1% a year by default).

Withdrawals are taken once a year at the start of the year, the convention of the annual studies, slightly conservative against spreading them out. Returns compound monthly. Cash keeps up with inflation and earns nothing more: Shiller's data has no short-term rate, and the 10-year yield would credit cash with a bond's returns.

### The withdrawal rules

- **Constant (the 4% rule)**: the first year withdraws the rate times the starting balance, and every later year the same amount in today's dollars, whatever the market does.
- **Percent of portfolio**: every year withdraws the rate times the balance at the start of that year. It cannot run out; spending moves with the market, and the result shows how far it fell.
- **Guardrails (Guyton-Klinger)**: starts at the rate, then keeps the amount steady in today's dollars, except that after a year the portfolio lost money the raise for inflation is skipped while the withdrawal is above the starting rate (of the current balance); above 120% of that rate it is cut by 10% (not in the last 15 years), and below 80% it is raised by 10%.
- **VPW (variable percentage withdrawal)**: each year withdraws the share an annuity would pay over the years left, at an expected real return from your mix (5% for stocks, 2% for bonds, 0% for cash). It spends the portfolio down to zero at the end, on purpose.
- **Floor and ceiling**: each year withdraws the rate times the balance, kept between a floor and a ceiling set as shares of the first year's withdrawal (90% and 125% by default).

The exact definitions are in `lib/fire/rules.ts`.

### The data, and its license

The history is Robert Shiller's monthly US data (the price and dividends of the S&P Composite, which is the S&P 500 since 1957, the consumer price index and the long-term government bond yield, the 10-year Treasury's since 1953), January 1871 to June 2023, as packaged by [datasets/s-and-p-500](https://github.com/datasets/s-and-p-500). The package extends the price past June 2023 without the other columns, so the history stops there. The packaging is licensed under the ODC Public Domain Dedication and License (ODC-PDDL-1.0), but **Shiller's own page states no license terms** beyond a disclaimer. Check before any paid use.

`scripts/fire-data.ts` turns the package's CSV into `lib/fire/history-data.ts`: monthly real stock returns, real bond returns and inflation, in millionths. It is reproducible, and the module records the source URL (a pinned commit), the SHA-256 of the file and a SHA-256 of the rows used:

```bash
curl -sSLo /tmp/sp500.csv https://raw.githubusercontent.com/datasets/s-and-p-500/07b81e6af68239acd65b901a11844d6d95db6ead/data/data.csv
bun run fire-data /tmp/sp500.csv
```

The derivations are in `lib/fire/derive.ts`:

- **Stocks**: total return over a month is `(next price + next dividend / 12) / price - 1`. Shiller's dividends are annualized, so a month earns a twelfth.
- **Bonds**: a 10-year bond bought at par at this month's yield and sold a month later, with 9 years 11 months left, at next month's yield, plus a month of coupon: the standard constant-maturity approximation. Shiller's long rate is the 10-year Treasury yield from 1953 and a long-term government bond yield before, so the early bonds are an approximation too.
- **Real returns**: `(1 + nominal) / (1 + inflation) - 1`, from the CPI. Inflation is applied this once; the engine never adjusts a withdrawal for it again.

### How it is checked

The engine is pure functions (`lib/fire/`), run in the browser. Property tests check that no value appears from nowhere (with no returns, the balance is the start plus deposits minus withdrawals), that inflation is applied exactly once, that a higher withdrawal rate never raises the success rate, that a seed reproduces a Monte Carlo run, and that random plans give no NaN or negative balance. The flexible rules have their own: VPW never runs out and ends at exactly zero at the end of any plan, percent of portfolio never runs out or reaches zero at any rate, mix or method, and guardrails never cut in the final 15 years.

Golden tests check that the results are consistent with the figures published studies report, as ranges, not against the same inputs run through other tools: the studies used annual data, other periods and other bonds, which move the answer by a few points. 4% over 30 years succeeds in 96% to 97.5% of the historical starts with half or more in stocks, consistent with the roughly 95% or more that the Trinity study, Bengen, FIRECalc and cFIREsim report for the classic case; bond-heavy mixes do much worse, as Trinity found; longer plans need lower rates; and the failures and near misses all start in the known bad periods (around the 1929 crash, the mid-1960s, and the early 1900s). Nothing here was compared with FIRECalc, cFIREsim or Early Retirement Now on identical settings. The tests name each source.

### Limits

- **US history only**, in US inflation terms. Accounts in other currencies are shown in their own currency but simulated on US data, and nothing is converted between currencies.
- **Taxes are one flat rate** on withdrawals: no brackets, capital gains, account types (taxable, tax-deferred, Roth), required minimum distributions or subsidies.
- **No fund look-through.** Nya doesn't know what your funds hold, so the mix is what you set: split a target-date or balanced fund by hand.
- **One history.** Monte Carlo reshuffles it in five-year blocks, so it can string bad stretches together, but every month in it is a month that happened.
- **Spending from bank data** misses anything paid from accounts you haven't connected, and last year's spending may not be what retirement costs.

The tab saves only your assumptions (one encrypted value per account, the `fire-plan` store on the storage seam, `lib/fire-plan.ts`), never a result; everything else is worked out again from your data each time it opens. A plan saved under an earlier release always reads back: reading checks only its shape, and fills in any field added since, while today's ranges apply when it is saved again. If a saved value is one this release doesn't take (a range narrowed since, say), the tab says which, uses the default in its place (or leaves out the income or expense it belongs to), and offers to save the plan that way; it never stops working over it. A plan a later release saved, which this one doesn't understand, is reported as such and left untouched. Its code, with the engine and the market history, loads only when the tab is first opened. If that fails (offline before it was ever fetched, or a flaky connection), the tab says so and offers to try again, and the other tabs work as before. The simulation runs in a Web Worker, and the grid there one cell at a time, so the page stays responsive while they are worked out. The jobs wait on the page and go to the worker one at a time, so when the plan changes again before they run, the old ones are dropped and the new answer never waits behind them. Where a worker can't start, the same work runs on the page, one piece at a time between paints. If neither can run (the connection dropped before the engine's code arrived), the card says the simulation couldn't be loaded and offers to try again.
