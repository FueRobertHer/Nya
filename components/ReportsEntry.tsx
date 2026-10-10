// Where the report page (app/reports) is found from: the Activity tab, under
// its transactions, and Manage on the Accounts tab, beside Download my data.
// A link, not state: the page makes its own report.

export default function ReportsEntry() {
  return (
    <div className="card report-entry">
      <div className="inst-header">
        <div className="inst-name">Reports</div>
      </div>
      <p className="panel-note">
        A summary of a tax year, or of any dates, by category and by month, with what it may be missing. Print it, or save it as a PDF, for your accountant.
      </p>
      <a className="report-link-button" href="/reports">
        Open reports
      </a>
    </div>
  );
}
