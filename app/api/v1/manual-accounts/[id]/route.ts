import { serveResource, notTaken } from '@/lib/api-http';
import { resourceSpec } from '@/lib/api-spec';

// GET and PATCH /api/v1/manual-accounts/{id}: one manual account, and a change
// to its details. With an API token (lib/api-tokens.ts) that may do it,
// through the gate every operation passes (lib/api-run.ts). Its fields are
// declared in lib/api-spec.ts and it runs in lib/api-writes.ts; both are
// documented on the developer page (app/developers).

// Shorter than a create with an Idempotency-Key waits before another
// request takes it over (lib/api-writes.ts).
export const maxDuration = 30;

type Params = { params: Promise<{ id: string }> };

const read = resourceSpec('manual-accounts.get');
const update = resourceSpec('manual-accounts.update');

export const GET = async (req: Request, { params }: Params) => serveResource(req, read, (await params).id);
export const PATCH = async (req: Request, { params }: Params) => serveResource(req, update, (await params).id);

// Every other method is refused in the API's own error shape, as this copy
// is set up (lib/api-http.ts notTaken).
export const POST = () => notTaken('manual-accounts/{id}');
export const PUT = () => notTaken('manual-accounts/{id}');
export const DELETE = () => notTaken('manual-accounts/{id}');
