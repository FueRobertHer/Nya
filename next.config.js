/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Next's default TypeScript integration loads the legacy JS Compiler API
    // (lib/typescript.js), which the native TypeScript 7 package no longer
    // ships. This flag makes `next build`/`next dev` shell out to the local
    // `tsc` CLI instead, so the native TS7 compiler works. See
    // https://github.com/vercel/next.js/pull/95639
    useTypeScriptCli: true,
  },
};

module.exports = nextConfig;
