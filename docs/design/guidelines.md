# Building UI in Nya

The rules every change that adds or changes UI follows, so the app keeps one design language as it grows. Read this before starting UI work; the [checklist](#checklist) at the end is what a pull request is reviewed against.

The target design is in [design-system.md](design-system.md) and [information-architecture.md](information-architecture.md); [rollout.md](rollout.md) is how the app gets there. Until a rollout phase lands, build with **today's classes** ([below](#which-class-to-use-today)) and today's 11 color variables, following the target's rules. `test/design-guard.test.ts` holds the parts a test can check.

- [Where it goes](#where-it-goes)
- [Color](#color)
- [Type](#type)
- [Spacing and layout](#spacing-and-layout)
- [Which class to use today](#which-class-to-use-today)
- [Status and honesty](#status-and-honesty)
- [Amounts](#amounts)
- [Sheets, menus and forms](#sheets-menus-and-forms)
- [Copy](#copy)
- [Accessibility](#accessibility)
- [Changing the design itself](#changing-the-design-itself)
- [What the guard test checks](#what-the-guard-test-checks)
- [Checklist](#checklist)

## Where it goes

Decide this first. Most clutter in Nya came from good features placed in the first spot that was free.

1. **A setting** (it changes how Nya behaves, and nobody looks at it daily) goes in a Settings section: Preferences, Transactions, Connections, Sharing, Your data and privacy, or Account. Until Settings exists (rollout phase 1), build it as one self-contained card component and add it to the Manage list on Accounts, so it moves as a unit. Never put a setting on a working screen.
2. **About one object** (an account, a transaction, a goal, a connection, a person) goes in that object's sheet or its ⋯ menu, not as a new card or a new row button on the tab.
3. **Asks the person to act** is shown on the object it concerns and is also an item in Home's Needs attention.
4. **Analysis of transactions** goes with Activity's analysis (Spending, after phase 5), never above the transaction list.
5. **This month's budget, what is coming, or something saved toward** goes in Budgets: Month, Upcoming or Goals.
6. **Long-term or FI** goes in Plan: FI and timeline, Stress test or Portfolio.
7. **None of these**: say so in the pull request and propose a home. Don't add a card to Home.

Also:

- **No new tabs and no new modes.** Nothing toggles a screen into a different screen.
- **A tab's first screen is earned.** A new card goes below what is there unless it is the tab's main object.
- **Explanations go behind "Why?"**: one line of helper text by default.
- **Record the placement**: add every new component to the [feature-to-location table](information-architecture.md#feature-to-location), or to [Building blocks](information-architecture.md#building-blocks) if it only serves other components. The guard test fails until you do.

## Color

- Use only `var(--…)` colors. Today that means the 11 variables on `:root` in `app/globals.css`: `--bg`, `--card`, `--raised`, `--border`, `--line`, `--text`, `--muted`, `--accent`, `--up`, `--warn`, `--down`.
- **No color literals** (`#hex`, `rgb()`, `hsl()`) in components or in new CSS rules. Charts pass `var(--…)` strings to `fill` and `stroke`.
- Don't use the new token names from `tokens.css` (`--surface`, `--text-2`, ...) in app code yet. They don't exist in the app until phase 2 imports them.
- **Meaning, not decoration.** Blue is for actions and the current selection. Green and red are for money in and out and for gain and loss. Amber is only for something that needs the person. Red is for a number that is wrong or short.
- **Never color alone**: a state shown in color also has a word or an icon.

## Type

- Sizes: 12, 13, 15, 17, 20, 24px, and one hero figure per screen. **Nothing on screen under 12px.**
- Sentence case. No new uppercase micro-labels.
- Card titles 15px at weight 600; sheet titles 17px; body and rows 15px; secondary lines 13px; meta 12px.
- Money in columns or that can change in place is tabular (`font-variant-numeric: tabular-nums`; `td.num` already is).

## Spacing and layout

- **The container spaces its children.** Put stacked siblings in `.stack` (12px), `.stack.tight` (8px) or `.stack.loose` (16px); children of a stack lose their own block margins.
- **No inline spacing or type.** `style={{}}` must not set margin, padding, gap, font size, weight, line height, letter spacing or text transform. Inline style is for data only: a bar's width, a marker's position, a chart color as `var(--…)`, a CSS custom property.
- Spacing comes from the 4px grid (4, 8, 12, 16, 20, 24, 32). Radii come from 6, 8, 12, 16 and pill.
- **Reuse before you add.** Before writing a CSS rule, look for the class in the table below. Name a new class for its feature (`.payoff-…`), unless it is a generic primitive agreed in design-system.md. Never add another note, alert or button variant.
- Phone first: it must work at 320 and 375px wide without the page scrolling sideways.

## Which class to use today

Until phase 2 adds the new primitives, these are the classes for each need. The guard test checks that every class in the middle column exists in `app/globals.css`.

<!-- design-guard:classes -->
| Need | Use today | After phase 2 |
|---|---|---|
| A card | `.card` | `.card` |
| A card's title row | `.inst-header` with `.inst-name` and `.inst-total` | `.card-header` with an `<h2>` |
| Stacked spacing | `.stack`, `.stack.tight`, `.stack.loose` | same |
| Primary action | a plain `<button>` | `.btn.primary` |
| Other actions | `button.secondary` | `.btn.secondary` |
| Icon button | `.icon-btn` | `.icon-btn` |
| Confirming a destructive action, inside a sheet | `button.danger` | `.btn.danger` |
| Two buttons side by side | `.button-pair` | `.btn-row` |
| A row of actions under a card | `.card-actions` | `.btn-row` |
| Helper text | `.panel-note` | helper text |
| Empty state | `.empty-note` | empty state |
| Critical notice (a number is wrong or short) | `.error` | `.notice` critical |
| Caution notice (real but dated, needs you) | `.stale-note` | `.notice` caution |
| Information notice | `.info-notice` | `.notice` information |
| Done, saved | `.status-note` | `.notice` done |
| Badge | `.pill` | `.badge` |
| A meter | `.meter-track` with `.meter-fill` | same |
| Range or view switch | `.chart-ranges` with `.chart-range` | `.segmented` |
| Key and value details | `.txn-detail` with `.txn-detail-row` | same |
| In, out and net figures | `.summary-row` with `.summary-value` | stat strip |
| A form field | `.field` around a plain `<input>` or `<select>` | same |
| A form in a sheet | `.sheet-form` | same |
<!-- /design-guard:classes -->

**Avoid in new code**: `.link-btn` for anything but an inline action within a sentence (it is about 15px tall); `.type-tag` and other uppercase labels; one-off button classes that undo `button { width: 100% }` (use `button.secondary` inside `.button-pair` or `.card-actions`, which size their buttons).

## Status and honesty

Nya shows its gaps on purpose ([features.md](../features.md)). A new feature that can be wrong, stale or incomplete must say so, in these terms:

- **Severity sets the color, and is never lowered to save space.** Critical (red): a number is wrong or short. Caution (amber): real but dated, held or paused, or it needs the person. Information (neutral): nothing is wrong.
- **On the number.** A caveat sits under the figure it qualifies. Critical caveats always show in full, naming what is wrong. Two or more lesser ones may collapse into a line that states how many and what kind.
- **Needs attention.** Anything that asks the person to act also appears in Home's Needs attention, linking to where it is fixed.
- **Who can act.** An instruction only the deployment's admin can follow is shown only to the admin; everyone else gets the fact.
- **Keep the words.** Moving or restyling a warning never changes its wording or drops it. A pull request that touches one says so.

## Amounts

- Write every amount through `lib/format.ts` (`formatMoney`, `signedMoney`, `compactMoney`), so hide amounts masks it. `test/hide-amounts.test.tsx` fails otherwise.
- Show an amount in its own currency. A total that mixes currencies says what it left out.
- A negative balance shows a minus sign, and a debt reads as a debt.

## Sheets, menus and forms

- Forms, confirmations and detail views open in `components/Sheet.tsx`. A sheet that needs a second level replaces its content and gets a back button, instead of opening a sheet on top of a sheet.
- Destructive actions live in a menu or a detail sheet and are confirmed in a sheet. An irreversible one says it can't be undone; disconnecting an institution asks for its name to be typed.
- Rare actions on an object go in its ⋯; urgent ones (Reconnect) stay as visible buttons.
- A number field keeps its value as a string while it is typed (see `ManualDraft` in `Dashboard.tsx`), so a minus sign survives.

## Copy

- One line of helper text; the rest behind "Why?".
- Say what to do, then why: "Reconnect Chase to update its balances".
- One word for one thing: Hide, Close, Disconnect, Delete, Forget, Link, Connect ([vocabulary](information-architecture.md#vocabulary)).
- Sentence case. No em or en dashes.

## Accessibility

- Touch targets at least 44px.
- No interactive element inside another, so no button inside a clickable row.
- Card titles are headings once phase 2 lands, and real headings are used wherever new markup allows it.
- Focus is visible and never removed. Jumping to something moves focus to it.
- Reduced motion is respected.
- AA contrast. The token set is checked; a new color pairing goes through [Changing the design itself](#changing-the-design-itself).

## Changing the design itself

A new token, component pattern, color or size is a change to the design system, not to one feature:

1. Propose it in `design-system.md` (and `tokens.css` for a color or size), saying what it replaces or why nothing existing fits.
2. Run `bun test test/design-guard.test.ts`, which checks the token contrast.
3. Update the mockups in `docs/design/mockups/index.html` if a screen changes.

## What the guard test checks

`test/design-guard.test.ts`, against the per-file counts in `test/design-guard-baseline.json`:

- **Raw colors** in components, app pages and on-screen CSS rules, **inline spacing and type** in `style={{}}`, and **on-screen font sizes under 12px** may not rise in any file, and a new file has none.
- When a count falls, the test asks you to lower that file's number in the baseline. Do it in the same pull request; the baseline only ever goes down.
- Every component in `components/` is placed in the information architecture doc.
- Every class in the table above exists.
- `docs/design/tokens.css` passes AA contrast in both themes, and its two light blocks match.

When it fails, fix the code. Don't raise a baseline number to make it pass.

## Checklist

For every pull request that adds or changes UI:

- [ ] Placement follows [Where it goes](#where-it-goes); new components are recorded in the information architecture doc.
- [ ] No new tab, mode, or card on a tab's first screen without a reason stated in the PR.
- [ ] Colors are `var(--…)`; no literals; meaning colors used for their meaning.
- [ ] Sizes from the scale, nothing under 12px; spacing through `.stack` or a button group, not inline.
- [ ] Classes come from the table above; no new note, alert or button variant.
- [ ] Warnings keep their words and severity; critical ones are on the number in full.
- [ ] Amounts go through `lib/format.ts`; hide amounts still masks them.
- [ ] Targets at least 44px; no nested controls; focus visible.
- [ ] Works at 320 and 375px and on desktop, in print where a report is involved.
- [ ] A view test (`test/*-view.test.tsx` pattern) covers the new UI's states, including its warnings.
- [ ] `bun test` and `bun run typecheck` pass.
