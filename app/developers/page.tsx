import type { Metadata } from 'next';
import { InfoPage, type InfoPart } from '@/components/InfoPage';
import { APP_CAPS, OPERATION_SPECS, TOOL_SPECS, PROTOCOL_VERSIONS, RESOURCE_SPECS, WRITE_TOOL_SPECS, describeKind, resourceSpec, type ResourceSpec } from '@/lib/api-spec';
import { API_DOCS, RESOURCE_DOCS, accessDoc, type ResourceDoc } from '@/lib/api-examples';
import {
  API_AUTH_MAX_FAILURES,
  API_AUTH_WINDOW_SECONDS,
  API_ROOM,
  API_VERSION,
  CHANGES_KEEP_DAYS,
  CHANGES_PER_DAY,
  CREATES_PER_DAY,
  DEFAULT_PAGE_SIZE,
  IDEMPOTENCY_HOURS,
  MAX_PAGE_SIZE,
  MCP_MAX_PAGE_SIZE,
  MAX_TOKENS,
  PERSON_CHANGES_PER_DAY,
  RATE_WINDOW_SECONDS,
  REQUESTS_PER_MINUTE,
  WRITE_BODY_MAX,
  WRITES_PER_MINUTE,
} from '@/lib/api-limits';
import { appUrl } from '@/lib/app-url';
import { apiWritesEnabled } from '@/lib/api-writes-enabled';

// Read when the page is rendered, as the switch is (a redeploy changes it).
export function generateMetadata(): Metadata {
  return {
    title: 'Developers · Nya',
    description: apiWritesEnabled()
      ? 'Nya’s API and MCP server: read your own data, and with a token made for it change some of it, from your own programs.'
      : 'Nya’s read-only API and MCP server: read your own data from your own programs.',
  };
}

// The developer page (public: proxy.ts): what the API and the MCP server
// are, how to authenticate, every endpoint with an example request and answer
// and every field described, the limits, the sign conventions, how to add the
// MCP server to a client, and what version 1 promises. Its reference is built
// from the declarations the code checks requests against (lib/api-spec.ts)
// and from lib/api-examples.ts, which test/developers.test.tsx holds to the
// API's real answers, so the page can't drift from the code. Reads no stored
// data; from the environment, only the app's address (APP_URL) for the
// examples, and whether this copy lets tokens make changes
// (API_WRITES_ENABLED, lib/api-writes-enabled.ts): while it doesn't, the page
// reads exactly as it did before tokens could write, and says nothing of
// writing. Nya's API is its own: nothing here claims compatibility with any
// other product.

const ERRORS: [status: string, code: string, meaning: string][] = [
  ['400', 'invalid_request', 'A parameter isn’t one the endpoint takes, is given twice, or isn’t valid. The message says which.'],
  ['401', 'unauthorized', 'No token, or one that doesn’t work: malformed, unknown, revoked, or made by an account no longer allowed in. Every case gets the same answer.'],
  ['404', 'not_found', 'There is no such endpoint, or what you asked for isn’t there (an account_id no account has), or is hidden and you didn’t ask for hidden accounts.'],
  ['405', 'method_not_allowed', 'Anything but GET: the API only reads.'],
  ['409', 'unreadable', 'Stored data couldn’t be read. Nothing is guessed in its place; the app shows the same problem.'],
  [
    '429',
    'rate_limited',
    `More than ${REQUESTS_PER_MINUTE} requests in ${RATE_WINDOW_SECONDS} seconds with this token, or more than ${API_AUTH_MAX_FAILURES} requests with tokens that don’t work from your address in ${API_AUTH_WINDOW_SECONDS / 60} minutes. Retry-After says when to try again.`,
  ],
  ['500', 'internal', 'Something went wrong. The answer never says what; the server’s log does.'],
  [
    '503',
    'unavailable',
    'The token is good, but your data can’t be reached just now: it is being restored, say, or the sign-in service couldn’t confirm the account that made the token may still sign in. Try again later, and keep the token.',
  ],
];

/** The errors only writing gives, and the meanings writing widens, while
 *  this copy lets tokens write: by code, in the table's order. */
