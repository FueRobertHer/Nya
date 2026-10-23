import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { clerkEnabled } from '@/lib/auth-mode';
import { isDemoUser } from '@/lib/demo';
import { storeFailure } from '@/lib/store-failure';
import { weeklySettingStore } from '@/lib/weekly-summary/store';
import { parseWeeklyChoice } from '@/lib/weekly-summary/settings';
import { cannotSend, saveSetting, DEMO_REFUSAL } from '@/lib/weekly-summary/send-now';

// The weekly summary's setting (lib/weekly-summary/settings.ts), from the
// Weekly summary card in Settings, Preferences. Behind the session
// gate, for the signed-in person's own container.
//
//   GET  { setting, can_send, why_not, demo }: the setting as saved, or null
//        when it never was (off); whether this copy of Nya can send one at
//        all, and why not (lib/weekly-summary/send-now.ts cannotSend).
//   PUT  { enabled, weekday, time_zone }: replaces it, every field checked
//        (parseWeeklyChoice): { setting }. Turning it on makes the key its
//        links are signed with anew (saveSetting).
//
// Strict: a setting that was saved but can't be read is a 409, flagged, never
// read as off, and a save never writes over one (lib/repo.ts). It changes
// nothing /api/net-worth or /api/transactions answer, so no cache is cleared.
// A demo account can't turn it on: demo accounts are never emailed.

/** The signed-in Clerk account is one of Preview's demo accounts. */
async function demo(): Promise<boolean> {
  if (!clerkEnabled()) return false;
  const { auth } = await import('@clerk/nextjs/server');
  const { userId } = await auth();
  return !!userId && isDemoUser(userId);
}

const noStore = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    const ctx = await dataCtx();
    const [setting, isDemo] = await Promise.all([weeklySettingStore.get(ctx), demo()]);
    const why = isDemo ? DEMO_REFUSAL : cannotSend();
    return NextResponse.json({ setting, can_send: why === null, why_not: why, demo: isDemo }, { headers: noStore });
  } catch (err) {
    return storeFailure(err, 'Could not read the weekly summary’s setting.');
  }
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => undefined);
  const parsed = parseWeeklyChoice(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    const ctx = await dataCtx();
    if (parsed.choice.enabled && (await demo())) return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403 });
    return NextResponse.json({ setting: await saveSetting(ctx, parsed.choice) }, { headers: noStore });
  } catch (err) {
    return storeFailure(err, 'Could not save the weekly summary’s setting.');
  }
}
