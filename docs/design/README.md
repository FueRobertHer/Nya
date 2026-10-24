# Nya design

A plan to make Nya easier to use: less on each screen, everything in one obvious place, and one look across the app. Phases 1 and 2 of the [rollout](rollout.md) are built; the rest is planned here.

| Document | What it covers |
|---|---|
| [Guidelines](guidelines.md) | **Start here when building UI.** Where a new feature goes, which classes and colors to use, the honesty rules, and the checklist each pull request is reviewed against. `test/design-guard.test.ts` enforces the checkable parts. |
| [Information architecture](information-architecture.md) | What each tab is for, what moves where, the Settings screen, the end of Manage mode, Needs attention, deep links, and a table placing every component. |
| [Design system](design-system.md) | The visual direction, color in light and dark with contrast ratios, type, spacing, components and the classes each replaces, status and honesty rules, copy, accessibility. |
| [Tokens](tokens.css) | The design tokens as CSS, with aliases for today's names. The scales and dark theme are copied into `app/globals.css`; the light theme waits for phase 7. |
| [Rollout](rollout.md) | Seven pull-request-sized phases, effort and risks for each. |
| [Mockups](mockups/index.html) | Phone screens of every surface, in dark and light, and the two visual directions side by side. |

## Why

Every tab is a long column of cards of equal weight, so nothing says what matters. On a phone, Activity's transaction list starts two screens down, Budgets and Plan are over four screens each, and Accounts opens on two paragraphs about sync services before the first account. The Manage button on Accounts is a hidden Settings page: it adds Disconnect, Hide, Close and Delete to every row and thirteen unrelated cards below the list, roughly tripling the controls on the tab. The theme has eleven color tokens and nothing else, 26 font sizes, about fifty kinds of note, and primary and danger buttons that fail contrast.

## Principles

1. **One job per screen.** Each tab opens on its main object (your total, your accounts, your transactions, this month's budget, your FI number); analysis and setup are one tap away.
2. **Settings live in Settings.** No mode toggles that rewrite a page.
3. **One home per thing.** Each problem, action and setting has one place; other places link to it.
4. **Act where the object is.** An account's actions are on the account; a connection's actions are on its institution.
5. **Explain on demand.** One line of helper text; the rest behind "Why?".
6. **Honest, ranked status.** Every warning keeps its words and its severity color; collapsed warnings still say how many and what kind.
7. **Same thing, same look.** One component per pattern, a token for every value.

## How this plan was made

Two plans were drawn up independently from the code on `origin/main` and from the public demo: one by Claude, and one by Gemini (`gemini-4-argon-high`), whose claims about the code were each checked against the source. Both reached the same core: remove Manage, give settings their own screen, put account actions on an account sheet, lead Activity with the transaction list, split Budgets and Plan into segments, rank warnings, and add a light theme. Where they differed, each of Gemini's proposals was weighed on its merits:

| Gemini proposed | Decision | Why |
|---|---|---|
| Keep five tabs; a settings surface off the header | Adopted | The tabs are right; their contents are the problem. |
| Settings as a sheet | Changed to a full screen | Thirteen-plus cards in a bottom sheet means long scrolling sheets and sheets on sheets. |
| A gear button in the header | Changed: Settings leads the avatar menu; a gear only in password mode | The header already has three icons. |
| Group accounts by institution (Claude had proposed by type) | Adopted | Balances fail per institution, and "this subtotal is short" needs an institution card to sit on. A type summary line keeps the overview. |
| Add account sheet; institution ⋯ menu; account sheet | Adopted | Removes the onboarding block and Manage's row buttons; fixes buttons nested in clickable rows. |
| A Connections pill plus a Connections section | Adopted with a rule | A problem shows on its card and is counted on Home; the pill only scrolls to it. Otherwise status would be in four places. |
| Home: needs attention plus a monthly pulse | Adopted and extended | Also one Net worth card (total and chart together) and the currency offer as an attention item: three blocks instead of five to seven. |
| Activity: pinned month strip | Changed to a compact month switcher | The strip is a 187px bar chart; it moves to Spending. |
| An Activity segment called "Insights" | Renamed "Spending" | Home already has Insights. |
| Tie the cash-flow chart to the selected month | Changed: one shared period control | Keeps the chart's multi-month ranges. |
| Reports in settings | Changed: Activity > Spending | Reports are analysis, not settings. |
| Budgets: monthly, cash flow and bills, goals; debt payoff under goals | Adopted, named Month, Upcoming, Goals | One time range per segment. |
| Plan: scenario bar, three segments | Adopted | Fixes the scenario flow. |
| Completeness caveats in a neutral style | Changed: color by severity, and critical caveats never collapse | An incomplete total is red today on purpose; neutral, or folding "needs reconnecting" into a count, would soften it. |
| Backup failures as an action for everyone | Changed: the fact for everyone, the instruction for the admin | Only the deployment's owner can fix a backup. |
| Accent `#3b76f6` or `#5b8def` for buttons | Replaced with `#2563eb` | White on either fails AA (4.11 and 3.23); on `#2563eb` it is 5.17. |
| Tertiary text `#686e7c` / `#767d8c`, light green `#059669` | Replaced | They fail AA (3.47, 4.13, 3.77). |
| Tokens with aliases; check print and hide amounts | Adopted | Lets the migration go a component at a time. |

Gemini then reviewed the finished documents. Accepted and applied: the light field border failed 3:1 on two surfaces (fixed and added to the check); a stopped-reporting account was red in one doc and amber in another (amber: it is held at its last known balance); critical caveats must never collapse into a count; a failed backup must say "failed" to everyone; reconnected-account matches belong in Needs attention; rollout order left Debt payoff without a home between phases and used a menu before the menu existed; a "Why?" sat inside a clickable row; deep links must move focus. Rejected: Reports becoming unreachable in phase 1 (it is already on Activity for everyone), a separate Redbark connector (it uses SimpleFIN's protocol, now said in the Add sheet), and moving Home after Activity and Budgets in the rollout (Needs attention can open the tab until the segment exists).
| Tokens first in the rollout | Changed: Settings and Manage first | Fixes the stated pain before invisible work. |

## Decisions you can reverse

- **Accounts grouped by institution**, with a type summary line, rather than grouped by type.
- **Debt payoff under Budgets > Goals** rather than on Plan.
- **Settings in the avatar menu** rather than its own header gear.
- **The visual direction**: the refined current dark or the new ledger look, shown side by side in the mockups.
- **The theme follows the system** (dark when the system is dark or says nothing, light when it is light). The alternative is dark for everyone until they pick Light.
- **System font** rather than a self-hosted face.
