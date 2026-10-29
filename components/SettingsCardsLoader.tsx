'use client';

// Settings' cards (components/settings-cards.ts), each drawn in its place by
// a stand-in of the same name and props that loads their shared code first
// (components/lazy-part.tsx). Settings opens at once, its list and its
// bar with it; a card's rows are still to come for the moment its code takes.
// If the code can't be loaded, or a card stops while it runs, that card says
// so and the rest of Settings works as before.

import type { ComponentProps, ComponentType } from 'react';
import { CardSkeleton } from './LoadingSkeletons';
import { PartBoundary, PartUnavailable, lazyPart, useLazyPart } from './lazy-part';

type Cards = typeof import('./settings-cards');

export const settingsCardsPart = lazyPart(() => import('./settings-cards'));

/** A card's place when its code couldn't be loaded or it has stopped. */
export function CardUnavailable({ reason, onRetry }: { reason: 'load' | 'crash'; onRetry: () => void }) {
  return (
    <section className="card">
      <PartUnavailable what="This card" after="The rest of Settings works as before." reason={reason} onRetry={onRetry} />
    </section>
  );
}

function settingsCard<K extends keyof Cards>(name: K) {
  type Props = ComponentProps<Cards[K]>;
  function Card(props: Props) {
    const { mod, failed, retry } = useLazyPart(settingsCardsPart);
    if (mod) {
      // The card of that name takes these props; TypeScript can't follow a
      // name chosen by a type parameter to its card.
      const Real = mod[name] as ComponentType<object>;
      return (
        <PartBoundary name={name} fallback={(again) => <CardUnavailable reason="crash" onRetry={again} />}>
          <Real {...(props as object)} />
        </PartBoundary>
      );
    }
    if (failed) return <CardUnavailable reason="load" onRetry={retry} />;
    return <CardSkeleton label="Loading" />;
  }
  Card.displayName = name;
  return Card;
}

export const AccountLinks = settingsCard('AccountLinks');
export const AdminUnusedItems = settingsCard('AdminUnusedItems');
export const ApiTokens = settingsCard('ApiTokens');
export const CategoriesCard = settingsCard('CategoriesCard');
export const CurrencyCard = settingsCard('CurrencyCard');
export const DemoDataCard = settingsCard('DemoDataCard');
export const ReceiptsCard = settingsCard('ReceiptsCard');
export const RestoreCard = settingsCard('RestoreCard');
export const ReviewSettingsCard = settingsCard('ReviewSettingsCard');
export const RulesCard = settingsCard('RulesCard');
export const TagsCard = settingsCard('TagsCard');
export const ThemeCard = settingsCard('ThemeCard');
export const VendorDefaultsCard = settingsCard('VendorDefaultsCard');
export const WeeklySummaryCard = settingsCard('WeeklySummaryCard');
