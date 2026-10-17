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
 *  accounts", "2 of your accounts and your net worth", "your spending". */
export function seenText(accounts: number, views: ShareViews | undefined): string | null {
  const kinds = kindsText(views);
  const counted = accounts === 0 ? '' : accounts === 1 ? '1 of your accounts' : `${accounts} of your accounts`;
  if (!counted) return kinds || null;
  return kinds ? `${counted} and ${kinds}` : counted;
}

const CHOICES: Record<ViewKind, [string, string][]> = {
  net_worth: [
    ['none', 'Not shared'],
    ['total', 'The total now'],
    ['history', 'The total and its history'],
  ],
  spending: [
    ['none', 'Not shared'],
    ['shares:group', 'Percentages, by group'],
    ['shares:category', 'Percentages, by group and category'],
    ['amounts:group', 'Amounts, by group'],
    ['amounts:category', 'Amounts, by group and category'],
  ],
  holdings: [
    ['none', 'Not shared'],
    ['shares', 'Percentages'],
    ['amounts', 'Amounts'],
  ],
  budgets: [
    ['none', 'Not shared'],
    ['progress:group', 'How much is spent, by group'],
    ['progress:category', 'How much is spent, by group and category'],
    ['amounts:group', 'Amounts, by group'],
    ['amounts:category', 'Amounts, by group and category'],
  ],
  goals: [
    ['none', 'Not shared'],
    ['progress', 'Progress'],
    ['amounts', 'Amounts'],
  ],
};

/** What each kind shows, beneath its choice. */
const WHAT: Record<ViewKind, string> = {
  net_worth: 'Each account’s newest balance added up, as on your Accounts tab, and with its history, your chart, a point a week.',
  spending: 'What went out each month for the last six, by your categories. Never money in, or the transactions themselves.',
  holdings: 'Your investments by asset class and by tax bucket. Never an account’s name or number.',
  budgets: 'This month’s and last month’s budgets, with what is spent against each.',
  goals: 'The goals you choose, with their progress and when each is projected to be reached.',
};

/** A kind's setting as its select's value. */
function choiceOf(kind: ViewKind, views: ShareViews): string {
  switch (kind) {
    case 'net_worth':
      return views.net_worth?.detail ?? 'none';
    case 'spending':
      return views.spending ? `${views.spending.detail}:${views.spending.by}` : 'none';
    case 'holdings':
      return views.holdings?.detail ?? 'none';
    case 'budgets':
      return views.budgets ? `${views.budgets.detail}:${views.budgets.by}` : 'none';
    case 'goals':
      return views.goals?.detail ?? 'none';
  }
}

/** The settings with one kind's choice made, keeping what else it had (an
 *  option, the goals chosen). */
function withChoice(views: ShareViews, kind: ViewKind, value: string): ShareViews {
  const next: ShareViews = { ...views };
  if (value === 'none') {
    delete next[kind];
    return next;
  }
  const [detail, by] = value.split(':');
  switch (kind) {
    case 'net_worth':
      next.net_worth = { detail: detail as 'total' | 'history', accounts: views.net_worth?.accounts ?? false };
      break;
    case 'spending':
      next.spending = { detail: detail as 'shares' | 'amounts', by: by as 'group' | 'category' };
      break;
    case 'holdings':
      next.holdings = { detail: detail as 'shares' | 'amounts', positions: views.holdings?.positions ?? false };
      break;
    case 'budgets':
      next.budgets = { detail: detail as 'progress' | 'amounts', by: by as 'group' | 'category' };
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
  return (
    <div className="kinds-editor">
      <p className="section-label" style={{ marginTop: 16 }}>
        More than accounts
      </p>
      {VIEW_KINDS.map((kind) => (
        <div key={kind} className="kind-row">
          <div className="peer-row">
            <span>{KIND_NAME[kind]}</span>
            <select value={choiceOf(kind, views)} onChange={(e) => onChange(withChoice(views, kind, e.target.value))} aria-label={`What ${who} sees of ${KIND_WORDS[kind]}`}>
              {CHOICES[kind].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {views[kind] && <p className="panel-note kind-what">{WHAT[kind]}</p>}
          {kind === 'net_worth' && views.net_worth && (
            <label className="plan-check">
              <input type="checkbox" checked={views.net_worth.accounts} onChange={(e) => onChange({ ...views, net_worth: { ...views.net_worth!, accounts: e.target.checked } })} />
              With the accounts behind it, each with its balance
            </label>
          )}
          {kind === 'holdings' && views.holdings && (
            <label className="plan-check">
              <input type="checkbox" checked={views.holdings.positions} onChange={(e) => onChange({ ...views, holdings: { ...views.holdings!, positions: e.target.checked } })} />
              With the positions in them
            </label>
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
                <p className="panel-note">{`${unlisted.length === 1 ? 'A goal chosen is' : `${unlisted.length} goals chosen are`} archived or gone, and not shown.`}</p>
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
