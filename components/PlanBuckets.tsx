// components/PlanBuckets.tsx
//
// What the Invested assets and Annual savings sheets add for tax: the accounts
// by bucket, each opening a level with what is shared about it (whose it is, what
// it cost, whether a child's account counts), Roth contributions per person, and
// where a year of savings goes. Shown in both models: a fact about the money, and
// nothing the flat model's figures rest on but which accounts count (D7).
//
// Levels of the Plan's shared drawer (components/PlanTab.tsx). Every fact is
// shared by all plans, so with a copy open each is off, with the reason. An
// account's own growth is the plan's: its level hands it to the Invested assets
// sheet, whose Save keeps it with the rest of the sheet, in a copy too.

'use client';

import { useId, useState } from 'react';
import { BUCKET_NAMES, accountBucket, type TaxBucket } from '@/lib/allocation/buckets';
import { BucketForm } from './AllocationCard';
import { BUCKET_COLORS } from './allocation-text';
import CheckRows from './CheckRows';
import FieldError from './FieldError';
import { Masked, NO_EXAMPLE } from './HideAmounts';
import { Segmented } from './Segmented';
import { Notice } from './TotalCaveats';
import { Why } from './Why';
import { isChildAccount } from '@/lib/fire/child-accounts';
import { MAX_FACT_AMOUNT, type Owner, type TaxFactOp, type TaxFacts } from '@/lib/fire/tax-facts';
import { LIMITS, pctText } from '@/lib/fire/plan';
import { pct } from './plan-text';
import { normalizedAmountText } from '@/lib/manual-txn-input';
import type { BucketAccount, BucketsToday } from '@/lib/fire/buckets-today';
import type { ChildAccount } from '@/lib/fire/inputs';
import { byBucket, type SavingsSplit } from '@/lib/fire/savings-split';
import { HSA_WORDS, ROTH_HELD_NOTE, STILL_READING, UNCLASSIFIED_NOTE, accountSub, basisNote, bucketsWhy, leftOutLine, namesOf, rmdLine, rowTitle, splitNote, yieldWords } from './plan-buckets';

/** The drawer's level past the figure: an account, its bucket, or a person's Roth
 *  contributions. The title goes with it, for the drawer's head. */
export type FigureLevel =
  | { kind: 'account'; account_id: string; title: string }
  /** `back`: the account's title, for the level it goes back to. */
  | { kind: 'bucket'; account_id: string; title: string; back: string }
  | { kind: 'roth'; owner: Owner; title: string };

/** What the sheets need beyond the figure's own form. */
export type BucketSheet = {
  /** Under a detailed plan: when required withdrawals start, and what isn't known. */
  detail?: { rmdAges: { you: number; partner: number }; cautions: readonly string[] } | null;
  /** The accounts by bucket, with or without cash. */
  bucketsFor: (includeCash: boolean) => BucketsToday;
  /** When the balances were read, in words. */
  asOf: string | null;
  /** Whether rows the sheets rest on are still coming. */
  reading: boolean;
  /** Whether a partner is set, so there are two people to tell apart. */
  partner: boolean;
  tax: TaxFacts;
  /** A bucket the person chose, by account. */
  chosen: ReadonlyMap<string, TaxBucket>;
  level: FigureLevel | null;
  onLevel: (level: FigureLevel | null) => void;
  /** Saves one fact: true once the server has it, or why it wasn't. */
  saveFact: (op: TaxFactOp) => Promise<true | string>;
  /** Why the facts can't be changed here (a copy is open, or they haven't
   *  loaded); null while they can. */
  factsLocked: string | null;
  /** Saves an account's bucket (Portfolio's own setting), or goes back to its
   *  type's. */
  saveBucket: (account_id: string, bucket: TaxBucket | null) => Promise<boolean>;
  bucketsEditable: boolean;
};

/** Each account's own growth after inflation, as the Invested assets sheet holds
 *  it until its Save. */
