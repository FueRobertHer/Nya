// test/fixtures/release-before/storage.ts
//
// What the release before's code beside this file imports from lib/storage,
// taken from this release's, which a test mocks (test/fake-redis.ts), so the
// two releases read and write one store, as after a rollback. The other files
// here are that release's own, byte for byte, and test/release-before.test.ts
// checks each against its git blob: never edit them. To move to a newer
// release before, copy its files over them and change the hashes there.
export { redis, kEnv, envPrefix } from '@/lib/storage';
