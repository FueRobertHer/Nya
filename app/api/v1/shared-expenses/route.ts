import { serve, methodNotAllowed } from '@/lib/api-http';
import { operation } from '@/lib/api-ops';

// GET /api/v1/shared-expenses: the people you split costs with, what is left
// between you per currency, every IOU, every part of a shared transaction
// still open, and the payments you confirmed paid something back. The only
// answer that names those people (everywhere else a person is a random id).
// Read-only, with an API token (lib/api-tokens.ts), from stored data alone.
// Its answer is built in lib/shared-expenses/api.ts and documented on the
// developer page (app/developers).

const op = operation('shared-expenses');

export const GET = (req: Request) => serve(req, op);

// Read only: every other method is refused in the API's own error shape.
export const POST = () => methodNotAllowed('GET');
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
