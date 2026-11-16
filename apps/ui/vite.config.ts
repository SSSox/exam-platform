import { existsSync, readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { parseDownloads } from "./src/downloads-config.ts";

/**
 * Where the app pulls question banks from over the network: the `urls` of `content-sources.json`
 * in the repository root (the link to the content repository), unless `VITE_CONTENT_URLS`
 * (comma separated) is set for this build. The snapshot inside the app (`ContentClient`'s `snapshot`) is the fallback for the index
 * and the first place to look for hashed files.
 */
function contentUrls(): string[] {
  const fromEnv = (process.env.VITE_CONTENT_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const file = new URL("../../content-sources.json", import.meta.url);
  const { urls } = JSON.parse(readFileSync(file, "utf8")) as { urls?: unknown };
  if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) throw new Error("content-sources.json: `urls` must be a list of strings");
  return urls.map((u: string) => u.trim()).filter(Boolean);
}

/** Where the web page sends people for the Windows and Android apps: `downloads.json` in the repository root and the `VITE_DOWNLOAD_*` variables (see `parseDownloads`). */
function downloads(): { windows?: string; android?: string } {
  const file = new URL("../../downloads.json", import.meta.url);
  return parseDownloads(existsSync(file) ? readFileSync(file, "utf8") : undefined, {
    windows: process.env.VITE_DOWNLOAD_WINDOWS,
    android: process.env.VITE_DOWNLOAD_ANDROID,
  });
}

export default defineConfig({
  // Relative paths so the same build works on a web host, in Tauri and from a subfolder.
  base: "./",
  plugins: [react()],
  define: {
    __CONTENT_URLS__: JSON.stringify(contentUrls()),
    // `scripts/content.mjs` runs before vite; with `EXAM_CONTENT_DIR=none` it leaves no snapshot, and the app must not look for one.
    __CONTENT_SNAPSHOT__: JSON.stringify(existsSync(new URL("./public/content/index.json", import.meta.url))),
    __DOWNLOADS__: JSON.stringify(downloads()),
  },
  server: { port: 5183, strictPort: true },
  clearScreen: false,
});
