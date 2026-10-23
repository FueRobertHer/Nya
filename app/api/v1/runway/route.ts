import { serve, methodNotAllowed } from '@/lib/api-http';
import { operation } from '@/lib/api-ops';

// GET /api/v1/runway: how long the person's cash would last at their recent
// spending, with their income and without it, and under a what-if when one is
// asked for. Read-only, with an API token (lib/api-tokens.ts), from stored
// data alone, and storing nothing. Its arguments are declared in
// lib/api-spec.ts and its answer is built in lib/api-reports.ts; both are
// documented on the developer page (app/developers).

const op = operation('runway');

export const GET = (req: Request) => serve(req, op);

// Read only: every other method is refused in the API's own error shape.
export const POST = () => methodNotAllowed('GET');
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
