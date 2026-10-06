// A throwaway redis-server for the tests that run against a real Redis.
//
// Started on a random port and checked with PING; a port something else
// already holds leaves the server unable to start, so it is retried on
// another rather than letting every test after it time out. Each server gets
// a random password, so a server someone else runs on that port (which would
// answer a PING, and then be wiped by FLUSHALL) refuses the client instead.

type RedisClient = InstanceType<typeof Bun.RedisClient>;

/** `url` (with the password) opens another client on the same server. */
export type RealRedis = { client: RedisClient; url: string; stop: () => void };

export async function startRedis(): Promise<RealRedis> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const password = crypto.randomUUID().replace(/-/g, '');
    const server = Bun.spawn(['redis-server', '--port', String(port), '--save', '', '--appendonly', 'no', '--requirepass', password], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    const url = `redis://:${password}@127.0.0.1:${port}`;
    const client = new Bun.RedisClient(url);
    for (let i = 0; i < 40; i++) {
      if (server.exitCode !== null) break; // it couldn't start (port taken): try another
      try {
        // A PING to a server that never started waits rather than failing.
        await Promise.race([client.send('PING', []), Bun.sleep(250).then(() => Promise.reject(new Error('no answer')))]);
        return {
          client,
          url,
          stop: () => {
            client.close();
            server.kill();
          },
        };
      } catch {
        await Bun.sleep(50);
      }
    }
    client.close();
    server.kill();
  }
  throw new Error('Could not start a redis-server for the tests');
}

function parsedOr(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** What Upstash's default client does to GET's and HGET's answer: JSON is
 *  parsed, except a number that would not print back the same, and anything
 *  else comes back as the string it was. */
function upstashParse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const parsed = parsedOr(value);
  return typeof parsed === 'number' && String(parsed) !== value ? value : parsed;
}

/** What it does to each HGETALL value: parsed, except a number that is not a
 *  safe integer. */
function upstashParseField(value: string): unknown {
  const n = Number(value);
  return !Number.isNaN(n) && !Number.isSafeInteger(n) ? value : parsedOr(value);
}

/**
 * The commands of the Upstash client that the storage seam sends (lib/repo.ts
 * and lib/stored-json.ts), run on a real Redis and answered the way Upstash
 * answers them: values JSON-parsed on the way out where they parse, an empty
 * hash as null, HGETALL built as a plain object. Lets one suite run the same
 * assertions against test/fake-redis.ts and a real server: only the client
 * object is stood in for (Upstash speaks HTTP, which redis-server does not);
 * every command is the real server's to answer.
 *
 * `failNext` arms failures like the fake's, standing in for a request that
 * never reached the server; `sent` lists every command sent, by name.
 */
export function upstashOn(client: RedisClient) {
  const failing = new Map<string, number>();
  const sent: string[] = [];
  const call = (command: string, args: string[]): Promise<unknown> => {
    sent.push(command);
    const remaining = failing.get(command) ?? 0;
    if (remaining > 0) {
      if (remaining === 1) failing.delete(command);
      else failing.set(command, remaining - 1);
      return Promise.reject(new Error(`upstashOn: armed failure for ${command}`));
    }
    return client.send(command.toUpperCase(), args);
  };
  return {
    sent,
    failNext(command: string, times = 1): void {
      failing.set(command, (failing.get(command) ?? 0) + times);
    },
    get: async (key: string) => upstashParse(await call('get', [key])),
    set: (key: string, value: string, opts?: { ex?: number; px?: number; nx?: boolean }) =>
      call('set', [
        key,
        value,
        ...(opts?.ex !== undefined ? ['EX', String(opts.ex)] : []),
        ...(opts?.px !== undefined ? ['PX', String(opts.px)] : []),
        ...(opts?.nx ? ['NX'] : []),
      ]),
    del: async (...keys: string[]) => Number(await call('del', keys)),
    hget: async (key: string, field: string) => upstashParse(await call('hget', [key, field])),
    hgetall: async (key: string) => {
      const entries = Object.entries((await call('hgetall', [key])) as Record<string, string>);
      if (entries.length === 0) return null;
      const out: Record<string, unknown> = {};
      for (const [field, value] of entries) out[field] = upstashParseField(value);
      return out;
    },
    hset: async (key: string, kv: Record<string, string>) => Number(await call('hset', [key, ...Object.entries(kv).flat()])),
    hdel: async (key: string, ...fields: string[]) => Number(await call('hdel', [key, ...fields])),
    hlen: async (key: string) => Number(await call('hlen', [key])),
    hexists: async (key: string, field: string) => Number(await call('hexists', [key, field])),
  };
}
