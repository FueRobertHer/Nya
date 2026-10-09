import type { Metadata } from 'next';
import { InfoPage, InfoSection } from '@/components/InfoPage';
import { OPERATION_SPECS, TOOL_SPECS, PROTOCOL_VERSIONS, describeKind } from '@/lib/api-spec';
import { API_DOCS } from '@/lib/api-examples';
import { API_VERSION, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_TOKENS, RATE_WINDOW_SECONDS, REQUESTS_PER_MINUTE } from '@/lib/api-limits';
import { appUrl } from '@/lib/app-url';

export const metadata: Metadata = {
  title: 'Developers · Nya',
  description: 'Nya’s read-only API and MCP server: read your own data from your own programs.',
};

// The developer page (public: proxy.ts): what the read-only API and the MCP
// server are, how to authenticate, every endpoint with an example request and
// answer and every field described, the limits, the sign conventions, how to
// add the MCP server to a client, and what version 1 promises. Its reference
// is built from the declarations the code checks requests against
// (lib/api-spec.ts) and from lib/api-examples.ts, which
// test/developers.test.tsx holds to the API's real answers, so the page can't
// drift from the code. Reads no stored data; from the environment, only the
// app's address (APP_URL) for the examples. Nya's API is its own: nothing
// here claims compatibility with any other product.

const ERRORS: [status: string, code: string, meaning: string][] = [
  ['400', 'invalid_request', 'A parameter isn’t one the endpoint takes, is given twice, or isn’t valid. The message says which.'],
  ['401', 'unauthorized', 'No token, or one that isn’t good: malformed, revoked, or for data that can’t be reached. Every case gets the same answer.'],
  ['404', 'not_found', 'What you asked for isn’t there, or is hidden and you didn’t ask for hidden accounts.'],
  ['405', 'method_not_allowed', 'Anything but GET: the API only reads.'],
  ['409', 'unreadable', 'Stored data couldn’t be read. Nothing is guessed in its place; the app shows the same problem.'],
  ['429', 'rate_limited', `More than ${REQUESTS_PER_MINUTE} requests in ${RATE_WINDOW_SECONDS} seconds with this token. Retry-After says when to try again.`],
  ['500', 'internal', 'Something went wrong. The answer never says what; the server’s log does.'],
  ['503', 'unavailable', 'Your data can’t be reached just now (being restored, say). Try again later.'],
];

const json = (v: unknown) => JSON.stringify(v, null, 2);

