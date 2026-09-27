// A throwaway redis-server for the tests that run Lua against a real Redis.
//
// Started on a random port and checked with PING; a port something else
// already holds leaves the server unable to start, so it is retried on
// another rather than letting every test after it time out.

export type RealRedis = { client: InstanceType<typeof Bun.RedisClient>; stop: () => void };

export async function startRedis(): Promise<RealRedis> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 30000 + Math.floor(Math.random() * 20000);
    const server = Bun.spawn(['redis-server', '--port', String(port), '--save', '', '--appendonly', 'no'], { stdout: 'ignore', stderr: 'ignore' });
    const client = new Bun.RedisClient(`redis://127.0.0.1:${port}`);
    for (let i = 0; i < 40; i++) {
      if (server.exitCode !== null) break; // it couldn't start (port taken): try another
      try {
        // A PING to a server that never started waits rather than failing.
        await Promise.race([client.send('PING', []), Bun.sleep(250).then(() => Promise.reject(new Error('no answer')))]);
        return {
          client,
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
