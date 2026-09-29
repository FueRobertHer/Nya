import { NextResponse } from 'next/server';
import { getContainer, isContainerId, type Ctx } from '@/lib/containers';
import { getItems } from '@/lib/storage';
import { applyWebhook, verifyWebhook, WebhookRejected } from '@/lib/plaid-webhook';

// Plaid's webhook endpoint (lib/plaid-webhook.ts). Excluded from the session
// gate in proxy.ts, since Plaid holds no session, and authenticates by
// verifying Plaid's signature over the body instead: an unsigned or altered
// request is a 401 and does nothing.
//
// The container is named in the query (lib/webhook-url.ts), and the Item in the
// body must belong to it. Anything that does not check out is answered 200 and
// ignored: a webhook for an Item removed since is normal, and a reply that
// distinguished the cases would say which Items exist.

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(req: Request) {
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'Body too large' }, { status: 413 });

    try {
      await verifyWebhook(text, req.headers.get('plaid-verification'));
    } catch (err) {
      if (err instanceof WebhookRejected) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      throw err;
    }

    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ ok: true });
    }

    const container = new URL(req.url).searchParams.get('c');
    if (!isContainerId(container) || typeof body?.item_id !== 'string') return NextResponse.json({ ok: true });
    if ((await getContainer(container))?.status !== 'active') return NextResponse.json({ ok: true });

    const ctx: Ctx = { container };
    if (!(await getItems(ctx)).some((i) => i.item_id === body.item_id)) return NextResponse.json({ ok: true });

    await applyWebhook(ctx, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    // A 5xx makes Plaid retry, which is right for a failure of ours.
    console.error('Plaid webhook failed', err instanceof Error ? err.name : typeof err);
    return NextResponse.json({ error: 'Webhook failed' }, { status: 500 });
  }
}
