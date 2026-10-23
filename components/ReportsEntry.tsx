// Where the report page (app/reports) is found from: the Activity tab, under
// its transactions.
// A link, not state: the page makes its own report.

export default function ReportsEntry() {
  return (
    <div className="card report-entry">
      <div className="inst-header">
        <div className="inst-name">Reports</div>
      </div>
      <p className="panel-note">
        A summary of a tax year, or of any dates, by category and by month, for your accountant; how long your cash would last; and this year against
        last. Each says what it may be missing. Print one, or save it as a PDF.
      </p>
      <a className="report-link-button" href="/reports">
        Open reports
      </a>
    </div>
  );
}
