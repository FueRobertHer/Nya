'use client';

// The other kinds of share in the Sharing drawer (#45 step 3,
// lib/share-kinds.ts): for one connection, whether they see my net worth,
// spending, holdings, budgets and goals, and at what level, beside the
// accounts above; and, under all of it, what they could work out from
// everything shared together beyond what it shows (lib/share-inference.ts),
// worked out on this device as the choices change, before anything is saved.
// The same warnings come back with the preview, worked out on the server from
// what they are shown. Never a refusal: Save stays as it is.
//
// Class names avoid "share" (see components/Sharing.tsx).

import { inferences, RESIDUAL_NOTE, type FactAccount, type FactGoal, type Inference } from '@/lib/share-inference';
import { KIND_NAME, KIND_WORDS, VIEW_KINDS, sharedKinds, type ShareViews, type ViewKind } from '@/lib/share-kinds';

/** A goal I could share, as the drawer is sent them (app/api/connections). */
export type ShareableGoal = { id: string; name: string; account_id: string | null };

/** The other kinds as a save sends them: every kind named, null for not
 *  shared, and a goals share that names no goal not shared. */
export function viewsToSave(draft: ShareViews): Record<ViewKind, unknown> {
  const out = {} as Record<ViewKind, unknown>;
  for (const kind of VIEW_KINDS) out[kind] = draft[kind] ?? null;
  if (draft.goals && draft.goals.goals.length === 0) out.goals = null;
  return out;
}

/** The same settings, in one form: for telling a draft from what is saved. */
function normal(v: ShareViews | undefined): string {
  const saved = viewsToSave(v ?? {});
  const goals = saved.goals as ShareViews['goals'] | null;
  return JSON.stringify({ ...saved, goals: goals ? { ...goals, goals: [...goals.goals].sort() } : null });
}
export const sameViews = (a: ShareViews | undefined, b: ShareViews | undefined) => normal(a) === normal(b);

