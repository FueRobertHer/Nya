import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import InstitutionCard from '@/components/InstitutionCard';
import { ConnectionDetailsBody } from '@/components/ConnectionDetails';
import { severityOf } from '@/lib/accounts-status';
import { CONNECTION_CASES } from './connection-cases';
import before from './connection-words-before-3b.json';

// Rollout phase 3b folded the Connection health card and the SimpleFIN and
// Lunch Flow cards into the institution cards. Its risk: a warning dropped
// or reworded on the way. So every sentence those three cards showed for
// each connection state (recorded from main before the change, in
// test/connection-words-before-3b.json) must still be on the institution's
// card, on screen or behind its "Why?", never only in a sheet; what the
// SimpleFIN card said about itself (where it reaches, when it last
// answered, its history) is in Connection details.

const noop = () => {};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const card = (c: (typeof CONNECTION_CASES)[number]) =>
  renderToStaticMarkup(
    <InstitutionCard
      inst={c.inst}
      institutions={[c.inst]}
      base={null}
      shownCurrency="USD"
      connecting={false}
      expandedHoldings={new Set()}
      unallowedIds={new Set()}
      lifecycle={{ busy: false, open: noop, stillOpen: async () => null, confirmEnd: async () => null, reopen: async () => {} }}
      place={c.conn ? { conn: c.conn, first: true, firstName: null } : null}
      requestsLeft={5}
      onOpenAccount={noop}
      toggleHoldings={noop}
      onDetails={noop}
      onRemove={noop}
      onConnector={noop}
      startReconnect={noop}
      startAllowTransactions={noop}
      startEnableLiabilities={noop}
      startManageAccounts={noop}
    />
  );

type Recorded = { card: string[]; health: string[]; connectorWarnings: string[]; connectorNotes: string[] };
const recorded = before as Record<string, Recorded>;

describe('every word the three cards said is still on the institution’s card', () => {
  test('the recording covers every case', () => {
    expect(Object.keys(recorded).sort()).toEqual(CONNECTION_CASES.map((c) => c.name).sort());
  });

  for (const c of CONNECTION_CASES) {
    test(c.name, () => {
      const r = recorded[c.name];
      const shown = text(card(c));
      // "Working" was the healthy row's badge; a healthy card says when it last synced instead.
      const sentences = [...r.card, ...r.health.filter((s) => s !== 'Working'), ...r.connectorWarnings];
      for (const s of sentences) expect([c.name, s, shown.includes(s)]).toEqual([c.name, s, true]);
      if (c.conn) {
        const details = text(renderToStaticMarkup(<ConnectionDetailsBody inst={c.inst} place={{ conn: c.conn, first: true, firstName: null }} requests={{ left: 5, limit: 8, resets_in_seconds: 3600 }} fx={null} onConnector={noop} />));
        for (const s of r.connectorNotes) expect([c.name, s, details.includes(s)]).toEqual([c.name, s, true]);
      }
    });
  }
});

describe('one color, each action once', () => {
  test('the card’s notice takes the one color the two questions give', () => {
    for (const c of CONNECTION_CASES) {
      const html = card(c);
      const severity = severityOf(c.inst, !!c.conn?.last_fetch?.note);
      const colors = [...html.matchAll(/<div class="notice (critical|caution)">/g)].map((m) => m[1]);
      if (severity === null) expect([c.name, colors]).toEqual([c.name, []]);
      else expect([c.name, colors[0]]).toEqual([c.name, severity]);
      // Its badge says the same.
      if (severity) expect([c.name, html.includes(`badge ${severity === 'critical' ? 'neg' : 'warn'}`) || !c.inst.health || c.inst.health.state === 'healthy']).toEqual([c.name, true]);
    }
  });

  test('no button or link is on a card twice', () => {
    for (const c of CONNECTION_CASES) {
      const html = card(c);
      const labels = [...html.matchAll(/<(button|a) [^>]*class="btn[^"]*"[^>]*>([^<]*)<\/\1>/g)].map((m) => m[2]);
      expect([c.name, labels.length]).toEqual([c.name, new Set(labels).size]);
    }
  });

  test('what needs the person comes with the button that fixes it', () => {
    const buttonsOf = (name: string) => {
      const c = CONNECTION_CASES.find((x) => x.name === name)!;
      return [...card(c).matchAll(/<(button|a) [^>]*class="btn[^"]*"[^>]*>([^<]*)<\/\1>/g)].map((m) => m[2].trim());
    };
    expect(buttonsOf('plaid login')).toContain('Reconnect');
    expect(buttonsOf('plaid consent_ending')).toEqual(['Reconnect']);
    expect(buttonsOf('plaid revoked, recovered')).toContain('Remove Chase');
    expect(buttonsOf('plaid vanished')).toContain('Add or remove accounts');
    expect(buttonsOf('connector refused')).toContain('Connect again');
    expect(buttonsOf('connector sign')).toContain('Answer');
    expect(buttonsOf('connector missing')).toContain('Choose accounts');
    expect(buttonsOf('connector gone')).toContain('Disconnect');
    expect(buttonsOf('connector reported')).toEqual(['Open SimpleFIN', 'Refresh']);
    // An outage clears itself: nothing to press but Refresh where there is one.
    expect(buttonsOf('plaid institution_down, recovered')).toEqual([]);
  });
});
