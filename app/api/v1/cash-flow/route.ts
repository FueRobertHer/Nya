import { serve, methodNotAllowed } from '@/lib/api-http';
import { operation } from '@/lib/api-ops';

// GET /api/v1/cash-flow: Where money came from and where it went, for a month
// or a range (#41): money in by who paid it, money out by category group and
// category, and what was left over or came from savings or debt. Read-only,
// with an API token (lib/api-tokens.ts), from stored data alone. Its arguments
// are declared in lib/api-spec.ts and its answer is built in
// lib/api-cash-flow.ts; both are documented on the developer page
// (app/developers).

const op = operation('cash-flow');

export const GET = (req: Request) => serve(req, op);

// Read only: every other method is refused in the API's own error shape.
export const POST = () => methodNotAllowed('GET');
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
