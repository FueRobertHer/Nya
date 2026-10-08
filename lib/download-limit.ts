// lib/download-limit.ts
//
// How often a person may download their data (app/api/my-data). Its own
// module, free of server imports, because two places need the same number:
// the limit itself (lib/rate-limit.ts) and the card that tells people what it
// is (components/DownloadMyData.tsx).

export const DOWNLOADS_PER_WINDOW = 5;
export const DOWNLOAD_WINDOW_SECONDS = 60 * 60;
