import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { sendMail, mailConfig, mailConfigured, mailOff, forgetMailOffLogged, isEmailAddress, MailError } from '@/lib/mail';

// The mail module (lib/mail.ts): Resend's HTTP API through fetch, off unless
// both RESEND_API_KEY and MAIL_FROM are set, and never logging what it sends.

const saved = { ...process.env };
const logs: string[] = [];
const original = { log: console.log, error: console.error };
beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
  forgetMailOffLogged();
  logs.length = 0;
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  console.error = (...a: unknown[]) => void logs.push(a.join(' '));
});
afterEach(() => {
  process.env = { ...saved };
  console.log = original.log;
  console.error = original.error;
});

const on = () => {
  process.env.RESEND_API_KEY = 're_test_key';
  process.env.MAIL_FROM = 'Nya <alerts@example.com>';
};
const message = { to: ['me@example.com'], subject: 'Chase needs reconnecting', text: 'Reconnect it.', idempotencyKey: 'nya-connections-abc' };

/** A fetch that records each call and answers as told. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('with mail off', () => {
  test('nothing is sent, nothing is fetched, and one line says so', async () => {
    const f = fakeFetch(() => new Response('{}'));
    expect(await sendMail(message, { fetch: f.fn })).toEqual({ sent: false, reason: 'off' });
    expect(await sendMail(message, { fetch: f.fn })).toEqual({ sent: false, reason: 'off' });
    expect(f.calls).toHaveLength(0);
    expect(logs.filter((l) => l.includes('no email is sent'))).toHaveLength(1);
    expect(mailOff()).toBe(true);
    expect(logs).toHaveLength(1);
  });

  test('either half unset is off, and so is a sender that is not an address', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    expect(mailConfigured()).toBe(false);
    delete process.env.RESEND_API_KEY;
    process.env.MAIL_FROM = 'alerts@example.com';
    expect(mailConfigured()).toBe(false);
    process.env.RESEND_API_KEY = 're_test_key';
    expect(mailConfig()).toEqual({ apiKey: 're_test_key', from: 'alerts@example.com' });
    for (const from of ['Nya', 'alerts at example.com', 'Nya <alerts@example.com>\r\nBcc: x@y.z', '<>']) {
      process.env.MAIL_FROM = from;
      expect([from, mailConfigured()]).toEqual([from, false]);
    }
  });
});

describe('with mail on', () => {
  beforeEach(on);

  test("one POST to Resend's API, with the key, the idempotency key and the message", async () => {
    const f = fakeFetch(() => Response.json({ id: 'email_123' }));
    expect(await sendMail(message, { fetch: f.fn })).toEqual({ sent: true, id: 'email_123' });
    expect(f.calls).toHaveLength(1);
    const [{ url, init }] = f.calls;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_test_key');
    expect(headers['Idempotency-Key']).toBe('nya-connections-abc');
    expect(JSON.parse(String(init.body))).toEqual({
      from: 'Nya <alerts@example.com>',
      to: ['me@example.com'],
      subject: 'Chase needs reconnecting',
      text: 'Reconnect it.',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('a refusal throws, with the status and Resend’s error name, never its message', async () => {
    const f = fakeFetch(() => Response.json({ statusCode: 422, name: 'validation_error', message: 'Invalid `to`: me@example.com' }, { status: 422 }));
    const err = await sendMail(message, { fetch: f.fn }).catch((e) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err.status).toBe(422);
    expect(err.message).toContain('422, validation_error');
    expect(err.message).not.toContain('me@example.com');
  });

  test('no answer at all throws too: it is never taken for sent', async () => {
    const f = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    const err = await sendMail(message, { fetch: f.fn }).catch((e) => e);
    expect(err).toBeInstanceOf(MailError);
    expect(err.status).toBeNull();
    const server = fakeFetch(() => new Response('oops', { status: 500 }));
    expect((await sendMail(message, { fetch: server.fn }).catch((e) => e)).status).toBe(500);
  });

  test('only plain addresses are sent to, each once; none at all is refused', async () => {
    const f = fakeFetch(() => Response.json({ id: 'x' }));
    await sendMail({ ...message, to: ['me@example.com', 'me@example.com', 'Bad <x@y.z>', 'a@b.c,d@e.f', 'not-an-address'] }, { fetch: f.fn });
    expect(JSON.parse(String(f.calls[0].init.body)).to).toEqual(['me@example.com']);
    await expect(sendMail({ ...message, to: ['nobody'] }, { fetch: f.fn })).rejects.toBeInstanceOf(MailError);
    expect(f.calls).toHaveLength(1);
  });

  test('nothing about the message or the key reaches the log', async () => {
    const f = fakeFetch(() => Response.json({ id: 'x' }));
    await sendMail(message, { fetch: f.fn });
    await sendMail(message, { fetch: fakeFetch(() => new Response('', { status: 503 })).fn }).catch(() => {});
    expect(logs.join('\n')).not.toMatch(/re_test_key|me@example\.com|Reconnect it|Chase/);
  });
});

test('an address is one address', () => {
  for (const ok of ['me@example.com', 'first.last+tag@sub.example.co.uk']) expect(isEmailAddress(ok)).toBe(true);
  for (const bad of ['', 'me', 'me@', '@example.com', 'me@example', 'a b@example.com', 'a@b.c,d@e.f', 'Me <me@example.com>', 'me@example.com\n', 42, null]) {
    expect([bad, isEmailAddress(bad)]).toEqual([bad, false]);
  }
});
