// Where Your data (app/your-data) is found from: Settings, Your data and privacy,
// beside Download my data. For the admin, also the ways to Storage across
// accounts (/admin/storage) and Nightly jobs (/admin/jobs); the server decides who the admin is
// (app/page.tsx), and the page and its route refuse anyone else. Links, not
// state: each page reads its own.

export default function InventoryEntry({ admin = false }: { admin?: boolean }) {
  return (
    <div className="card report-entry">
      <div className="inst-header">
        <div className="inst-name">Your data</div>
      </div>
      <p className="panel-note">
        Every kind of thing Nya keeps about you: how much of it there is, whether it is encrypted, whether it is in your download, how long it is kept and who else
        can see it.
      </p>
      <a className="report-link-button" href="/your-data">
        See what Nya keeps
      </a>
      {admin && (
        <a className="report-link-button" href="/admin/storage">
          Storage across accounts (admin)
        </a>
      )}
      {admin && (
        <a className="report-link-button" href="/admin/jobs">
          Nightly jobs (admin)
        </a>
      )}
    </div>
  );
}
