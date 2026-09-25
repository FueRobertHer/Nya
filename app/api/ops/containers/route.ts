import { NextResponse } from 'next/server';
import { opsGuard, notPost } from '@/lib/ops';
import {
  CONTAINER_ENV,
  ContainerError,
  createFirstContainer,
  isContainerId,
  listContainers,
  resolveCtx,
} from '@/lib/containers';

// The container registry (see lib/containers.ts). Two bodies:
//
//   {} or empty          list the containers, and say whether CONTAINER_ID
//                        in this deployment names a usable one
//   {"create": true}     create the first container; refused if any exists
//
// Anything else is refused. Locked like every /api/ops route (lib/ops.ts).

const MAX_BODY_CHARS = 256;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function envStatus(): Promise<string> {
  const raw = process.env[CONTAINER_ENV];
  if (!raw) return 'unset';
  if (!isContainerId(raw)) return 'not a container id';
  try {
    await resolveCtx();
    return 'ok';
  } catch (err) {
    if (err instanceof ContainerError) return err.message;
    throw err;
  }
}

export async function POST(req: Request) {
  const refused = await opsGuard(req);
  if (refused) return refused;

  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return bad('Body too large', 413);
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return bad('Body must be valid JSON');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Body must be a JSON object');
  const fields = Object.keys(body);
  const create = fields.length === 1 && fields[0] === 'create' && (body as Record<string, unknown>).create === true;
  if (fields.length !== 0 && !create) return bad('Send {"create": true}, or an empty body to list.');

  try {
    if (create) {
      const id = await createFirstContainer();
      return NextResponse.json({
        created: id,
        next_step: `Set ${CONTAINER_ENV}=${id} in Vercel (Production) and redeploy. Nothing uses it yet; it must be in place before data moves into it.`,
      });
    }
    const raw = process.env[CONTAINER_ENV];
    return NextResponse.json({
      containers: await listContainers(),
      container_id: raw ? raw.slice(0, 64) : null,
      container_id_status: await envStatus(),
    });
  } catch (err) {
    if (err instanceof ContainerError) return bad(err.message, 409);
    console.error('Container operation failed:', err instanceof Error ? err.name : typeof err);
    return bad('Container operation failed; check the logs and try again.', 500);
  }
}

export const { GET, HEAD, OPTIONS, PUT, PATCH, DELETE } = notPost;
