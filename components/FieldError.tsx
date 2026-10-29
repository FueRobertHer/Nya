// What is wrong with a field and what to do (docs/design/design-system.md,
// Field): its words with the alert icon, in --neg, under the field it is
// about. The field names it with aria-describedby and sets aria-invalid, so
// its red edge (app/globals.css) is never the only sign.

import type { ReactNode } from 'react';
import { ALERT } from './ConnectionStatus';

export default function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span className="field-error" id={id}>
      {ALERT}
      <span>{children}</span>
    </span>
  );
}

/** An amount to show as the example in "Enter an amount, like 120.50", with
 *  the currency's decimal places (none for JPY, three for KWD). */
export function amountExample(places: number): string {
  return places > 0 ? `120.${'5'.padEnd(places, '0')}` : '120';
}
