// Where someone decides whether to sign up or connect a bank (the login and
// sign-in pages, next to Connect an account): which banks connect, and links to
// the public pages on how Nya protects data (app/security, app/privacy). No
// state or hooks, so these render on the server and inside client components
// alike.

/** Which banks connect: the link-token routes ask Plaid for US institutions
 *  only (app/api/create-link-token, app/api/create-update-link-token); the
 *  person's own SimpleFIN account (lib/connectors/), or another paid service
 *  that speaks its protocol, may reach others, which nobody here has checked
 *  bank by bank. The manual account it offers for the rest takes US dollars
 *  only (lib/manual.ts), which matters most to exactly the people this is for. */
export function CoverageNote() {
  return (
    <p className="panel-note coverage-note">
      Bank connections through Plaid work for US institutions only. Your own SimpleFIN account, or another service that
      speaks its protocol (such as Redbark, in Australia and New Zealand), may reach others. Anything else can be tracked
      as a manual account, with a balance you enter in US dollars.
    </p>
  );
}

/** Links to the Security and Privacy pages; `current` marks the one being read,
 *  and `home` adds a way back into the app. */
export function TrustLinks({ current, home = false }: { current?: 'security' | 'privacy'; home?: boolean }) {
  return (
    <nav className="trust-links" aria-label="How Nya handles your data">
      <a href="/security" aria-current={current === 'security' ? 'page' : undefined}>
        Security
      </a>
      <a href="/privacy" aria-current={current === 'privacy' ? 'page' : undefined}>
        Privacy
      </a>
      {home && <a href="/">Open Nya</a>}
    </nav>
  );
}
