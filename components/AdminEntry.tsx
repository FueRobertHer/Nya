import { chevron, RIGHT } from './MonthStepper';

// Settings > Admin, for the deployment's admin only: one row to the admin page
// (/admin, components/AdminPage.tsx), where the feature switches, the nightly
// jobs, storage across accounts, unused connections and the environment are.
// The server decides who the admin is (app/page.tsx), and the page refuses
// anyone else. A link, not state: the page reads its own.

export default function AdminEntry() {
  return (
    <ul className="card list-rows">
      <li>
        <a className="list-row" href="/admin">
          <span className="list-row-text">
            <span className="list-row-title">Admin page</span>
            <span className="list-row-sub">Feature switches, nightly jobs, storage, unused connections, the environment</span>
          </span>
          {chevron(RIGHT)}
        </a>
      </li>
    </ul>
  );
}
