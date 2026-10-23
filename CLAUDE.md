@AGENTS.md

# Working on Nya

## Commands

- `bun test` runs the whole suite; `bun test test/<name>.test.ts` runs one file.
- `bun run typecheck` runs `tsc --noEmit`.
- Run both before calling a change done.

## Checking UI

- The dev server (`bun run dev`) reads `.env.development.local`, which points at the real Upstash Redis and Clerk, with the deployment's own password. Don't sign in or write through it.
- Prove UI behavior with view tests instead (`test/*-view.test.tsx`, with `test/fake-redis.ts` for storage).
- To look at real screens, use the public Preview demo linked in the README. Its sandbox demo accounts need no password, but it trails `main`.

## UI work

Every change that adds or changes UI follows [docs/design/guidelines.md](docs/design/guidelines.md). Read it before starting. In short:

1. **Place it first.** Decide where it goes using the guidelines' "Where it goes": a setting goes to its Settings section (a self-contained card in `settingsSections`), an object's actions go in its sheet or ⋯ menu, analysis never goes above the transaction list. No new tabs or modes.
2. **Record the placement.** Add any new component to the feature-to-location table or Building blocks in `docs/design/information-architecture.md`.
3. **Build with today's pieces.** Use the classes in the guidelines' "Which class to use today" table and the 11 `var(--…)` colors in `app/globals.css`. No color literals, no inline spacing or type in `style={{}}`, nothing under 12px. Space stacked siblings with `.stack`.
4. **Keep the warnings.** Stale, incomplete and reconnect notices keep their words and severity; critical ones stay on the number in full. `docs/features.md` explains why they exist.
5. **Format money.** Write amounts through `lib/format.ts`, so hide amounts masks them.
6. **Run the guard.** Run `bun test test/design-guard.test.ts` while working. When a count falls, lower that file's number in `test/design-guard-baseline.json` in the same change. Never raise one: fix the code.
7. **Change the design deliberately.** A new color, size or component pattern is a design-system change. Update `docs/design/design-system.md` and `docs/design/tokens.css`, and `docs/design/mockups/index.html` if a screen changes.
8. **Move toward the target in order.** Work that moves the app toward the target design follows `docs/design/rollout.md`, one phase per pull request.

## Writing

No em or en dashes anywhere: code comments, docs, commit messages, UI copy. Use commas, colons, parentheses or separate sentences.