/** "your net worth and your spending": the kinds shared, in words. */
export function kindsText(views: ShareViews | undefined): string {
  const words = sharedKinds(viewsWithGoals(views)).map((k) => KIND_WORDS[k]);
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** A goals share that names no goal shares nothing: left out. */
function viewsWithGoals(views: ShareViews | undefined): ShareViews {
  if (!views?.goals || views.goals.goals.length > 0) return views ?? {};
  const { goals: _none, ...rest } = views;
  return rest;
}

/** What someone can see of mine, in words, or null for nothing: "1 of your
 *  accounts", "2 of your accounts, your net worth and your spending", "your
 *  spending". */
export function seenText(accounts: number, views: ShareViews | undefined): string | null {
  const kinds = sharedKinds(viewsWithGoals(views)).map((k) => KIND_WORDS[k]);
  const counted = accounts === 0 ? [] : [accounts === 1 ? '1 of your accounts' : `${accounts} of your accounts`];
  const all = [...counted, ...kinds];
  if (all.length === 0) return null;
  return all.length === 1 ? all[0] : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`;
}

/** Each kind's levels, as its select offers them. What else a kind can show
 *  (the accounts in a net worth, the categories, the positions) is a box of
 *  its own beneath, so a closed select, however narrow, says the level. */
const CHOICES: Record<ViewKind, [string, string][]> = {
  net_worth: [
    ['none', 'Not shared'],
    ['total', 'The total now'],
    ['history', 'The total and its history'],
  ],
  spending: [
    ['none', 'Not shared'],
    ['shares', 'Percentages'],
    ['amounts', 'Amounts'],
  ],
  holdings: [
    ['none', 'Not shared'],
    ['shares', 'Percentages'],
    ['amounts', 'Amounts'],
  ],
  budgets: [
    ['none', 'Not shared'],
    ['progress', 'How much is spent'],
    ['amounts', 'Amounts'],
  ],
  goals: [
    ['none', 'Not shared'],
    ['progress', 'Progress'],
    ['amounts', 'Amounts'],
  ],
};

/** What each kind shows, beneath its choice. */
const WHAT: Record<ViewKind, string> = {
  net_worth: 'Each account’s newest balance added up, as on your Accounts tab, as an amount, and with its history, your chart, a point a week.',
  spending: 'What went out each month for the last six, by your categories. Never money in, or the transactions themselves.',
  holdings: 'Your investments by asset class and by tax bucket. Never an account’s name or number.',
  budgets: 'This month’s and last month’s budgets, with what is spent against each.',
  goals: 'The goals you choose, with their progress and when each is projected to be reached.',
};

/** A kind's level as its select's value. */
function choiceOf(kind: ViewKind, views: ShareViews): string {
  return views[kind]?.detail ?? 'none';
}

/** The settings with one kind's level chosen, keeping what else it had (an
 *  option, the goals chosen). */
function withChoice(views: ShareViews, kind: ViewKind, detail: string): ShareViews {
  const next: ShareViews = { ...views };
  if (detail === 'none') {
    delete next[kind];
    return next;
  }
  switch (kind) {
    case 'net_worth':
      next.net_worth = { detail: detail as 'total' | 'history', accounts: views.net_worth?.accounts ?? false };
      break;
    case 'spending':
      next.spending = { detail: detail as 'shares' | 'amounts', by: views.spending?.by ?? 'group' };
      break;
    case 'holdings':
      next.holdings = { detail: detail as 'shares' | 'amounts', positions: views.holdings?.positions ?? false };
      break;
    case 'budgets':
      next.budgets = { detail: detail as 'progress' | 'amounts', by: views.budgets?.by ?? 'group' };
      break;
    case 'goals':
      next.goals = { detail: detail as 'progress' | 'amounts', goals: views.goals?.goals ?? [] };
      break;
  }
  return next;
}

/** What they could work out, beneath what is chosen or shown: each warning,
 *  and that no list is a promise. */
export function InferenceNotes({ found }: { found: readonly Inference[] }) {
  return (
    <div className="kind-warnings" role="note">
      {found.length > 0 && <p className="section-label">What they could work out</p>}
      {found.map((i) => (
        <p key={i.id} className="stale-note">
          {i.text}
        </p>
      ))}
      <p className="panel-note">{RESIDUAL_NOTE}</p>
    </div>
  );
}

/**
 * The choices for the other kinds on one connection, and what they could
 * work out from all that is chosen together (with `accounts`, the accounts
 * above at the levels chosen). `goals` are mine to choose from; null when
 * they couldn't be read, when those chosen stay chosen and no more can be.
 */
export function KindsEditor({
  views,
  onChange,
  goals,
  accounts,
  who,
}: {
  views: ShareViews;
  onChange: (views: ShareViews) => void;
  goals: ShareableGoal[] | null;
  accounts: FactAccount[];
  /** What I call them. */
  who: string;
}) {
  const chosen = new Set(views.goals?.goals ?? []);
  const factGoals: FactGoal[] = (goals ?? []).filter((g) => chosen.has(g.id)).map((g) => ({ name: g.name, projected: g.account_id !== null, account_id: g.account_id }));
  const found = inferences({ accounts, views: viewsWithGoals(views), goals: factGoals });
  const toggleGoal = (id: string) => {
    const ids = chosen.has(id) ? [...chosen].filter((g) => g !== id) : [...chosen, id];
    onChange({ ...views, goals: { detail: views.goals!.detail, goals: ids } });
  };
  const unlisted = [...chosen].filter((id) => !(goals ?? []).some((g) => g.id === id));
  // A box under a kind's choice, for what else it shows, named with its kind
  // wherever two kinds' boxes say the same, so a screen reader tells them apart.
  const option = (label: string, checked: boolean, set: (on: boolean) => void, name?: string) => (
    <label className="plan-check">
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} {...(name ? { 'aria-label': name } : {})} />
      {label}
    </label>
  );
  return (
    <div className="kinds-editor">
      <p className="section-label" style={{ marginTop: 16 }}>
        More than accounts
      </p>
      {VIEW_KINDS.map((kind) => (
        <div key={kind} className="kind-row">
          <div className="kind-choice">
            <span className="kind-name">{KIND_NAME[kind]}</span>
            <select value={choiceOf(kind, views)} onChange={(e) => onChange(withChoice(views, kind, e.target.value))} aria-label={`What ${who} sees of ${KIND_WORDS[kind]}`}>
              {CHOICES[kind].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {views[kind] && <p className="panel-note kind-what">{WHAT[kind]}</p>}
          {kind === 'net_worth' &&
            views.net_worth &&
            option('With the accounts in it whose balances you share above, each with its balance', views.net_worth.accounts, (on) =>
              onChange({ ...views, net_worth: { ...views.net_worth!, accounts: on } })
            )}
          {kind === 'spending' &&
            views.spending &&
            option(
              'By category too, within each group',
              views.spending.by === 'category',
              (on) => onChange({ ...views, spending: { ...views.spending!, by: on ? 'category' : 'group' } }),
              'Spending by category too, within each group'
            )}
          {kind === 'holdings' &&
            views.holdings &&
            option('With the positions in them', views.holdings.positions, (on) => onChange({ ...views, holdings: { ...views.holdings!, positions: on } }))}
          {kind === 'budgets' &&
            views.budgets &&
            option(
              'By category too, within each group',
              views.budgets.by === 'category',
              (on) => onChange({ ...views, budgets: { ...views.budgets!, by: on ? 'category' : 'group' } }),
              'Budgets by category too, within each group'
            )}
          {kind === 'goals' && views.goals && (
            <>
              {goals === null ? (
                <p className="stale-note">Your goals couldn’t be read just now, so no more can be chosen. Those chosen stay chosen.</p>
              ) : goals.length === 0 ? (
                <p className="panel-note">You have no goals to share.</p>
              ) : (
                goals.map((g) => (
                  <label key={g.id} className="plan-check">
                    <input type="checkbox" checked={chosen.has(g.id)} onChange={() => toggleGoal(g.id)} />
                    {g.name}
                  </label>
                ))
              )}
              {goals !== null && unlisted.length > 0 && (
                <p className="panel-note">
                  {`${unlisted.length === 1 ? 'A goal you chose is' : `${unlisted.length} goals you chose are`} archived or deleted, so not shown; an archived one is shown again if you unarchive it. `}
                  <button className="link-btn" onClick={() => onChange({ ...views, goals: { detail: views.goals!.detail, goals: [...chosen].filter((id) => !unlisted.includes(id)) } })}>
                    {unlisted.length === 1 ? 'Stop sharing it' : 'Stop sharing them'}
                  </button>
                </p>
              )}
              {views.goals.goals.length === 0 && <p className="panel-note">Choose the goals they see: until you do, none is shared.</p>}
            </>
          )}
        </div>
      ))}
      <InferenceNotes found={found} />
    </div>
  );
}
