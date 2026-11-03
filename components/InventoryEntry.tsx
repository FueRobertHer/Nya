// Where Your data (app/your-data) is found from: Settings, Your data and privacy,
// beside Download my data. A link, not state: the page reads its own. The
// admin's pages are reached from Settings > Admin (components/AdminEntry.tsx).

export default function InventoryEntry() {
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
    </div>
  );
}
