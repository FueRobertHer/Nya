@AGENTS.md

# Working on Nya

## Commands

- `bun test` runs the whole suite; `bun test test/<name>.test.ts` runs one file.
- `bun run typecheck` runs `tsc --noEmit`.
- Run both before calling a change done.
- CI (`.github/workflows/ci.yml`, Ubuntu with a real Redis) runs the same pair and is the reference. Tests that fail on Windows but pass in CI are a portability bug in the test: compare paths with `/` (`relative(...).replaceAll('\\', '/')`), find tools with `Bun.which`, not `sh`. Before blaming a change, run the suite on `main` and compare the failing sets.

## Branches and worktrees

- Build each pull request in its own worktree outside this checkout, so the checkout's own uncommitted files stay out of it: `git worktree add -b <branch> C:/Users/Fue/repo/worktrees/Nya/<name> origin/main`, then `bun install` there.
- Once the PR merges, remove the worktree (`git worktree remove C:/Users/Fue/repo/worktrees/Nya/<name>`) and delete its branch (`git branch -d <branch>`).

## Line endings

- Files keep the endings they were committed with: most are LF, about 140 are CRLF, and `app/globals.css` is mixed (CRLF, then LF for its last `.stack` block). `git ls-files --eol` shows each file's.
- `.gitattributes` sets `* -text`, so git checks out each file's bytes as committed, whatever `core.autocrlf` says (tests read fixtures and sources byte for byte). A checkout made before that keeps the CRLF git wrote into it until it is checked out again: stash or commit, then `git rm -r --cached -q . && git reset --hard`. New worktrees need nothing. An editor or script can still rewrite a whole file's endings. After a scripted rewrite, check that `git diff --stat` counts only the lines you meant to change.

## Checking UI

- The dev server (`bun run dev`) reads `.env.development.local`, which points at the real Upstash Redis and Clerk, with the deployment's own password. Don't sign in or write through it.
- Prove UI behavior with view tests instead (`test/*-view.test.tsx`, with `test/fake-redis.ts` for storage).
- To check layout (320px fit, 44px targets, hover, focus), serve a static page that links `app/globals.css` and holds the markup in question, from a throwaway server outside the repo, and measure it in the browser.
- To look at real screens, use the public Preview demo linked in the README. Its sandbox demo accounts need no password, but it trails `main`.

## UI work

Every change that adds or changes UI follows [docs/design/guidelines.md](docs/design/guidelines.md). Read it before starting. In short:

1. **Place it first.** Decide where it goes using the guidelines' "Where it goes": a setting goes to its Settings section (a self-contained card in `settingsSections`), an object's actions go in its sheet or ⋯ menu, analysis never goes above the transaction list. No new tabs or modes.
2. **Record the placement.** Add any new component to the feature-to-location table or Building blocks in `docs/design/information-architecture.md`.
3. **Build with the primitives.** Use the classes in the guidelines' "Which class to use" table and the token colors (`var(--surface)`, `var(--text-2)`, ...) in `app/globals.css`, not today's aliases (`--card`, `--muted`, ...). No color literals, no inline spacing or type in `style={{}}`, nothing under 12px. Space stacked siblings with `.stack`.
4. **Keep the warnings.** Stale, incomplete and reconnect notices keep their words and severity; critical ones stay on the number in full. `docs/features.md` explains why they exist.
5. **Format money.** Write amounts through `lib/format.ts`, so hide amounts masks them.
6. **Run the guard.** Run `bun test test/design-guard.test.ts` while working. When a count falls, lower that file's number in `test/design-guard-baseline.json` in the same change. Never raise one: fix the code.
7. **Change the design deliberately.** A new color, size or component pattern is a design-system change. Update `docs/design/design-system.md` and `docs/design/tokens.css`, and `docs/design/mockups/index.html` if a screen changes.
8. **Move toward the target in order.** Work that moves the app toward the target design follows `docs/design/rollout.md`, one phase per pull request.

## Writing

No em or en dashes anywhere: code comments, docs, commit messages, UI copy. Use commas, colons, parentheses or separate sentences.
