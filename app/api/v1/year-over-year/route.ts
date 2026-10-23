import { serve, methodNotAllowed } from '@/lib/api-http';
import { operation } from '@/lib/api-ops';

// GET /api/v1/year-over-year: this year so far against the same days of last
// year, month by month and by category group and category. Read-only, with an
// API token (lib/api-tokens.ts), from stored data alone. Its arguments are
// declared in lib/api-spec.ts and its answer is built in lib/api-reports.ts;
// both are documented on the developer page (app/developers).

const op = operation('year-over-year');

export const GET = (req: Request) => serve(req, op);

// Read only: every other method is refused in the API's own error shape.
export const POST = () => methodNotAllowed('GET');
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
