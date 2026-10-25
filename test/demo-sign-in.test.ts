import { describe, expect, test } from 'bun:test';
import { demoSignIn, type TicketClerk } from '@/components/demo-sign-in';
import { DEMO_UNAVAILABLE } from '@/lib/demo';

// A demo button's sign-in, in place (components/demo-sign-in.ts): the ticket
// from app/api/demo/sign-in as JSON, then Clerk's sign-in with it and its
// move to Home. Whatever fails says so, in the route's words where it gave
// some.

type Call = { url: string; accept: string | null; user: FormDataEntryValue | null };

function route(answer: Response | Error) {
  const calls: Call[] = [];
  const post = (async (url: string, init: RequestInit) => {
    calls.push({ url, accept: new Headers(init.headers).get('accept'), user: (init.body as FormData).get('user') });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { post, calls };
}

function fakeClerk(attempt: { status: string | null; createdSessionId: string | null } | Error, setActiveFails = false) {
  const created: unknown[] = [];
  const activated: unknown[] = [];
  const clerk: TicketClerk = {
    client: {
      signIn: {
        create: async (params) => {
          created.push(params);
          if (attempt instanceof Error) throw attempt;
          return attempt;
        },
      },
    },
    setActive: async (params) => {
      activated.push(params);
      if (setActiveFails) throw new Error('clerk down');
    },
  };
  return { clerk, created, activated };
}

const ticketAnswer = () => Response.json({ ticket: 'ticket-for-user_alex' });

describe('a demo sign-in in place', () => {
  test('asks the route for the ticket as JSON, signs in with it, and moves to Home', async () => {
    const { post, calls } = route(ticketAnswer());
    const { clerk, created, activated } = fakeClerk({ status: 'complete', createdSessionId: 'sess_1' });
    expect(await demoSignIn('user_alex', clerk, post)).toEqual({ ok: true });
    expect(calls).toEqual([{ url: '/api/demo/sign-in', accept: 'application/json', user: 'user_alex' }]);
    expect(created).toEqual([{ strategy: 'ticket', ticket: 'ticket-for-user_alex' }]);
    expect(activated).toEqual([{ session: 'sess_1', redirectUrl: '/' }]);
  });

  test('the route’s own words when it refuses (too many from this address)', async () => {
    const { post } = route(Response.json({ error: 'Too many demo sign-ins. Try again in a few minutes.' }, { status: 429 }));
    const { clerk, created } = fakeClerk({ status: 'complete', createdSessionId: 'sess_1' });
    expect(await demoSignIn('user_alex', clerk, post)).toEqual({ ok: false, error: 'Too many demo sign-ins. Try again in a few minutes.' });
    expect(created).toEqual([]);
  });

  test('that it couldn’t just now, for everything else', async () => {
    const complete = { status: 'complete', createdSessionId: 'sess_1' };
    const cases: [ReturnType<typeof route>, ReturnType<typeof fakeClerk>][] = [
      // The route unreachable, or answering without words or a ticket.
      [route(new Error('offline')), fakeClerk(complete)],
      [route(new Response('oops', { status: 502 })), fakeClerk(complete)],
      [route(Response.json({})), fakeClerk(complete)],
      // Clerk refusing the ticket, wanting more than it, or failing to move.
      [route(ticketAnswer()), fakeClerk(new Error('ticket expired'))],
      [route(ticketAnswer()), fakeClerk({ status: 'needs_second_factor', createdSessionId: null })],
      [route(ticketAnswer()), fakeClerk(complete, true)],
    ];
    for (const [{ post }, { clerk }] of cases) expect(await demoSignIn('user_alex', clerk, post)).toEqual({ ok: false, error: DEMO_UNAVAILABLE });
  });

  test('without Clerk’s client, nothing is signed in with', async () => {
    const { post } = route(ticketAnswer());
    const { clerk, activated } = fakeClerk({ status: 'complete', createdSessionId: 'sess_1' });
    expect(await demoSignIn('user_alex', { ...clerk, client: null }, post)).toEqual({ ok: false, error: DEMO_UNAVAILABLE });
    expect(activated).toEqual([]);
  });
});
