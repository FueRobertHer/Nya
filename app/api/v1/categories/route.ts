import { serve, methodNotAllowed } from '@/lib/api-http';
import { operation } from '@/lib/api-ops';

// GET /api/v1/categories: The categories in use. Read-only, with an API token
// (lib/api-tokens.ts), from stored data alone. Its arguments are declared in
// lib/api-ops.ts and its answer is built in lib/api-read.ts; both are
// documented on the developer page (app/developers).

const op = operation('categories');

export const GET = (req: Request) => serve(req, op);

// Read only: every other method is refused in the API's own error shape.
export const POST = () => methodNotAllowed('GET');
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
