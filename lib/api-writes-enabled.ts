// lib/api-writes-enabled.ts
//
// Whether this copy of Nya lets tokens make changes (API_WRITES_ENABLED=1,
// docs/operations.md). Off, the default: no token can be made with more than
// read access, every write through the API or the MCP server is refused
// (`writes_off`), no write tool is listed, and the privacy, security and
// developer pages, and the API tokens card, read as they did before writing
// existed. Tokens already made go on reading what their access lets them,
// and the record of changes, with its Undo and Forget, stays in the app.
//
// Read from the environment at request time, but set in the deployment's
// environment, so changing it takes a redeploy.

export function apiWritesEnabled(): boolean {
  return process.env.API_WRITES_ENABLED === '1';
}
