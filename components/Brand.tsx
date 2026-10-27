/** The logo: the app icon on a dark ground, and its light version
 *  (public/icons/icon-light.svg: a gold disc with a white face in a navy ring)
 *  on a light one. Both are sent; app/globals.css shows the one the theme
 *  calls for, by the theme's own selectors, so it follows a choice in
 *  Settings, the system and print with no script. Under /icons/ because the
 *  sign-in pages show it before anyone signs in (proxy.ts lets that folder
 *  through). */
export function BrandLogo() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- the app icon, already a static SVG */}
      <img className="brand-logo dark" src="/icon.svg" alt="" width={34} height={34} />
      {/* eslint-disable-next-line @next/next/no-img-element -- its light version, a static SVG */}
      <img className="brand-logo light" src="/icons/icon-light.svg" alt="" width={34} height={34} />
    </>
  );
}

// The logo and name, as in the dashboard header.
export function Brand() {
  return (
    <div className="brand">
      <BrandLogo />
      <h1>Nya</h1>
    </div>
  );
}