export type SheetRates = {
  /** The plan's own rate, which an account without one grows at. */
  plan: number;
  /** Each account's own, by id. */
  rates: ReadonlyMap<string, number>;
  /** Hands an account's own (null: the plan's) to the sheet. */
  set: (account_id: string, growth: number | null) => void;
  /** The sheet's figure is your own: no account grows at a rate of its own. */
  typed: boolean;
  /** The sheet can't save, so nothing is handed to it. */
  off: boolean;
  /** A copy is open: its rates are its own, its facts every plan's. */
  copy: boolean;
};

type Money = (n: number) => string;

function AccountRow({ title, sub, value, onOpen }: { title: string; sub: string; value: string; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="list-row" onClick={onOpen}>
        <span className="list-row-text">
          <span className="list-row-title">{title}</span>
          {sub && (
            <span className="list-row-sub">
              <Masked>{sub}</Masked>
            </span>
          )}
        </span>
        <span className="list-row-value money">
          <Masked>{value}</Masked>
        </span>
      </button>
    </li>
  );
}

/** What a person has put into a Roth, opening its level. */
function RothRow({ row, sheet, money }: { row: BucketsToday['roth'][number]; sheet: BucketSheet; money: Money }) {
  return (
    <li>
      <button type="button" className="list-row" onClick={() => sheet.onLevel({ kind: 'roth', owner: row.owner, title: rothTitle(row.owner) })}>
        <span className="list-row-text">
          <span className="list-row-title">{rothTitle(row.owner)}</span>
          <span className="list-row-sub">
            {row.amount === null ? (
              <span className="badge">Not set yet</span>
            ) : (
              <>
                Put in <Masked>{money(row.amount)}</Masked>
              </>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Invested assets' accounts by bucket. */
export function BucketGroups({ today, sheet, mix, money, rates = null }: { today: BucketsToday; sheet: BucketSheet; mix: string | null; money: Money; /** Each account's own growth, said on its row; null when none applies. */ rates?: ReadonlyMap<string, number> | null }) {
  const names = namesOf(today);
  const openAccount = (a: { account_id: string; name: string; institution: string }) => sheet.onLevel({ kind: 'account', account_id: a.account_id, title: rowTitle(a, names) });
  // No Roth group to sit in, and the amounts typed still need a way to be changed
  // or cleared. Only those: with no Roth account, nothing asks for a partner's.
  const heldWithoutRoth = today.groups.some((g) => g.bucket === 'roth') ? [] : today.roth.filter((r) => r.amount !== null);
  return (
    <div className="stack loose">
      {today.groups.map((g) => (
        <section key={g.bucket} className="stack tight">
          <div className="bucket-head">
            <i style={{ background: BUCKET_COLORS[g.bucket] }} aria-hidden="true" />
            <h3>{BUCKET_NAMES[g.bucket]}</h3>
            <span className="money">
              <Masked>{money(g.total)}</Masked>
            </span>
          </div>
          {g.bucket === 'unclassified' && <p className="helper">{UNCLASSIFIED_NOTE}</p>}
          {sheet.detail && (g.bucket === 'tax-deferred' || g.bucket === 'unclassified') && <p className="helper">{rmdLine(sheet.detail.rmdAges, sheet.partner)}</p>}
          {sheet.detail && g.bucket === 'hsa' && <p className="helper">{HSA_WORDS}</p>}
          <ul className="list-rows">
            {g.accounts.map((a) => (
              <AccountRow key={a.account_id} title={rowTitle(a, names)} sub={[accountSub(a, money, sheet.partner), growsWords(rates?.get(a.account_id))].filter(Boolean).join(' · ')} value={money(a.value)} onOpen={() => openAccount(a)} />
            ))}
            {g.bucket === 'roth' && today.roth.map((r) => <RothRow key={r.owner} row={r} sheet={sheet} money={money} />)}
          </ul>
          {g.bucket === 'roth' &&
            sheet.detail?.cautions.map((c) => (
              <Notice key={c} level="caution">
                {c.replace(' on Invested assets', ' here')}
              </Notice>
            ))}
        </section>
      ))}
      {heldWithoutRoth.length > 0 && (
        <section className="stack tight">
          <h3 className="section-label">Roth contributions</h3>
          <p className="helper">{ROTH_HELD_NOTE}</p>
          <ul className="list-rows">
            {heldWithoutRoth.map((r) => (
              <RothRow key={r.owner} row={r} sheet={sheet} money={money} />
            ))}
          </ul>
        </section>
      )}
      {today.leftOut.accounts.length > 0 && (
        <section className="stack tight">
          <h3 className="section-label">Left out: a child&rsquo;s education</h3>
          <p className="helper">
            <Masked>{leftOutLine(today.leftOut, money)}</Masked>
          </p>
          <ul className="list-rows">
            {today.leftOut.accounts.map((a) => (
              <AccountRow key={a.account_id} title={rowTitle(a, names)} sub="Count it in your plan" value={a.value === null ? 'No balance' : money(a.value)} onOpen={() => openAccount(a)} />
            ))}
          </ul>
        </section>
      )}
      {mix && <p className="helper">{mix}</p>}
      <Why label="Why do buckets matter?">
        <p className="helper">{bucketsWhy(sheet.partner, !!sheet.detail)}</p>
      </Why>
    </div>
  );
}

/** An account's own growth, on its row. */
const growsWords = (rate: number | undefined) => (rate === undefined ? '' : `grows ${pct(rate)}`);

const rothTitle = (owner: Owner) => (owner === 'you' ? 'Your Roth contributions' : 'Your partner’s Roth contributions');

/** Annual savings' split, one line a bucket. */
export function SavingsSplitLines({ split, reading, heading = true }: { split: SavingsSplit; reading: boolean; heading?: boolean }) {
  return (
    <section className="stack tight">
      {heading && <h3 className="section-label">Where it goes</h3>}
      <dl className="txn-detail">
        {byBucket(split)
          .filter((s) => Math.round(s.share * 100) > 0)
          .map((s) => (
            <div key={s.bucket} className="txn-detail-row">
              <dt>{BUCKET_NAMES[s.bucket]}</dt>
              <dd className="money">{Math.round(s.share * 100)}%</dd>
            </div>
          ))}
      </dl>
      <p className="helper">{reading ? STILL_READING : splitNote(split.from)}</p>
    </section>
  );
}

/** Cancel and Save for a level: Cancel goes back, as the arrow does. `done`: the
 *  level only hands something to its sheet, which keeps it on its own Save. */
function LevelButtons({ onCancel, onSave, saving, off, done = false }: { onCancel: () => void; onSave: () => void; saving: boolean; off: boolean; done?: boolean }) {
  return (
    <div className="btn-row">
      <button type="button" className="btn secondary" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
      <button type="button" className="btn" onClick={onSave} disabled={saving || off}>
        {saving ? 'Saving…' : done ? 'Done' : 'Save'}
      </button>
    </div>
  );
}

/** A money figure typed in a field: null when empty, or the problem. These fields
 *  are text, not `type="number"`, which reports what it can't read ("105,000" in
 *  some browsers) as empty, and empty here erases the figure held. */
function readAmount(text: string, what: string): { amount: number | null } | { problem: string } {
  const t = text.trim();
  if (t === '') return { amount: null };
  const n = Number(normalizedAmountText(t) ?? NaN);
  if (!Number.isFinite(n) || n > MAX_FACT_AMOUNT) return { problem: `${what} must be a number, zero or more.` };
  return { amount: n };
}

/** A growth typed as a percent, read as the plan's own is (PlanForms' readNumber),
 *  or the problem. */
function readGrowth(text: string): { rate: number } | { problem: string } {
  const t = text.trim();
  const n = t === '' ? NaN : Number(t);
  const [min, max] = LIMITS.realReturn;
  if (!Number.isFinite(n) || n * 0.01 < min - 1e-12 || n * 0.01 > max + 1e-12) return { problem: `Its growth must be from ${pct(min)} to ${pct(max)}.` };
  return { rate: Number((n * 0.01).toFixed(6)) };
}

/** An account's facts, and its growth in the plan: a level of the drawer. Its
 *  facts save at once, and only when they changed; its growth goes to the sheet
 *  (`growth`), which keeps it on Save. Cancel leaves everything as it was, and a
 *  failed save stays open and says why. */
function AccountLevel({
  title,
  account,
  child,
  sheet,
  growth,
  money,
  onBack,
}: {
  title: string;
  /** In a bucket; null when it is a child's account left out of the plan. */
  account: BucketAccount | null;
  /** The left-out one, when it is. */
  child: ChildAccount | null;
  sheet: BucketSheet;
  /** The sheet's growth rates; null where there are none to set. */
  growth: SheetRates | null;
  money: Money;
  onBack: () => void;
}) {
  const id = (account ?? child)!.account_id;
  const subtype = account ? account.subtype : (child?.subtype ?? null);
  const locked = sheet.factsLocked;
  const typed = sheet.tax.basis.find((b) => b.account_id === id)?.amount ?? null;
  const heldOwner = sheet.tax.owners.find((o) => o.account_id === id)?.owner ?? 'you';
  const heldCount = sheet.tax.countAnyway.includes(id);
  const [owner, setOwner] = useState<Owner>(heldOwner);
  const [basis, setBasis] = useState(typed === null ? '' : String(typed));
  const [counted, setCounted] = useState(heldCount);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [wrong, setWrong] = useState('');
  const errorId = useId();
  // Facts that arrive while it is open, or a lock that comes or goes, are what
  // its facts start from again; what was typed for its growth stays.
  const [lockWas, setLockWas] = useState(locked);
  if (lockWas !== locked) {
    setLockWas(locked);
    setOwner(heldOwner);
    setBasis(typed === null ? '' : String(typed));
    setCounted(heldCount);
    setWrong('');
    setError('');
  }
  const ownHeld = growth?.rates.get(id);
  const [own, setOwn] = useState(ownHeld !== undefined);
  const [rateText, setRateText] = useState(growth ? pctText(ownHeld ?? growth.plan) : '');
  const [rateWrong, setRateWrong] = useState('');
  const rateId = useId();
  // A child's account left out isn't in the plan, so it grows at nothing; with your
  // own figure, everything grows at the plan's rate.
  const rates = account && growth && !growth.typed ? growth : null;
  const settable = !!rates && !rates.off;
  // Its facts can't change here, but its growth can: the button hands it over.
  const handsOnly = !!locked && settable;
  const showsBasis = account?.bucket === 'taxable' && account.basisFrom !== 'cash';
  // A partner since removed: the choice stays, to take the account back.
  const showsWhose = !!account && (sheet.partner || heldOwner === 'partner');
  const showsCount = isChildAccount(subtype);
  const save = async () => {
    const read = !locked && showsBasis ? readAmount(basis, 'Cost basis') : { amount: typed };
    const rate = settable && own ? readGrowth(rateText) : { rate: null };
    setWrong('problem' in read ? read.problem : '');
    setRateWrong('problem' in rate ? rate.problem : '');
    if ('problem' in read || 'problem' in rate) return;
    setError('');
    if (!locked && (owner !== heldOwner || read.amount !== typed || counted !== heldCount)) {
      setSaving(true);
      const done = await sheet.saveFact({ kind: 'account', account_id: id, owner, basis: read.amount, count: counted });
      setSaving(false);
      if (done !== true) {
        setError(done);
        return;
      }
    }
    if (settable) rates.set(id, rate.rate);
    onBack();
  };
  const value = account ? account.value : (child?.value ?? null);
  const institution = (account ?? child)!.institution;
  return (
    <div className="stack loose">
      <p className="helper">
        {institution}
        {value !== null && (
          <>
            {' · '}
            <Masked>{money(value)}</Masked>
          </>
        )}
      </p>
      {showsCount && (
        <CheckRows
          legend="A child’s education"
          rows={[{ key: 'count', title: 'Count it in your plan', sub: 'A 529 you’ll spend on yourself, say. Left out, it isn’t in invested assets, and what your bank pays into it isn’t in Annual savings.' }]}
          checked={counted ? ['count'] : []}
          onChange={(keys) => setCounted(keys.includes('count'))}
          disabled={saving || !!locked}
        />
      )}
      {showsWhose && (
        <div className="stack tight">
          <h3 className="section-label">Whose it is</h3>
          <Segmented
            label="Whose it is"
            options={[
              ['you', 'You'],
              ['partner', 'Your partner'],
            ]}
            value={owner}
            onChange={setOwner}
            disabled={saving || !!locked}
          />
        </div>
      )}
      {showsBasis && account && (
        <div className="stack tight">
          <label className="field">
            Cost basis
            <input inputMode="decimal" placeholder={NO_EXAMPLE} value={basis} onChange={(e) => setBasis(e.target.value)} disabled={saving || !!locked} aria-invalid={wrong ? true : undefined} aria-describedby={wrong ? errorId : undefined} />
          </label>
          {wrong && <FieldError id={errorId}>{wrong}</FieldError>}
          <p className="helper">{basisNote(account)}</p>
        </div>
      )}
      {locked && <p className="helper">{rates?.copy ? `${locked} Its growth is this copy’s own.` : locked}</p>}
      {account && growth && (
        <div className="stack tight">
          <h3 className="section-label">Growth after inflation</h3>
          {rates ? (
            <>
              <Segmented
                label="Growth after inflation"
                options={[
                  ['plan', `The plan’s ${pct(rates.plan)}`],
                  ['own', 'Its own'],
                ]}
                value={own ? 'own' : 'plan'}
                onChange={(v) => setOwn(v === 'own')}
                disabled={saving || rates.off}
              />
              {own && (
                <label className="field">
                  Its growth after inflation (% a year)
                  <input type="number" inputMode="decimal" data-percent step="0.5" value={rateText} onChange={(e) => setRateText(e.target.value)} disabled={saving || rates.off} aria-invalid={rateWrong ? true : undefined} aria-describedby={rateWrong ? rateId : undefined} />
                </label>
              )}
              {rateWrong && <FieldError id={rateId}>{rateWrong}</FieldError>}
            </>
          ) : (
            <p className="helper">With your own figure for invested assets, every account grows at the plan&rsquo;s {pct(growth.plan)} after inflation.</p>
          )}
        </div>
      )}
      {account?.bucket === 'taxable' && account.basisFrom !== 'cash' && (
        <div className="stack tight">
          <dl className="txn-detail">
            <div className="txn-detail-row">
              <dt>Dividends and interest</dt>
              <dd className="money">
                <Masked>{sheet.reading && account.income === null ? STILL_READING : yieldWords(account.income, account.yieldRate, money)}</Masked>
              </dd>
            </div>
          </dl>
          <p className="helper">From the last year&rsquo;s activity. A dividend its institution reports only as reinvested isn&rsquo;t counted.</p>
        </div>
      )}
      {account && (
        <ul className="list-rows">
          <li>
            <button type="button" className="list-row" disabled={saving} onClick={() => sheet.onLevel({ kind: 'bucket', account_id: id, title: 'Change its bucket', back: title })}>
              <span className="list-row-text">
                <span className="list-row-title">Change its bucket</span>
                <span className="list-row-sub">{account.chosen ? `${BUCKET_NAMES[account.bucket]}, as you set it` : `${BUCKET_NAMES[account.bucket]}, from its type`}</span>
              </span>
            </button>
          </li>
        </ul>
      )}
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
      <LevelButtons onCancel={onBack} onSave={() => void save()} saving={saving} off={!!locked && !handsOnly} done={handsOnly} />
    </div>
  );
}

/** A person's Roth contributions: a level of the drawer. */
function RothLevel({ owner, sheet, onBack }: { owner: Owner; sheet: BucketSheet; onBack: () => void }) {
  const held = sheet.tax.rothContributions.find((r) => r.owner === owner)?.amount ?? null;
  const [text, setText] = useState(held === null ? '' : String(held));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [wrong, setWrong] = useState('');
  const errorId = useId();
  const locked = sheet.factsLocked;
  const save = async () => {
    const read = readAmount(text, 'Put in so far');
    if ('problem' in read) {
      setWrong(read.problem);
      return;
    }
    setWrong('');
    setError('');
    setSaving(true);
    const done = await sheet.saveFact({ kind: 'roth', owner, amount: read.amount });
    setSaving(false);
    if (done === true) onBack();
    else setError(done);
  };
  return (
    <div className="stack loose">
      <p className="helper">
        What {owner === 'you' ? 'you’ve' : 'your partner has'} put into Roth IRAs over the years, not counting growth or conversions from the last five tax years. It can come out before 59½ with no tax or penalty. A Roth 401(k) has its own rules: leave it out unless it’s been rolled into a Roth IRA.
      </p>
      <div className="stack tight">
        <label className="field">
          Put in so far
          <input inputMode="decimal" placeholder={NO_EXAMPLE} value={text} onChange={(e) => setText(e.target.value)} disabled={saving || !!locked} aria-invalid={wrong ? true : undefined} aria-describedby={wrong ? errorId : undefined} />
        </label>
        {wrong && <FieldError id={errorId}>{wrong}</FieldError>}
        {held !== null && !locked && <p className="helper">Empty it and save to clear it.</p>}
      </div>
      {locked && <p className="helper">{locked}</p>}
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
      <LevelButtons onCancel={onBack} onSave={() => void save()} saving={saving} off={!!locked} />
    </div>
  );
}

/** Whichever level is open. An account gone since it was opened (hidden, or
 *  disconnected) shows nothing and goes back by the arrow. Facts that arrive
 *  while one is open are the ones it starts from: a Roth level is keyed by the
 *  lock, and an account's starts its facts again on its own (what was typed for
 *  its growth stays). `growth`: the Invested assets sheet's rates. */
export function BucketLevel({ level, today, sheet, money, growth = null }: { level: FigureLevel; today: BucketsToday; sheet: BucketSheet; money: Money; growth?: SheetRates | null }) {
  const lock = sheet.factsLocked ?? '';
  if (level.kind === 'roth') return <RothLevel key={`${level.owner}:${lock}`} owner={level.owner} sheet={sheet} onBack={() => sheet.onLevel(null)} />;
  const account = today.groups.flatMap((g) => g.accounts).find((a) => a.account_id === level.account_id) ?? null;
  const child = today.leftOut.accounts.find((a) => a.account_id === level.account_id) ?? null;
  if (!account && !child) return null;
  const inBucket = level.kind === 'bucket';
  const title = inBucket ? level.back : level.title;
  const back = () => sheet.onLevel({ kind: 'account', account_id: level.account_id, title });
  return (
    <>
      {/* The account's level stays under its bucket's, so what was typed in it is
          there on the way back. */}
      <div hidden={inBucket}>
        <AccountLevel key={level.account_id} title={title} account={account} child={child} sheet={sheet} growth={growth} money={money} onBack={() => sheet.onLevel(null)} />
      </div>
      {inBucket && account && (
        <>
          <BucketForm
            label={account.name}
            bucket={accountBucket(account.subtype, sheet.chosen.get(account.account_id))}
            editable={sheet.bucketsEditable}
            onSave={async (b) => {
              const saved = await sheet.saveBucket(account.account_id, b);
              if (saved) back();
              return saved;
            }}
            onCancel={back}
          />
          {!sheet.bucketsEditable && sheet.factsLocked && <p className="helper">{sheet.factsLocked}</p>}
        </>
      )}
    </>
  );
}
