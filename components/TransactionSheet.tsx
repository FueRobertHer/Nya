'use client';

// A transaction's sheet, opened by its row on Activity's Transactions
// (docs/design/information-architecture.md#activity): what it is, then its
// category, tags and note, split or group, sharing, whether it counts, the
// rules it matches and its receipts, and the bank's details last. Rename
// vendor and, for a row entered by hand, Edit or delete are in its ⋯.
// Replaces the editor that opened inside the row.
//
// A split transaction's parts and a group's transactions are rows of their
// own, and open this sheet on themselves: a part's category and whether it
// counts, a group's transaction taken out of it.
//
// Changes shown at once (a category, an exclusion, tags and a note, a review)
// leave it open on the row as it now is; after a category, the offer to make
// a rule of it shows under the field. Changes the list shows only once it is
// read again (a part's, a group's, a rename) close it, as the editor closed.
// Each action that has a sheet of its own closes this one first, so no sheet
// opens on top of another.

import { useRef, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Menu, type MenuItem } from './Menu';
import { Masked } from './HideAmounts';
import { ALERT } from './ConnectionStatus';
import CategoryPicker from './CategoryPicker';
import TxnTagsNote, { type TagChange } from './TxnTagsNote';
import ReviewNote from './ReviewNote';
import AttachmentSection from './AttachmentSection';
import { SharedRowActions, SharedRowLine, type SharedRowHooks } from './SharedRows';
import { bankKept, entryNotice, heldInGroupAs, sendChange, splitKeptUnder, SplitActions } from './SplitRows';
import type { ReviewControls } from './review-state';
import type { CategoryChoice } from './transaction-edits';
import type { Txn } from './MonthBreakdown';
import { exclusionOffer, isLowConfidence, nameForRules, pairedWords } from './txn-words';
import { formatMoney, signedMoney } from '@/lib/format';
import { currencyOf } from '@/lib/spending';
import { displayName, type Taxonomy } from '@/lib/categories';
import { MIN_MEMBERS, PART_PREFIX } from '@/lib/split-rows';
import { isConnectorKind } from '@/lib/connectors/types';
import { IMPORTED_TXN_PREFIX, importedChangedNote } from '@/lib/history-import/view';
import { sourceLabel } from '@/lib/manual-txn-input';
import type { Tag } from '@/lib/tags';

/** What a row opens: a transaction, by its id in the list; a part of a split
 *  one, by its own id and its transaction's; a group's transaction, by its
 *  id and the group's row's. */
export type SheetTarget = { kind: 'txn'; id: string } | { kind: 'part'; parent: string; id: string } | { kind: 'member'; group: string; id: string };

/** The rows a target names, found in the list as it is now. */
export type SheetRows =
  | { kind: 'txn'; t: Txn }
  | { kind: 'part'; parent: Txn; part: Txn }
  | { kind: 'member'; group: Txn; member: Txn };

/** Finds what a target names among the rows put back whole (lib/split-rows.ts
 *  bankRows), by id: null once it is gone (posted under a new id, deleted,
 *  split or grouped away). */
export function findTarget(target: SheetTarget | null, byId: ReadonlyMap<string, Txn>): SheetRows | null {
  if (!target) return null;
  if (target.kind === 'txn') {
    const t = byId.get(target.id);
    return t ? { kind: 'txn', t } : null;
  }
  if (target.kind === 'part') {
    const parent = byId.get(target.parent);
    const part = parent?.split_parts?.find((p) => p.transaction_id === target.id);
    return parent && part ? { kind: 'part', parent, part } : null;
  }
  const group = byId.get(target.group);
  const member = group?.group_members?.find((m) => m.transaction_id === target.id);
  return group && member ? { kind: 'member', group, member } : null;
}

/** Whether a row was entered by hand or imported into a manual account:
 *  not one SimpleFIN brought nor one imported into a linked account, which
 *  are the bank's or the file's record, whose category alone is the
 *  person's. Its sheet's ⋯ offers Edit or delete. */
export function editableByHand(t: Pick<Txn, 'source' | 'transaction_id' | 'group_members'>): boolean {
  return !!t.source && !isConnectorKind(t.source) && !t.transaction_id.startsWith(IMPORTED_TXN_PREFIX) && !t.group_members;
}

/**
 * What a row says under its name beside its category, and its sheet under its
 * amount: the notes about it that bear on what it counts as (an exclusion that
 * couldn't be read, a pair worked out, its split or group, how it is shared,
 * a file's amount the bank changed). In their words, on the row too: never
 * only in a sheet. `whole` is the transaction with every part of its split.
 */
