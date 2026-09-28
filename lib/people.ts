// lib/people.ts
//
// Display names for the people in the app, from Clerk (sharing shows who is
// who). Only a first name, full name or email, for the account's own page;
// a name that can't be looked up shows as "Someone".

export async function displayNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const out: Record<string, string> = {};
  try {
    const { clerkClient } = await import('@clerk/nextjs/server');
    const client = await clerkClient();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const u = await client.users.getUser(id);
          const name = [u.firstName, u.lastName].filter(Boolean).join(' ');
          out[id] = name || u.primaryEmailAddress?.emailAddress || 'Someone';
        } catch {
          out[id] = 'Someone';
        }
      })
    );
  } catch {
    for (const id of ids) out[id] = 'Someone';
  }
  return out;
}
