// lib/demo-seed/household.ts
//
// The demo's household: Alex and Sam connected through Sharing, each sharing
// everything with the other, so a visitor sees what someone shares with a
// partner and what the partner sees. A reset ends every connection the
// account has (lib/demo-seed/reset.ts, so nobody else goes on seeing the next
// scenario), and then restores this one, last, once the scenario's accounts
// and goals are in.
//
// AS TWO PEOPLE WOULD SET IT UP. An invite from the other demo account,
// accepted by this one, then each one's share saved as the Sharing drawer
// saves it (lib/sharing.ts createInvite, acceptInvite, saveConnection), so
// it passes the same checks and is stored the same way as one made in the
// app. What each shares:
//   - every account that can be shared (hidden ones never are), with its
//     balance and transactions;
//   - net worth with its history and the accounts in it, spending and
//     budgets by category, holdings with their positions, and every goal
//     that isn't archived, all as amounts;
//   - with no end.
// The other account's share is saved again too: its accounts may be new
// since (its own reset), and its share ended with the connection.
//
// EITHER ORDER. Each reset restores the pair, whichever account it was, and a
// pair already connected (the other account's reset finished in between) is
// kept and its shares saved again, so two resets at once end connected.
//
// BEST EFFORT. A demo account that hasn't signed in here yet, a deployment
// naming only one, or a refusal from Sharing leaves the reset whole: the
// reason goes in its report instead.

import { acceptInvite, AlreadyConnected, connectionId, createInvite, myConnections, saveConnection, shareableAccounts, SharingRefused, type Level } from '../sharing';
import { shareableGoals } from '../share-views';
import { MAX_SHARED_GOALS, type ShareViews } from '../share-kinds';
import { DEMO_NAMES, demoUsers } from '../demo';
import { demoTarget, SeedRefused, type SeedTarget } from './guard';
import type { Ctx } from '../containers';

/** What each demo account shares with the other on every account. */
export const HOUSEHOLD_LEVEL: Level = 'transactions';

/** What each shares beyond accounts, given its goals. */
export function householdViews(goals: string[]): ShareViews {
  return {
    net_worth: { detail: 'history', accounts: true },
    spending: { detail: 'amounts', by: 'category' },
    holdings: { detail: 'amounts', positions: true },
    budgets: { detail: 'amounts', by: 'category' },
    ...(goals.length > 0 ? { goals: { detail: 'amounts', goals: goals.slice(0, MAX_SHARED_GOALS) } } : {}),
  };
}

/**
 * Connects the demo account `me` to the other demo account and saves what
 * each shares (see the header). Answers null once both shares are saved, or
 * why the household wasn't restored, for the reset's report. Throws only what
 * storage throws.
 */
export async function restoreHousehold(target: { ctx: Ctx; userId: string }): Promise<string | null> {
  const demos = demoUsers().filter((u) => (DEMO_NAMES as readonly string[]).includes(u.label));
  const mine = demos.find((u) => u.id === target.userId);
  const partner = demos.find((u) => u.id !== target.userId);
  if (!mine || !partner) return 'the share with the other demo account, since this environment names only one';
  const me = { ...target, name: mine.label };
  let them: SeedTarget | null;
  try {
    them = await demoTarget(partner.id);
  } catch (err) {
    if (err instanceof SeedRefused) return `the share with ${partner.label}: ${err.message}`;
    throw err;
  }
  if (!them) return `the share with ${partner.label}, who hasn’t signed in here yet`;

  const id = connectionId(me.userId, them.userId);
  const connected = (await myConnections(me.userId)).connections.some((c) => c.id === id);
  if (!connected) {
    try {
      const { token } = await createInvite(them.userId, { fromName: them.name, theirLabel: me.name });
      await acceptInvite(me.userId, token, them.name, me.name);
    } catch (err) {
      // Connected meanwhile, by the other account's own reset: kept.
      if (!(err instanceof AlreadyConnected)) {
        if (err instanceof SharingRefused) return `the share with ${them.name}: ${err.message}`;
        throw err;
      }
    }
  }

  for (const side of [me, them]) {
    const [accounts, goals] = await Promise.all([shareableAccounts(side.ctx), shareableGoals(side.ctx)]);
    try {
      await saveConnection(side.ctx, side.userId, id, {
        accounts: Object.fromEntries(accounts.map((a) => [a.id, HOUSEHOLD_LEVEL])),
        views: householdViews(goals.map((g) => g.id)),
        expires_at: null,
      });
    } catch (err) {
      if (err instanceof SharingRefused) return `what ${side.name} shares with ${side === me ? them.name : me.name}: ${err.message}`;
      throw err;
    }
  }
  return null;
}
