import { serveResource, notTaken } from '@/lib/api-http';
import { resourceSpec } from '@/lib/api-spec';

// GET /api/v1/changes: the changes this token made, for a token that can make
// them. With an API token (lib/api-tokens.ts) that may do it, through the gate
// every operation passes (lib/api-run.ts). Its fields are declared in lib/api-
// spec.ts and it runs in lib/api-writes.ts; both are documented on the
// developer page (app/developers).

const list = resourceSpec('changes.list');

export const GET = (req: Request) => serveResource(req, list);

// Every other method is refused in the API's own error shape, as this copy
// is set up (lib/api-http.ts notTaken).
export const POST = () => notTaken('changes');
export const PATCH = () => notTaken('changes');
export const PUT = () => notTaken('changes');
export const DELETE = () => notTaken('changes');