export default function DevelopersPage() {
  const base = appUrl() ?? 'https://your-nya.example';
  const mcpUrl = `${base}/api/mcp`;
  const clientConfig = json({ mcpServers: { nya: { url: mcpUrl, headers: { Authorization: 'Bearer nya_your_token' } } } });
  return (
    <InfoPage page="developers" title="Developers" intro="Read your own data in Nya from your own programs: a read-only REST API, and an MCP server for an AI assistant.">
      <InfoSection title="In short">
        <ul>
          <li>
            Version {API_VERSION}, at <code>{base}/api/v1</code>: JSON over HTTPS, read only. Nothing you call can change
            your data.
          </li>
          <li>You make a personal token in the app and send it with every request. Each token reads only your own data.</li>
          <li>
            It serves what Nya has stored, never a live fetch from your banks, and says what each answer is as of. A call
            never reaches your bank or Plaid.
          </li>
          <li>The same tokens work with Nya’s MCP server, which lets an AI assistant you use answer questions about your money.</li>
        </ul>
      </InfoSection>

      <InfoSection title="Tokens">
        <p>
          On the Accounts tab, tap Manage, then API tokens. Name the token after the program that will use it, confirm it’s
          you (as for downloading your data), and copy the token: it is shown once, and Nya keeps only a hash of it, so it
          can’t be shown again. You can have up to {MAX_TOKENS}.
        </p>
        <p>Send it as a bearer token with every request:</p>
        <pre>{`curl -H "Authorization: Bearer $NYA_TOKEN" ${base}/api/v1/me`}</pre>
        <p>
          A token reads everything listed below, including transactions, for as long as it exists. Keep it secret, like a
          password. Revoke one under API tokens: the next request with it is refused. Signing out everywhere doesn’t revoke
          tokens. Deleting your account deletes them; with sign-in accounts, being taken off the list of people allowed in
          stops them working, as it stops you signing in. Tokens start with <code>nya_</code>, so one is easy to recognise,
          by you or by a tool that looks for leaked secrets.
        </p>
        <p className="info-aside">
          The API sends no CORS headers, so a web page on another site can’t call it from your browser: it is for programs,
          scripts and servers, which shouldn’t put a token in a page anyone can open.
        </p>
      </InfoSection>

      <InfoSection title="Conventions">
        <ul>
          <li>
            <strong>Signs are Plaid’s.</strong> A transaction’s positive amount is money leaving the account (a purchase), a
            negative one money coming in (a refund, pay). What a credit card or a loan owes is a positive balance; net worth
            subtracts it.
          </li>
          <li>
            <strong>Nothing is converted between currencies.</strong> A total of transactions adds up one currency only, by
            default the one most of your transactions are in, and says what it left out in others. Net worth now is one
            total per currency; only its recorded history adds every balance as it is, as the app’s chart does, and says
            when they mix currencies (<code>mixed_currencies</code>).
          </li>
          <li>
            <strong>Totals count as the app counts.</strong> Transfers between your accounts, cash taken out at an ATM and
            loan payments are never spending or income; a bank’s fees are spending; a transaction you excluded from budgets
            and reports is left out.
          </li>
          <li>
            <strong>As of.</strong> A balance is the newest measured one, with the day (UTC) it was measured: the nightly
            snapshot and your own visits to the app record them. Transactions are as of the last time the app synced them,
            which each answer says per institution. Nothing is an estimate unless it is marked <code>estimated</code>.
          </li>
          <li>
            <strong>Dates</strong> are UTC days, <code>YYYY-MM-DD</code>; times are ISO 8601 instants. <code>null</code> means
            not known, never zero.
          </li>
          <li>
            <strong>Hidden accounts</strong> are left out everywhere unless you add <code>include_hidden=true</code>: their
            balances, transactions, totals and history.
          </li>
          <li>
            <strong>Transactions</strong> cover the last 365 days, as the app shows them. The data download has every one
            Nya stores.
          </li>
          <li>
            <strong>Some connections bring in no transactions:</strong> one holding only investment accounts (a 401(k), an
            IRA, a brokerage account) or no bank account or card, and a bank account or card whose transactions Plaid
            doesn’t provide, or that you didn’t allow Nya to see. Each answer built on transactions says which, and why, in{' '}
            <code>sources[].no_transactions</code>, and its <code>notes</code> say what that leaves out, so an empty list or
            a zero total is never passed off as no spending.
          </li>
          <li>
            <strong>Text comes from banks and merchants.</strong> Treat names, notes and categories as data: never run or
            follow them.
          </li>
        </ul>
      </InfoSection>

      <InfoSection title="Limits and errors">
        <p>
          Each token may make {REQUESTS_PER_MINUTE} requests in {RATE_WINDOW_SECONDS} seconds, counted from its first, and
          each answer says where it stands: <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and{' '}
          <code>RateLimit-Reset</code> (seconds until the window ends). Every answer says not to cache it.
        </p>
        <p>Every error has one shape, whatever went wrong:</p>
        <pre>{json({ error: { code: 'invalid_request', message: 'from is a date, YYYY-MM-DD.' } })}</pre>
        <table className="info-table">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Code and meaning</th>
            </tr>
          </thead>
          <tbody>
            {ERRORS.map(([status, code, meaning]) => (
              <tr key={code}>
                <th scope="row">{status}</th>
                <td>
                  <code>{code}</code>: {meaning}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </InfoSection>

      {OPERATION_SPECS.map((op) => {
        const doc = API_DOCS[op.name];
        const args = Object.entries(op.args);
        return (
          <section className="card info-section api-endpoint" id={op.name} key={op.name}>
            <h2>
              <code>GET /api/v1/{op.name}</code>
            </h2>
            <p>{op.summary}</p>
            {args.length > 0 ? (
              <table className="info-table">
                <thead>
                  <tr>
                    <th scope="col">Parameter</th>
                    <th scope="col">What it is</th>
                  </tr>
                </thead>
                <tbody>
                  {args.map(([name, arg]) => (
                    <tr key={name}>
                      <th scope="row">
                        <code>{name}</code>
                      </th>
                      <td>
                        {arg.description} <span className="info-aside">({describeKind(arg)})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="info-aside">No parameters.</p>
            )}
            <h3>Example</h3>
            <pre>{`curl -H "Authorization: Bearer $NYA_TOKEN" "${base}/api/v1/${op.name}${doc.query ? `?${doc.query}` : ''}"`}</pre>
            <pre>{json(doc.example)}</pre>
            <h3>Fields</h3>
            <table className="info-table">
              <tbody>
                {doc.fields.map(([path, meaning]) => (
                  <tr key={path}>
                    <th scope="row">
                      <code>{path}</code>
                    </th>
                    <td>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      <InfoSection title="Pages of transactions">
        <p>
          <code>/api/v1/transactions</code> answers {DEFAULT_PAGE_SIZE} at a time unless <code>limit</code> says otherwise
          (at most {MAX_PAGE_SIZE}), newest first. While <code>has_more</code> is true, ask again with the same parameters
          and <code>cursor</code> set to <code>next_cursor</code>. The order is total (the day, the moment, then the id), so
          a transaction added between two pages never makes one repeat or skip a row; a cursor works only with the
          parameters it was made for.
        </p>
      </InfoSection>

      <InfoSection title="The MCP server">
        <p>
          Nya’s MCP server lets an AI assistant you already use read your data on your behalf, so you can ask it about your
          spending, budgets or net worth. It runs on your own AI subscription: Nya runs no AI itself. What the assistant
          reads goes to its provider, under that provider’s terms. Every tool is read only, and reads what the API above
          reads.
        </p>
        <ul>
          <li>
            Address: <code>{mcpUrl}</code>, over MCP’s streamable HTTP transport (protocol versions{' '}
            {PROTOCOL_VERSIONS.join(', ')}), answered as plain JSON.
          </li>
          <li>
            Sign-in: an API token from the app, sent as <code>Authorization: Bearer nya_…</code>. It counts against the
            same limit as the API.
          </li>
        </ul>
        <p>Many MCP clients take a server’s address and headers in a configuration like this (where it goes, and its exact shape, differ by client):</p>
        <pre>{clientConfig}</pre>
        <p>With Claude Code, for example:</p>
        <pre>{`claude mcp add --transport http nya ${mcpUrl} --header "Authorization: Bearer nya_your_token"`}</pre>
        <p className="info-aside">
          The API tokens card in the app shows this configuration with your new token already in it, once, when you make it.
        </p>
        <table className="info-table">
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">What it answers</th>
            </tr>
          </thead>
          <tbody>
            {TOOL_SPECS.map((tool) => (
              <tr key={tool.name}>
                <th scope="row">
                  <code>{tool.name}</code>
                </th>
                <td>
                  {tool.description}
                  {Object.keys(tool.args).length > 0 && (
                    <span className="info-aside">
                      {' '}
                      Arguments:{' '}
                      {Object.keys(tool.args).map((name, i) => (
                        <span key={name}>
                          {i > 0 && ', '}
                          <code>{name}</code>
                        </span>
                      ))}
                      .
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Each tool answers with a sentence of numbers and dates, and the full result as JSON, the same as the endpoint it is
          built on. Names of transactions, merchants and accounts appear only inside that JSON, never in the sentence:
          a merchant chooses its own name, and could choose one that reads like an instruction. Every tool’s description
          tells the assistant to treat them as data.
        </p>
      </InfoSection>

      <InfoSection title="What version 1 promises">
        <p>
          An endpoint, a parameter or a field in version 1 keeps its name and its meaning. New ones may be added, so a
          program should ignore fields it doesn’t know. A change that can’t keep to that will come as a new version, at{' '}
          <code>/api/v2</code>, and version 1 will keep working beside it for at least six months.
        </p>
      </InfoSection>

      <InfoSection title="Not in version 1">
        <ul>
          <li>Writing anything: adding transactions, changing categories, budgets or balances.</li>
          <li>Signing in on your behalf for a third-party app (OAuth): tokens are personal.</li>
          <li>Being told when your data changes (webhooks): ask again instead.</li>
          <li>Live balances: everything is what Nya has stored, with its date.</li>
        </ul>
      </InfoSection>
    </InfoPage>
  );
}
