'use client';

// Connection details (rollout phase 3b), from an institution's ⋯: everything
// about its connection in one place, as the Connection health card and the
// SimpleFIN and Lunch Flow cards showed it. For Plaid: what is wrong in its
// own words, what it does to the total, when it last synced, whose side a
// problem is on and Plaid's code. For SimpleFIN or Lunch Flow: its card,
// with where it reaches, how many accounts it tracks, when it last
// answered, the day's requests left, its history and its buttons. What
// needs the person is on the institution's card as well; this is where the
// rest is.

import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { affectedText, healthText, lastSyncedText, sideText } from './ConnectionHealth';
import { ConnectorCardView, type ConnectorAsk, type ConnectorsList } from './Connectors';
import { statusBadge, type ConnectionPlace } from './ConnectionStatus';
import { connectorHealthText, connectorSideText } from '@/lib/connectors/health';
import { formatMoney, hideAmountsIn } from '@/lib/format';
import type { PageFx } from '@/lib/fx/view';
import type { Institution } from './accounts-format';

export function ConnectionDetailsBody({
  inst,
  place,
  requests,
  fx,
  onConnector,
  now = Date.now(),
}: {
  inst: Institution;
  place: ConnectionPlace | null;
  requests: ConnectorsList['requests'];
  fx: PageFx | null;
  /** Asks the connector sheet; Connection details closes first. */
  onConnector: (ask: ConnectorAsk) => void;
  now?: number;
}) {
  const conn = place?.conn ?? null;
  if (conn) {
    return <ConnectorCardView conn={conn} requests={requests} busy={false} note={null} onAsk={onConnector} onRefresh={() => onConnector({ kind: 'refresh', connection_id: conn.connection_id })} />;
  }
  const h = inst.health;
  if (!h) return <p className="helper">Nothing is recorded about this connection yet.</p>;
  const name = inst.institution_name;
  const fed = h.cause === 'connector' && !!h.detail;
  const text = fed ? connectorHealthText(name, h) : healthText(name, h, inst, now);
  const side = h.state === 'healthy' ? null : fed ? connectorSideText(name, h) : sideText(name, h);
  const badge = statusBadge(inst, now);
  return (
    <div className="stack">
      <p>
        <span className="badge">{badge ?? 'Working'}</span>
      </p>
      {text && (
        <p>
          <Masked>{hideAmountsIn(text)}</Masked>
        </p>
      )}
      {h.unread && <p>Some of what Nya keeps about this connection couldn&apos;t be read, so a warning from Plaid may be missing here.</p>}
      {affectedText(inst, formatMoney, fx).map((line) => (
        <p key={line}>
          <Masked>{line}</Masked>
        </p>
      ))}
      <p className="helper">
        {lastSyncedText(h)}
        {side ? ` · ${side}` : ''}
        {h.code ? ` · Plaid code ${h.code}` : ''}
      </p>
    </div>
  );
}

export default function ConnectionDetails({
  open,
  inst,
  place,
  requests,
  fx,
  onClose,
  onConnector,
}: {
  open: boolean;
  inst: Institution | null;
  place: ConnectionPlace | null;
  requests: ConnectorsList['requests'];
  fx: PageFx | null;
  onClose: () => void;
  onConnector: (ask: ConnectorAsk) => void;
}) {
  if (!inst) return null;
  return (
    <Sheet open={open} title={inst.institution_name} onClose={onClose}>
      <ConnectionDetailsBody
        inst={inst}
        place={place}
        requests={requests}
        fx={fx}
        onConnector={(ask) => {
          // Closes this first, so no sheet opens on top of another.
          onClose();
          onConnector(ask);
        }}
      />
    </Sheet>
  );
}
