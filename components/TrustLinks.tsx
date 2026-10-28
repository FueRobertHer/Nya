// Where someone decides whether to sign up or connect a bank (the login and
// sign-in pages, next to Connect an account): which banks connect, and links to
// the public pages on how Nya protects data (app/security, app/privacy). No
// state or hooks, so these render on the server and inside client components
// alike.

/** Which banks connect: the link-token routes ask Plaid for US institutions
 *  only (app/api/create-link-token, app/api/create-update-link-token); the
 *  person's own SimpleFIN account (lib/connectors/), or another paid service
 *  that speaks its protocol, or their own Lunch Flow account where the
 *  deployment offers it (lib/connectors/switch.ts, which the login page, a
 *  client page, can't read, so the words say so), may reach others, which
 *  nobody here has checked bank by bank. The manual account it offers for the
 *  rest takes a balance in its own currency (lib/manual.ts), which matters
 *  most to exactly the people this is for. */
export function CoverageNote() {
  return (
    <p className="panel-note coverage-note">
      Bank connections through Plaid work for US institutions only. Your own SimpleFIN account, or another service that
      speaks its protocol (such as Redbark, in Australia and New Zealand), or, where this copy of Nya offers it, your own
      Lunch Flow account may reach others. Anything else can be tracked as a manual account, with a balance you enter in
      its own currency.
    </p>
  );
}

/** Links to the Security and Privacy pages; `current` marks the one being
 *  read. The way back into the app is the page's header
 *  (components/PageHeader.tsx). */
export function TrustLinks({ current }: { current?: 'security' | 'privacy' }) {
  return (
    <nav className="trust-links" aria-label="How Nya handles your data">
      <a href="/security" aria-current={current === 'security' ? 'page' : undefined}>
        Security
      </a>
      <a href="/privacy" aria-current={current === 'privacy' ? 'page' : undefined}>
        Privacy
      </a>
    </nav>
  );
}