const WRITE_ERRORS: [status: string, code: string, meaning: string][] = [
  [
    '400',
    'invalid_request',
    'A parameter or a body field isn’t one the endpoint takes, is given twice, or isn’t valid, a field it needs is missing, or a body mixes what must be sent apart. The message says which.',
  ],
  [
    '403',
    'insufficient_scope',
    'The token may not do this: one made to read changes nothing, and one made to update balances reads only me and accounts and changes only a manual account’s balance. Make a token that may, under API tokens.',
  ],
  [
    '403',
    'forbidden',
    'No token can change it: a bank’s transaction, one SimpleFIN, Lunch Flow or a file brought in, or an account a bank, SimpleFIN or Lunch Flow keeps up to date.',
  ],
  ['405', 'method_not_allowed', 'A method this path doesn’t take. Allow says which it does.'],
  [
    '409',
    'conflict',
    'It can’t be done as things are: a name another category already has, a change between money held and money owed, a split transaction to delete, or an undo of something changed since. The message says what, and what to do.',
  ],
  ['409', 'in_progress', 'A create sent with this Idempotency-Key is still being made. Send it again after Retry-After.'],
  ['412', 'version_mismatch', 'It changed since the version you sent in If-Match: read it again, then decide. Nothing was written.'],
  ['413', 'too_large', `The body is over ${WRITE_BODY_MAX / 1024} KB.`],
  ['415', 'unsupported_media_type', 'A body sent as anything but application/json.'],
  ['422', 'idempotency_key_reused', `This Idempotency-Key came with another request in the last ${IDEMPOTENCY_HOURS} hours.`],
  ['428', 'version_required', 'A change to something that exists, sent without If-Match, or with *: send the version you read.'],
];

/** The table of errors: version 1's, and writing's beside them when on. */
function errorsFor(writes: boolean): [status: string, code: string, meaning: string][] {
  if (!writes) return ERRORS;
  const widened = new Set(WRITE_ERRORS.map(([, code]) => code));
  const rows = [...ERRORS.filter(([, code]) => !widened.has(code)), ...WRITE_ERRORS].map(
    ([status, code, meaning]): [string, string, string] =>
      code === 'rate_limited'
        ? [
            status,
            code,
            `${meaning.replace(/\. Retry-After says when to try again\.$/, '')}, or, for a change, more than ${WRITES_PER_MINUTE} writes a minute, ${CHANGES_PER_DAY} changes a day or ${CREATES_PER_DAY} new things a day with this token, or ${PERSON_CHANGES_PER_DAY.toLocaleString('en-US')} changes a day with all your tokens. Retry-After says when to try again.`,
          ]
        : code === 'not_found'
          ? [status, code, `${meaning.replace(/\.$/, '')}, or no longer exists.`]
          : [status, code, meaning]
  );
  return rows.sort((a, b) => Number(a[0]) - Number(b[0]));
}

/** Who may call a resource's operation, in words. */
function whoMay(spec: ResourceSpec): string {
  const may = spec.allows;
  if (may.includes('read')) return 'Any token.';
  if (may.includes('balances')) return 'A token made to update balances, or to make changes.';
  return 'A token made to make changes.';
}

/** A resource operation's example request. */
function exampleRequest(base: string, spec: ResourceSpec, doc: ResourceDoc): string {
  const path = spec.path.replace('{id}', exampleId(spec, doc.example));
  const lines = [`curl${spec.method === 'GET' ? '' : ` -X ${spec.method}`} -H "Authorization: Bearer $NYA_TOKEN"`];
  if (spec.versioned) lines.push(`  -H 'If-Match: "${doc.ifMatch}"'`);
  if (spec.keyed) lines.push('  -H "Idempotency-Key: 6b1f0c2e-coffee-2026-10-09"');
  if (doc.body) lines.push(`  -H "Content-Type: application/json" -d '${JSON.stringify(doc.body)}'`);
  lines.push(`  "${base}/api/v1/${path}${doc.query ? `?${doc.query}` : ''}"`);
  return lines.join(' \\\n');
}

