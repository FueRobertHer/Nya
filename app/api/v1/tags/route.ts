import { serve, serveResource, notTaken } from '@/lib/api-http';
import { operation } from '@/lib/api-ops';
import { resourceSpec } from '@/lib/api-spec';

// GET /api/v1/tags: Your tags. Read-only, with an API token
// (lib/api-tokens.ts), from stored data alone. Its arguments are declared in
// lib/api-spec.ts and its answer is built in lib/api-tags.ts; both are
// documented on the developer page (app/developers).

const op = operation('tags');

export const GET = (req: Request) => serve(req, op);

// POST adds a tag (lib/api-writes.ts), with a token that may make changes.
// While this copy doesn't let tokens make changes, it answers 405, as before.
const create = resourceSpec('tags.create');
export const maxDuration = 30;
export const POST = (req: Request) => serveResource(req, create);

// Every other method is refused in the API's own error shape, as this copy
// is set up (lib/api-http.ts notTaken).
export const PUT = () => notTaken('tags');
export const PATCH = () => notTaken('tags');
export const DELETE = () => notTaken('tags');
