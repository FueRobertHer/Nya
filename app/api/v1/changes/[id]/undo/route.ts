import { serveResource, notTaken } from '@/lib/api-http';
import { resourceSpec } from '@/lib/api-spec';

// POST /api/v1/changes/{id}/undo: undoes one of this token’s own changes. With
// an API token (lib/api-tokens.ts) that may do it, through the gate every
// operation passes (lib/api-run.ts). Its fields are declared in lib/api-
// spec.ts and it runs in lib/api-writes.ts; both are documented on the
// developer page (app/developers).

// Undoing a manual account's creation can fold it out of recorded days,
// under the links lock (lib/links.ts), sized to this.
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

const undo = resourceSpec('changes.undo');

export const POST = async (req: Request, { params }: Params) => serveResource(req, undo, (await params).id);

// Every other method is refused in the API's own error shape, as this copy
// is set up (lib/api-http.ts notTaken).
export const GET = () => notTaken('changes/{id}/undo');
export const PATCH = () => notTaken('changes/{id}/undo');
export const PUT = () => notTaken('changes/{id}/undo');
export const DELETE = () => notTaken('changes/{id}/undo');