/** The id an example answer is about, for its request's path. */
function exampleId(spec: ResourceSpec, example: unknown): string {
  const first = Object.values(example as Record<string, unknown>).find((v) => v && typeof v === 'object' && 'id' in (v as object)) as { id: string } | undefined;
  return first?.id ?? spec.name;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

export default function DevelopersPage() {
  const base = appUrl() ?? 'https://your-nya.example';
  const mcpUrl = `${base}/api/mcp`;
  const clientConfig = json({ mcpServers: { nya: { url: mcpUrl, headers: { Authorization: 'Bearer nya_your_token' } } } });
  const writes = apiWritesEnabled();
  const room = (n: number) => Math.floor(n * API_ROOM);
  const intro = writes
    ? 'Read your own data in Nya from your own programs, and with a token made for it change some of it: a REST API, and an MCP server for an AI assistant.'
    : 'Read your own data in Nya from your own programs: a read-only REST API, and an MCP server for an AI assistant.';
  // The page's parts, in order, each with its address on the page: InfoPage
  // draws them and the contents list from this one list, so the two agree.
  // Writing is here only where this copy lets tokens make changes.
  const parts: (InfoPart | false)[] = [
    {
      id: 'in-short',
      title: 'In short',
      body: (
        <>
          <ul>
            {writes ? (
              <li>
                Version {API_VERSION}, at <code>{base}/api/v1</code>: JSON over HTTPS. A token reads, unless you chose when
                you made it that it may update manual accounts’ balances or make changes; then it can add, change and delete
                the transactions entered on your manual accounts, add and change your manual accounts, your categories and
                your tags, and undo its own changes, and nothing else (Writing, below).
              </li>
            ) : (
              <li>
                Version {API_VERSION}, at <code>{base}/api/v1</code>: JSON over HTTPS, read only. Nothing you call can change
                your data.
              </li>
            )}
            <li>You make a personal token in the app and send it with every request. Each token reads only your own data.</li>
            <li>
              It serves what Nya has stored, never a live fetch from your banks, and says what each answer is as of. A call
              never reaches your bank or Plaid.
            </li>
            <li>
              {writes
                ? 'The same tokens work with Nya’s MCP server, which lets an AI assistant you use answer questions about your money, and, with a token made for it, make the changes you ask it for.'
                : 'The same tokens work with Nya’s MCP server, which lets an AI assistant you use answer questions about your money.'}
            </li>
          </ul>
        </>
      ),
    },
    {
      id: 'tokens',
      title: 'Tokens',
      body: (
        <>
          <p>
            Open Settings (the account menu, or the gear), then Your data and privacy, then API tokens. Name the token after the program that will use it, confirm it’s
            you (as for downloading your data), and copy the token: it is shown once, and Nya keeps only a hash of it, so it
            can’t be shown again. You can have up to {MAX_TOKENS}.
          </p>
          <p>Send it as a bearer token with every request:</p>
          <pre>{`curl -H "Authorization: Bearer $NYA_TOKEN" ${base}/api/v1/me`}</pre>
          {writes && (
            <p>
              When you make a token you choose what it can do: read your data (the default), update balances (it sees your
              accounts and their balances, and can change only a manual account’s balance), or read and make changes. That
              choice is kept with it and can never be changed or widened, and a token never gains kinds of changes added to
              Nya after it was made: make a new token for those, and revoke the old one.
            </p>
          )}
          <p>
            {writes ? 'A token made to read reads' : 'A token reads'} everything listed below, including transactions, for as long as it exists. Keep it secret, like a
            password. Revoke one under API tokens: the next request with it is refused. Signing out everywhere, or changing
            the app password, doesn’t revoke tokens. Deleting your account deletes them; with sign-in accounts, being taken
            off the list of people allowed in stops the tokens you made working, as it stops you signing in. Backups leave
            tokens out, so if a backup is ever restored, every token stops: make new ones. Tokens start with{' '}
            <code>nya_</code>, so one is easy to recognise, by you or by a tool that looks for leaked secrets. The demo
            accounts can’t make tokens: everyone who tries the demo shares their data.
          </p>
          <p className="info-aside">
            The API sends no CORS headers, so a web page on another site can’t call it from your browser: it is for programs,
            scripts and servers, which shouldn’t put a token in a page anyone can open.
          </p>
        </>
      ),
    },
    {
      id: 'conventions',
      title: 'Conventions',
      body: (
        <>
          <ul>
            <li>
              <strong>Signs are Plaid’s.</strong> A transaction’s positive amount is money leaving the account (a purchase), a
              negative one money coming in (a refund, pay). What a credit card or a loan owes is a positive balance; net worth
              subtracts it.
            </li>
            <li>
              <strong>Version 1’s totals are in one currency.</strong> A total of transactions adds up one currency only, by
              default the one most of your transactions are in, and says what it left out in others. Net worth now is one
              total per currency; only its recorded history adds every balance as it is, as the app’s chart does, and says
              when they mix currencies (<code>mixed_currencies</code>).
            </li>
            <li>
              <strong>Converted figures come in fields of their own.</strong> Once you choose a home currency in Nya, it is{' '}
              <code>base_currency</code>, and figures converted into it at the European Central Bank’s reference rates (or your
              own) are added beside version 1’s, which keep their meaning: <code>base</code> on net worth, spending, cash flow,
              recurring bills and year over year, and <code>to_base</code> on each account, history point, transaction, split
              part, recurring bill and goal. Budgets’ <code>base</code> stays in the currency the budgets are typed in, with
              spending in other currencies counted against them converted, as the Budgets tab counts it, and the runway’s in
              your cash accounts’ currency, with what is in other currencies converted into it, as the report page shows it. Each says what it converted, from which
              days’ rates, and what it left out for having no rate. Without a home currency, each is <code>null</code>.
            </li>
            <li>
              <strong>Totals count as the app counts.</strong> Transfers between your accounts, cash taken out at an ATM and
              loan payments are never spending or income; a bank’s fees are spending; a transaction you excluded from budgets
              and reports, or one a rule of yours hides, is left out (<code>excluded_by_rule</code> says which).
            </li>
            <li>
              <strong>As of.</strong> A balance is the newest measured one, with the day (UTC) it was measured: the nightly
              snapshot and your own visits to the app record them. Transactions are as of the last time the app synced them,
              which each answer says per institution. Nothing is an estimate unless it is marked <code>estimated</code>.
            </li>
            <li>
              <strong>Dates</strong> are <code>YYYY-MM-DD</code>. A balance’s and history’s are UTC days; a transaction’s is
              the date it carries, the bank’s posting date or the day picked for one entered by hand. Times are ISO 8601
              instants. <code>null</code> means not known, never zero.
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
        </>
      ),
    },
    {
      id: 'limits',
      title: 'Limits and errors',
      body: (
        <>
          <p>
            Each token may make {REQUESTS_PER_MINUTE} requests in {RATE_WINDOW_SECONDS} seconds, counted from its first, and
            each answer says where it stands: <code>RateLimit-Limit</code>, <code>RateLimit-Remaining</code> and{' '}
            <code>RateLimit-Reset</code> (seconds until the window ends). Every answer says not to cache it.
          </p>
          <p>
            A request with a token that doesn’t work is counted against the address it came from: after{' '}
            {API_AUTH_MAX_FAILURES} in {API_AUTH_WINDOW_SECONDS / 60} minutes, that address is turned away until the
            window ends. Something that isn’t a token at all is refused without being counted.
          </p>
          <p>Every error has one shape, whatever went wrong, at any path under /api/v1, an endpoint or not:</p>
          <pre>{json({ error: { code: 'invalid_request', message: 'from is a date, YYYY-MM-DD.' } })}</pre>
          <table className="info-table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Code and meaning</th>
              </tr>
            </thead>
            <tbody>
              {errorsFor(writes).map(([status, code, meaning]) => (
                <tr key={code}>
                  <th scope="row">{status}</th>
                  <td>
                    <code>{code}</code>: {meaning}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ),
    },
    writes && {
      id: 'writing',
      title: 'Writing',
      body: (
        <>
          <p>
            A token made to make changes can add, change and delete the transactions entered on your manual accounts,
            and add and change your manual accounts, your categories and category groups, and your tags, through the
            endpoints after the ones that read. One made to
            update balances can set a manual account’s balance. A call never reaches your bank or Plaid.
          </p>
          <ul>
            <li>
              <strong>Bodies</strong> are JSON, sent with <code>Content-Type: application/json</code>, at most{' '}
              {WRITE_BODY_MAX / 1024} KB: each field once, and only fields the endpoint takes. <code>null</code> clears a
              field where it says so; a field left out is left as it is.
            </li>
            <li>
              <strong>Versions.</strong> Everything a write can change has a <code>version</code>, in every read of it (and
              as the <code>ETag</code> header of a read of one) and in each write’s answer. A change to something that
              exists sends the version it read as <code>If-Match: &quot;version&quot;</code>; if it changed since, the
              change is refused (412) and nothing is written, so a program working from an old read can’t write over what
              you just did. A balance needs none: it says what the balance is now. If the server’s encryption key is ever
              replaced, every version moves once: a program then gets one 412, reads again, and goes on.
            </li>
            <li>
              <strong>Making something, safely.</strong> Send an <code>Idempotency-Key</code> of your own (1 to 255 visible
              ASCII characters) with a POST that makes something. Sent again within {IDEMPOTENCY_HOURS} hours with the same
              body, it answers what the first made, as it is now, with <code>Idempotent-Replayed: true</code>, and makes
              nothing; if that was deleted since, the answer says so (<code>deleted: true</code>, with its{' '}
              <code>change_id</code>), and nothing is made again. When the first stopped part way, what it made is
              answered once it can’t still be running; if nothing of it is there, 409, since it may have been made and
              deleted, and it is never made again (only a first that stopped before it began anything is made, once).
              Another body under the same key is refused (422).
            </li>
            <li>
              <strong>Transactions</strong> are written only on manual accounts, and only those entered in the app or by a
              program: a bank’s, or one SimpleFIN, Lunch Flow or a file brought in, can’t be changed. A transaction’s own
              fields (date, amount, currency, name, category, note, account) and what is said about it (whether it is
              left out, its tags) are changed in separate requests, and its version has a part for each.
            </li>
            <li>
              <strong>A balance</strong> set through the API is the app’s own Update balance: it records no point in your
              history by itself; the nightly snapshot, or your next visit, records the day’s balances. The same balance
              again changes nothing.
            </li>
            <li>
              <strong>Never:</strong> deleting an account, a category, a group or a tag, but by undoing the change that made
              it; changing a manual account between
              money held and money owed (the app refuses it too: close the account and add a new one of the other kind);
              budgets, rules, splits, groups of
              transactions, goals, sharing, tokens or settings. Some changes reach further than they look: moving a
              category to a group of another kind changes how its transactions count in budgets and reports, and
              renaming an account’s institution changes which of your rules match its transactions.
            </li>
            <li>
              <strong>Room is kept for you.</strong> Making things through the API stops at {room(APP_CAPS.categories)}{' '}
              categories, {room(APP_CAPS.groups)} groups, {room(APP_CAPS.tags)} tags and {room(APP_CAPS.manualAccounts)} manual
              accounts, below the app’s own limits, so a program can’t use up what you make in the app.
            </li>
          </ul>
          <p>
            <strong>Limits.</strong> Each token may make {WRITES_PER_MINUTE} writes a minute, counted whether or not they
            are valid, {CHANGES_PER_DAY} changes a day and {CREATES_PER_DAY} new things a day; all your tokens together{' '}
            {PERSON_CHANGES_PER_DAY.toLocaleString('en-US')} changes a day. Each write answers with{' '}
            <code>Write-RateLimit-Limit</code>, <code>Write-RateLimit-Remaining</code> and{' '}
            <code>Write-RateLimit-Reset</code> for the minute, and once it changes something,{' '}
            <code>Write-Day-Limit</code>, <code>Write-Day-Remaining</code> and <code>Write-Day-Reset</code> for the
            token’s day, beside the <code>RateLimit</code> headers for requests. Only a change that is made counts against
            a day: a refused one, a balance that changes nothing, and a create sent again count against none.
          </p>
          <p>
            <strong>Every change is recorded</strong> for {CHANGES_KEEP_DAYS} days with what it changed, before and after.
            A token reads its own (<code>GET /api/v1/changes</code>) and can undo one (
            <code>POST /api/v1/changes/{'{id}'}/undo</code>) while what it changed is still as the change left it: an
            account it made is taken out with its transactions, and its balance on every day recorded since, while
            nothing else has touched it. In the app, under API tokens, you see every token’s changes, can undo any of
            them, and can forget one or all of a token’s.
          </p>
        </>
      ),
    },
    {
      id: 'endpoints',
      title: 'Endpoints',
      body: (
        <>
          {/* An index of every endpoint, each a link to its own part below:
              where tokens can write, the two kinds each under a heading of
              its own. The role keeps a list styled without bullets read as one. */}
          {writes && <h3>Endpoints that read your data</h3>}
          <ul className="info-index" role="list">
            {OPERATION_SPECS.map((op) => (
              <li key={op.name}>
                <a href={`#${op.name}`}>
                  <code>GET /api/v1/{op.name}</code>
                </a>
              </li>
            ))}
          </ul>
          {writes && (
            <>
              <h3>Endpoints that change your data</h3>
              <ul className="info-index" role="list">
                {RESOURCE_SPECS.map((spec) => (
                  <li key={spec.name}>
                    <a href={`#${spec.name}`}>
                      <code>
                        {spec.method} /api/v1/{spec.path}
                      </code>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          )}
          {OPERATION_SPECS.map((op) => {
            const doc = API_DOCS[op.name];
            const args = Object.entries(op.args);
            return (
              <section className="api-endpoint" id={op.name} key={op.name}>
                <h3>
                  <code>GET /api/v1/{op.name}</code>
                </h3>
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
                <h4>Example</h4>
                <pre>{`curl -H "Authorization: Bearer $NYA_TOKEN" "${base}/api/v1/${op.name}${doc.query ? `?${doc.query}` : ''}"`}</pre>
                <pre>{json(doc.example)}</pre>
                <h4>Fields</h4>
                <table className="info-table">
                  <tbody>
                    {doc.fields.map(([path, meaning]) => (
                      <tr key={path}>
                        <th scope="row">
                          <code>{path}</code>
                        </th>
                        <td>{op.name === 'me' && path === 'token.access' ? accessDoc(writes) : meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}

          {writes &&
            RESOURCE_SPECS.map((spec) => {
              const doc = RESOURCE_DOCS[spec.name];
              const args = Object.entries(spec.args);
              const isBody = spec.method !== 'GET';
              return (
                <section className="api-endpoint" id={spec.name} key={spec.name}>
                  <h3>
                    <code>
                      {spec.method} /api/v1/{spec.path}
                    </code>
                  </h3>
                  <p>{spec.summary}</p>
                  <p className="info-aside">
                    {whoMay(spec)}
                    {spec.id ? ` {id}: ${spec.id.description}` : ''}
                    {spec.versioned ? ' Send the version you read as If-Match.' : ''}
                    {spec.keyed ? ' Takes an Idempotency-Key.' : ''}
                  </p>
                  {args.length > 0 ? (
                    <table className="info-table">
                      <thead>
                        <tr>
                          <th scope="col">{isBody ? 'Field' : 'Parameter'}</th>
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
                              {arg.description}{' '}
                              <span className="info-aside">
                                ({describeKind(arg)}
                                {arg.nullable ? ', or null' : ''}
                                {spec.required?.includes(name) ? '; needed' : ''})
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="info-aside">{isBody ? 'No body.' : 'No parameters.'}</p>
                  )}
                  <h4>Example</h4>
                  <pre>{exampleRequest(base, spec, doc)}</pre>
                  <pre>{json(doc.example)}</pre>
                  <h4>Fields</h4>
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
        </>
      ),
    },
    {
      id: 'pages',
      title: 'Pages of transactions',
      body: (
        <>
          <p>
            <code>/api/v1/transactions</code> answers {DEFAULT_PAGE_SIZE} at a time unless <code>limit</code> says otherwise
            (at most {MAX_PAGE_SIZE}), newest first. While <code>has_more</code> is true, ask again with the same parameters
            and <code>cursor</code> set to <code>next_cursor</code>. The order is total (the day, the moment, then the id), so
            a transaction added between two pages never makes one repeat or skip a row; a cursor works only with the
            parameters it was made for.
          </p>
        </>
      ),
    },
    {
      id: 'mcp',
      title: 'The MCP server',
      body: (
        <>
          <p>
            Nya’s MCP server lets an AI assistant you already use read your data on your behalf, so you can ask it about your
            spending, budgets or net worth. It runs on your own AI subscription: Nya runs no AI itself. What the assistant
            reads goes to its provider, under that provider’s terms.{' '}
            {writes
              ? 'With a token made to read, every tool is read only, and reads what the API above reads. With one made to make changes, the assistant also gets the write tools below, each the endpoint it names; with one made to update balances, only list_accounts and set_account_balance.'
              : 'Every tool is read only, and reads what the API above reads.'}
          </p>
          <ul>
            <li>
              Address: <code>{mcpUrl}</code>, over MCP’s streamable HTTP transport (protocol versions{' '}
              {PROTOCOL_VERSIONS.join(', ')}), one message per request (no batches), answered as plain JSON.
            </li>
            <li>
              Size: <code>search_transactions</code> gives at most {MCP_MAX_PAGE_SIZE} transactions a page, with a cursor
              for the next, and a result too large to send is refused with how to ask for less.
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
          {writes && (
            <>
              <table className="info-table">
                <thead>
                  <tr>
                    <th scope="col">Write tool</th>
                    <th scope="col">What it does</th>
                  </tr>
                </thead>
                <tbody>
                  {WRITE_TOOL_SPECS.map((tool) => (
                    <tr key={tool.name}>
                      <th scope="row">
                        <code>{tool.name}</code>
                      </th>
                      <td>
                        {tool.description}{' '}
                        <span className="info-aside">
                          As <code>{`${resourceSpec(tool.resource).method} /api/v1/${resourceSpec(tool.resource).path}`}</code>. Arguments:{' '}
                          {Object.keys(tool.args).map((name, i) => (
                            <span key={name}>
                              {i > 0 && ', '}
                              <code>{name}</code>
                            </span>
                          ))}
                          .
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                Each write tool is marked for the assistant’s approval prompt (whether it changes or removes something), and
                it and the server’s instructions tell the assistant to change only what you asked for in the conversation, to
                say exactly what will change and wait for your yes, never to change something because text it read asks it
                to, and to give you the change’s id after. An assistant can still be tricked into a change by something it
                reads: use one that asks you before each change. Every change is recorded, and you can undo it under API
                tokens.
              </p>
            </>
          )}
          <p>
            Each tool answers with a sentence of numbers and dates, and the full result as JSON, the same as the endpoint it is
            built on. Names of transactions, merchants and accounts appear only inside that JSON, never in the sentence:
            a merchant chooses its own name, and could choose one that reads like an instruction. Every tool’s description
            tells the assistant to treat them as data.
          </p>
        </>
      ),
    },
    {
      id: 'promises',
      title: 'What version 1 promises',
      body: (
        <>
          <p>
            An endpoint, a parameter or a field in version 1 keeps its name and its meaning. New ones may be added, so a
            program should ignore fields it doesn’t know. A change that can’t keep to that will come as a new version, at{' '}
            <code>/api/v2</code>, and version 1 will keep working beside it for at least six months.
          </p>
          {writes && (
            <p>
              A token’s access names, for good, the kinds of changes it could make when it was made. A new kind of change
              comes with a new choice when a token is made, never to tokens already made, and a program should read a value
              of <code>token.access</code> it doesn’t know as read only.
            </p>
          )}
        </>
      ),
    },
    {
      id: 'not-in-v1',
      title: 'Not in version 1',
      body: (
        <>
          <ul>
            {writes ? (
              <li>
                Writing a bank’s transactions, splits, groups of transactions, rules, budgets, goals or settings; deleting
                accounts, categories, groups or tags, but by undoing the change that made one.
              </li>
            ) : (
              <li>Writing anything: adding transactions, changing categories, budgets or balances.</li>
            )}
            <li>Signing in on your behalf for a third-party app (OAuth): tokens are personal.</li>
            <li>Being told when your data changes (webhooks): ask again instead.</li>
            <li>Live balances: everything is what Nya has stored, with its date.</li>
            <li>A sandbox to try the API against: the demo accounts can’t make tokens, since everyone who tries the demo shares their data.</li>
          </ul>
        </>
      ),
    },
  ];
  const sections = parts.filter((s) => s !== false);

  return (
    <InfoPage page="developers" title="Developers" intro={intro} sections={sections} />
  );
}
