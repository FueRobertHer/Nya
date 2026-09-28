// The logo and name, as in the dashboard header.
export function Brand() {
  return (
    <div className="brand">
      {/* eslint-disable-next-line @next/next/no-img-element -- the app icon, already a static SVG */}
      <img className="brand-logo" src="/icon.svg" alt="" width={34} height={34} />
      <h1>Nya</h1>
    </div>
  );
}