export function TxnNotes({ t, whole, shared, as = 'span' }: { t: Txn; whole: Txn; shared?: SharedRowHooks; as?: 'span' | 'p' }) {
  const Note = as;
  const notice = entryNotice(whole);
  const paired = pairedWords(t);
  return (
    <>
      {t.excluded === null && <Note className="txn-row-note">Couldn&apos;t read whether you excluded this</Note>}
      {/* A pair Nya worked out between two SimpleFIN accounts
          (lib/manual-txns.ts): said, so a wrong one is seen and given a category. */}
      {paired && <Note className="txn-row-note">{paired}</Note>}
      {notice && <Note className="txn-row-note">{notice}</Note>}
      {shared && <SharedRowLine t={t} hooks={shared} as={as} />}
      {/* A bank row standing for a row imported from its file, which the bank changed since (#52). */}
      {t.imported_amount !== undefined && (
        <Note className="txn-row-note">
          <Masked>{importedChangedNote(t, (n) => formatMoney(n, currencyOf(t)))}</Masked>
        </Note>
      )}
    </>
  );
}

// A short "HH:MM" from Plaid's ISO datetime, in the viewer's locale. Null when
// the row carries only a posting date.
function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** "Thu, Oct 22, 2026". */
function longDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// "What is this charge?": the Plaid fields that answer it (the real merchant
// behind a processor, channel, place, time, website, reference and check
// numbers, and, for joint accounts, the owner), skipping any the row doesn't
// carry, under a heading; nothing when it carries none.
function TxnDetail({ t, noteEditor = false }: { t: Txn; noteEditor?: boolean }) {
  const rows: { label: string; value: ReactNode }[] = [];
  const time = fmtTime(t.datetime);

  if (t.counterparty) rows.push({ label: 'Merchant', value: t.counterparty });
  if (t.payment_processor) rows.push({ label: 'Processed by', value: t.payment_processor });
  if (t.payment_channel) rows.push({ label: 'Channel', value: t.payment_channel });
  if (t.city) rows.push({ label: 'Where', value: t.region ? `${t.city}, ${t.region}` : t.city });
  if (time) rows.push({ label: 'Time', value: time });
  if (t.website)
    rows.push({
      label: 'Website',
      value: (
        <a href={`https://${t.website.replace(/^https?:\/\//, '')}`} target="_blank" rel="noopener noreferrer">
          {t.website.replace(/^https?:\/\//, '')}
        </a>
      ),
    });
  if (t.payment_reference) rows.push({ label: 'Reference', value: t.payment_reference });
  if (t.check_number) rows.push({ label: 'Check #', value: t.check_number });
  if (t.account_owner) rows.push({ label: 'Owner', value: t.account_owner });
  if (t.note && !noteEditor) rows.push({ label: 'Note', value: t.note });

  if (rows.length === 0) return null;

  return (
    <section className="stack tight" aria-labelledby={`bank-${t.transaction_id}`}>
      <h3 className="txn-sheet-heading" id={`bank-${t.transaction_id}`}>
        Bank details
      </h3>
      <dl className="txn-detail">
        {rows.map((r) => (
          <div className="txn-detail-row" key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export type TransactionSheetProps = {
  open: boolean;
  /** What is open, as the list has it now; null draws nothing. */
  rows: SheetRows | null;
  onClose: () => void;
  /** The tab's currency, for a row with none of its own. */
  currency: string | null;
  /** What went wrong with the last change, said at the top while it is open. */
  errors: string[];
  taxonomy: Taxonomy | null;
  /** The categories to choose from without your own (categoryOptions). */
  pickable: string[];
  tags: Tag[];
  /** Every row loaded, for a receipt's "move to another transaction". */
  list: Txn[] | null;
  review?: ReviewControls;
  shared?: SharedRowHooks;
  ruleSentenceOf?: (id: string) => string | null;
  onRecategorize: (transaction_id: string, choice: CategoryChoice) => void;
  onRename: (vendor_key: string, name: string) => void;
  onEditTransaction?: (t: Txn) => void;
  onToggleExcluded?: (t: Txn, excluded: boolean) => void;
  onChangeTags?: (t: Txn, change: TagChange) => void;
  onSaveNote?: (t: Txn, note: string) => void;
  onCreateRule?: (t: Txn, category_id?: string) => void;
  /** Splits and groups (#39): the list read again after one changes;
   *  without it, nothing is offered to split or group. */
  onSplitsChanged?: () => void;
  onSplit: (t: Txn) => void;
  onGroup: (start: Txn | null, group: Txn | null) => void;
  /** What went wrong with a split or group change, or null once one is made. */
  onSplitError: (message: string | null) => void;
  onAttachmentsChanged?: () => void;
};

export default function TransactionSheet(props: TransactionSheetProps) {
  const { open, rows, onClose, errors } = props;
  if (!rows) return null;
  const said = errors.length > 0 && (
    <>
      {errors.map((e) => (
        <div className="notice critical" key={e}>
          {ALERT}
          <p>{e}</p>
        </div>
      ))}
    </>
  );
  if (rows.kind === 'part') return <PartSheet {...props} parent={rows.parent} part={rows.part} said={said} />;
  if (rows.kind === 'member') return <MemberSheet {...props} group={rows.group} member={rows.member} said={said} />;
  // The rules' sentences hold amounts: passed by name, so the hide-amounts
  // scan (test/amount-sources.ts) traces them to the dashboard, which a
  // spread hides from it.
  return <TxnSheet {...props} t={rows.t} said={said} open={open} onClose={onClose} ruleSentenceOf={props.ruleSentenceOf} />;
}

type Inner = TransactionSheetProps & { said: ReactNode };

function TxnSheet({
  open,
  t,
  said,
  onClose,
  currency,
  taxonomy,
  pickable,
  tags,
  list,
  review,
  shared,
  ruleSentenceOf,
  onRecategorize,
  onRename,
  onEditTransaction,
  onToggleExcluded,
  onChangeTags,
  onSaveNote,
  onCreateRule,
  onSplitsChanged,
  onSplit,
  onGroup,
  onSplitError,
  onAttachmentsChanged,
}: Inner & { t: Txn }) {
  // The category just chosen, while the offer to make a rule of it stands.
  const [offer, setOffer] = useState<string | null>(null);
  // Rename vendor, a second level of the sheet, and what is typed there.
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(t.name);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const act = (go: () => void) => () => {
    onClose();
    go();
  };
  const c = currencyOf(t) ?? currency;
  const exclusion = exclusionOffer(t);
  const countable = !!onToggleExcluded && !t.group_members && !t.group_outside;

  if (renaming && t.vendor_key) {
    const vendor = t.vendor_key;
    return (
      <Sheet
        open={open}
        title="Rename vendor"
        onClose={onClose}
        onBack={() => setRenaming(false)}
        footer={
          <button
            className="btn"
            disabled={draft.trim() === t.name}
            onClick={act(() => onRename(vendor, draft.trim()))}
          >
            Rename
          </button>
        }
      >
        <div className="stack">
          <label className="field">
            Name
            <input className="text-input" value={draft} maxLength={100} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <p className="helper">Applies to this vendor&apos;s transactions; older ones may update later.</p>
        </div>
      </Sheet>
    );
  }

  const more: MenuItem[] = [
    ...(t.vendor_key
      ? [
          {
            label: 'Rename vendor',
            onSelect: () => {
              setDraft(t.name);
              setRenaming(true);
            },
          },
        ]
      : []),
    ...(onEditTransaction && editableByHand(t) ? [{ label: 'Edit or delete', onSelect: act(() => onEditTransaction(t)) }] : []),
  ];

  // Its category: filed as its parts are, or as its group is, when split or
  // counted in a group dated before what is shown (#39). A group's row
  // files the group's net; the list shows that once it is read again.
  const category =
    t.split_parts || t.group_outside ? null : taxonomy ? (
      <label className="field">
        Category
        <CategoryPicker
          ref={categoryRef}
          taxonomy={taxonomy}
          value={t.category_id ?? taxonomy.uncategorized}
          onChange={(id) => {
            if (!id || id === t.category_id) return;
            if (t.group_members) {
              onClose();
              void sendChange('/api/transaction-groups', 'PATCH', { id: t.group_id, category_id: id }).then((failed) => {
                onSplitError(failed);
                onSplitsChanged?.();
              });
              return;
            }
            onRecategorize(t.transaction_id, { category_id: id });
            setOffer(id);
          }}
        />
      </label>
    ) : t.group_members ? null : (
      <label className="field">
        Category
        <select ref={categoryRef} className="text-input" value={t.category ?? 'other'} onChange={(e) => onRecategorize(t.transaction_id, { category: e.target.value })}>
          {pickable.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <Sheet open={open} title={t.name} onClose={onClose} footer={more.length > 0 ? <Menu label={`More for ${t.name}`} items={more} /> : undefined}>
      <div className="stack">
        {said}
        <div className="txn-sheet-hero">
          <p className={`txn-sheet-amount money${t.amount < 0 ? ' inflow' : ''}`}>
            <Masked>{signedMoney(-t.amount, c, { always: true })}</Masked>
          </p>
          <p className="helper">
            {longDay(t.date)} · {t.institution_name} · {t.account_name}
            {t.source ? ` · ${sourceLabel(t.source)}` : ''}
          </p>
          {/* Its row's chips, the exclusion in full. */}
          {(t.pending || isLowConfidence(t)) && (
            <p>
              {t.pending && <span className="badge">Pending</span>}{' '}
              {isLowConfidence(t) && <span className="badge warn">Check category</span>}
            </p>
          )}
          {t.excluded === true && <p className="helper">{t.excluded_by_rule ? 'Hidden by a rule: out of budgets and reports' : 'Excluded from budgets and reports'}</p>}
          <TxnNotes t={t} whole={t} shared={shared} as="p" />
        </div>

        {/* Its review and its merchant's default (components/ReviewNote.tsx). */}
        {review && <ReviewNote t={t} taxonomy={taxonomy} review={review} onChanged={() => onSplitsChanged?.()} />}

        {category}
        {/* The offer to do the same for every transaction with its name (#36). */}
        {offer && onCreateRule && (
          <div className="rule-offer stack tight">
            <p className="helper">
              Do the same for every transaction named “{nameForRules(t)}”
              {t.name_before_rules !== undefined && ` (shown as “${t.name}”)`}, past and future? A rule does it, and you can change or turn it off later.
            </p>
            <div className="btn-row">
              <button className="btn secondary" onClick={act(() => onCreateRule(t, offer))}>
                Make a rule
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  setOffer(null);
                  // The button goes with the offer: focus back to the field it was about.
                  categoryRef.current?.focus();
                }}
              >
                No thanks
              </button>
            </div>
          </div>
        )}

        {onChangeTags && onSaveNote && !t.group_members && (
          <TxnTagsNote
            key={`${t.transaction_id}:${t.note ?? ''}`}
            t={t}
            tags={tags}
            onChangeTags={(change) => onChangeTags(t, change)}
            onSaveNote={(note) => onSaveNote(t, note)}
          />
        )}

        {/* Splitting it, or grouping it with others (#39). */}
        {onSplitsChanged && (
          <SplitActions
            t={t}
            onSplit={act(() => onSplit(t))}
            onGroup={act(() => (t.group_members ? onGroup(null, t) : onGroup(t, null)))}
            onUngroup={(id) => {
              onClose();
              void sendChange('/api/transaction-groups', 'DELETE', { id }).then((failed) => {
                onSplitError(failed);
                onSplitsChanged();
              });
            }}
          />
        )}
        {/* Sharing it, or what it paid back (#49): each opens a Shared sheet. */}
        {shared && <SharedRowActions t={t} hooks={shared} onDone={onClose} />}

        {/* Offered once a pending row has posted (exclusionOffer), one a rule hides too. */}
        {countable && exclusion !== 'toggle' && (
          <p className="helper">
            {exclusion === 'wait-rule'
              ? 'A rule hides it. Once it posts, it can be put back in budgets and reports.'
              : 'Once it posts, it can be excluded from budgets and reports.'}
          </p>
        )}
        {countable && exclusion === 'toggle' && (
          <div className="stack tight">
            <div className="btn-row">
              <button className="btn secondary" onClick={() => onToggleExcluded!(t, t.excluded !== true)}>
                {t.excluded === true ? 'Include in budgets and reports' : 'Exclude from budgets and reports'}
              </button>
            </div>
            <p className="helper">
              {t.excluded === true
                ? 'Puts it back in totals, budgets, insights, bills and the Plan.'
                : 'For a one-off: it stays in this list, out of totals, budgets, insights, bills and the Plan.'}
            </p>
          </div>
        )}

        {ruleSentenceOf && (t.rule_ids?.length ?? 0) > 0 && (
          <div className="helper">
            {t.rule_ids!.length === 1 ? 'A rule matches it' : 'Rules match it'}, in the order they run (what you set here wins):
            <ul className="rule-matched">
              {t.rule_ids!.map((id) => {
                const sentence = ruleSentenceOf(id);
                return sentence ? (
                  <li key={id}>
                    <Masked>{sentence}</Masked>
                  </li>
                ) : null;
              })}
            </ul>
          </div>
        )}
        {onCreateRule && !t.group_members && (
          <div className="btn-row">
            <button className="btn secondary" onClick={act(() => onCreateRule(t))}>
              Create a rule from this
            </button>
          </div>
        )}

        {/* Its receipts and documents (#47), read as it opens. */}
        {onAttachmentsChanged && <AttachmentSection t={t} rows={list} onChanged={onAttachmentsChanged} />}
        {!t.group_members && <TxnDetail t={t} noteEditor={!!(onChangeTags && onSaveNote) && !t.pending} />}
      </div>
    </Sheet>
  );
}

/** A part of a split transaction: its category, whether it counts on its
 *  own, and the whole split. Each change closes it: the list shows it once
 *  it is read again. */
function PartSheet({ open, onClose, said, parent, part: p, taxonomy, onSplitsChanged, onSplit, onSplitError }: Inner & { parent: Txn; part: Txn }) {
  const c = currencyOf(parent);
  const label = p.category_name !== undefined ? p.category_name : p.category;
  const patch = (change: Record<string, unknown>) => {
    onClose();
    void sendChange('/api/transaction-splits', 'PATCH', { transaction_id: splitKeptUnder(parent), part_id: p.transaction_id.slice(PART_PREFIX.length), ...change }).then((failed) => {
      onSplitError(failed);
      onSplitsChanged?.();
    });
  };
  return (
    <Sheet
      open={open}
      title={`Part of ${parent.name}`}
      onClose={onClose}
      footer={
        <button
          className="btn secondary"
          onClick={() => {
            onClose();
            onSplit(parent);
          }}
        >
          Edit split
        </button>
      }
    >
      <div className="stack">
        {said}
        <div className="txn-sheet-hero">
          <p className={`txn-sheet-amount money${p.amount < 0 ? ' inflow' : ''}`}>
            <Masked>{signedMoney(-p.amount, c, { always: true })}</Masked>
          </p>
          <p className="helper">
            {label ? displayName(label) : 'No category'} · {longDay(parent.date)} · {parent.institution_name} · {parent.account_name}
          </p>
          {p.note && <p className="helper">{p.note}</p>}
          {p.split_remainder && (
            <p className="txn-row-note">
              {bankKept(parent) ? 'What the bank changed the amount by' : 'What the amount changed by'} since you split it: edit the split to place it.
            </p>
          )}
          {p.split_excluded && <p className="txn-row-note">Left out of budgets and reports on its own</p>}
        </div>
        {taxonomy && !p.split_remainder && (
          <label className="field">
            Category
            <CategoryPicker
              taxonomy={taxonomy}
              value={p.category_id ?? taxonomy.uncategorized}
              onChange={(id) => {
                if (id && id !== p.category_id) patch({ category_id: id });
              }}
            />
          </label>
        )}
        {!p.split_remainder && parent.excluded !== true && (
          <div className="btn-row">
            <button className="btn secondary" onClick={() => patch({ excluded: !p.split_excluded })}>
              {p.split_excluded ? 'Count this part again' : 'Leave this part out of budgets and reports'}
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** One of a group's transactions: as it is, and taken out of the group.
 *  Taking it out closes it: the list shows that once it is read again. */
function MemberSheet({ open, onClose, said, group, member: m, onSplitsChanged, onSplitError }: Inner & { group: Txn; member: Txn }) {
  const members = group.group_members ?? [];
  const c = currencyOf(group);
  return (
    <Sheet
      open={open}
      title={m.name}
      onClose={onClose}
      footer={
        members.length > MIN_MEMBERS ? (
          <button
            className="btn secondary"
            onClick={() => {
              onClose();
              void sendChange('/api/transaction-groups', 'PATCH', { id: group.group_id, remove: [heldInGroupAs(m)] }).then((failed) => {
                onSplitError(failed);
                onSplitsChanged?.();
              });
            }}
          >
            Take it out of the group
          </button>
        ) : undefined
      }
    >
      <div className="stack">
        {said}
        <div className="txn-sheet-hero">
          <p className={`txn-sheet-amount money${m.amount < 0 ? ' inflow' : ''}`}>
            <Masked>{signedMoney(-m.amount, c, { always: true })}</Masked>
          </p>
          <p className="helper">
            {longDay(m.date)} · {m.institution_name} · {m.account_name}
          </p>
          {/* What was said of it on its own doesn't change the group's net. */}
          {m.excluded === true && (
            <p className="txn-row-note">{m.excluded_by_rule ? 'A rule hides it' : 'You excluded it'}: in the group, it counts through the group.</p>
          )}
        </div>
        <p className="helper">In a group, it counts through the group’s total, under the group’s category.</p>
        {members.length <= MIN_MEMBERS && (
          <p className="helper">A group holds at least {MIN_MEMBERS} transactions: to take this one out, ungroup it from the group’s row.</p>
        )}
      </div>
    </Sheet>
  );
}
