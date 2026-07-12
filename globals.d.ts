// Global CSS side-effect imports (e.g. `import './globals.css'`) carry no type
// information — the bundler handles them at build time. Next's ambient types
// only cover CSS Modules (`*.module.css`) and images, so we declare plain CSS
// here. Required since the native TypeScript 7 compiler errors (TS2882) on
// side-effect imports it can't resolve to a module.
declare module '*.css';
