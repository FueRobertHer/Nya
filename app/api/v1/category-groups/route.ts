import { serveResource, notTaken } from '@/lib/api-http';
import { resourceSpec } from '@/lib/api-spec';

// POST /api/v1/category-groups: adds a category group. With an API token
// (lib/api-tokens.ts) that may do it, through the gate every operation passes
// (lib/api-run.ts). Its fields are declared in lib/api-spec.ts and it runs in
// lib/api-writes.ts; both are documented on the developer page
// (app/developers).

// Shorter than a create with an Idempotency-Key waits before another
// request takes it over (lib/api-writes.ts).
export const maxDuration = 30;

const create = resourceSpec('category-groups.create');

export const POST = (req: Request) => serveResource(req, create);

// Every other method is refused in the API's own error shape, as this copy
// is set up (lib/api-http.ts notTaken).
export const GET = () => notTaken('category-groups');
export const PATCH = () => notTaken('category-groups');
export const PUT = () => notTaken('category-groups');
export const DELETE = () => notTaken('category-groups');
