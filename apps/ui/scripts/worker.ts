import { createHash } from "node:crypto";

/**
 * Pure helpers that turn the list of files of a finished build into the offline shell worker (`sw.js`).
 * No Vite and no file system here, so the rules are unit-tested; `vite.config.ts` does the reading and writing.
 */

/** The page itself: the scope URL. `index.html` is the same resource and is cached once under this name. */
export const PAGE = "./";

/** Prefix of the shell caches. The origin is shared with other sites, so only names with this prefix are ever deleted. */
export const CACHE_PREFIX = "exam-trainer-shell-";

/** Files from `public/` that belong to the shell. */
const STATIC = ["manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

/**
 * What goes into the precache, as URLs relative to the worker. Every script and style under `assets/`, lazy chunks included
 * (after a new deploy the host no longer serves the old hashed files, and an open old page still has to load its lazy chunks),
 * the Nunito fonts and the static files above. Not the question banks (`content/`: absent in some builds, and the app has its own
 * verified cache for them), not the KaTeX fonts (cached on first use by the worker), not source maps, not the worker itself.
 * Static files are listed only when they exist: one missing file would fail the whole install.
 */
export function precacheList(files: readonly string[]): string[] {
  const all = new Set(files.map((f) => f.replace(/\\/g, "/")));
  const keep = (f: string): boolean => {
    if (!f.startsWith("assets/") || f.indexOf("/", "assets/".length) !== -1) return false;
    const name = f.slice("assets/".length);
    return /\.(js|css)$/.test(name) || (/\.woff2$/.test(name) && /^nunito/i.test(name));
  };
  return [PAGE, ...[...all].filter(keep).sort(), ...STATIC.filter((f) => all.has(f))];
}

/** Short hash of the sorted list plus the page: any added, renamed or removed file or a changed page makes a new version. */
export function shellVersion(list: readonly string[], html: string): string {
  return createHash("sha256").update([...list].sort().join("\n")).update("\0").update(html).digest("hex").slice(0, 12);
}

/** The text of `sw.js`. Plain ES2020 without imports: it runs as a classic worker script. */
export function workerSource(list: readonly string[], version: string): string {
  return `/* Offline shell of the web version. Generated at build time; the file name must never change. */
"use strict";

const CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)};
const CACHE = CACHE_PREFIX + ${JSON.stringify(version)};
const FILES = ${JSON.stringify(list, null, 2)};

// Everything is resolved against the scope: the site lives under a sub-path and the same build can run from any folder.
const SCOPE = self.registration.scope;
const URLS = new Set(FILES.map((f) => new URL(f, SCOPE).href));
const PAGE = new URL(${JSON.stringify(PAGE)}, SCOPE).href;
const KATEX_FONTS = SCOPE + "assets/KaTeX_";

// No skipWaiting and no clients.claim calls: a new version takes over only once the pages of the old one are closed,
// so a running page never sees a mix of two builds.
self.addEventListener("install", (event) => {
  // addAll is atomic: if any file fails, the install fails and the previous worker stays in charge.
  // "reload" skips the HTTP cache, which could otherwise hand over a stale page or icon. Files under assets/ carry a content hash in
  // their names, so the copy the browser already has is the right one and a new version downloads only what changed.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES.map((f) => new Request(new URL(f, SCOPE).href, { cache: f.startsWith("assets/") ? "default" : "reload" })))));
});

self.addEventListener("activate", (event) => {
  // Cache Storage is shared by every site on this origin: touch only our own older versions.
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)))),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // The page is the same resource with any query string (for example the ?sw flag).
  const page = url.origin + url.pathname;
  const key = page === PAGE || page === PAGE + "index.html" ? PAGE : url.href;

  if (URLS.has(key)) {
    event.respondWith(fromCache(request, key, false));
  } else if (!url.search && url.href.startsWith(KATEX_FONTS)) {
    // Hashed and immutable, and only some formulas need them: cached on first use.
    event.respondWith(fromCache(request, key, true));
  }
  // Anything else (question banks, content/, latest.json, other origins) is left to the browser: no respondWith.
});

// This version's cache first, the network if the entry is missing. Never caches.match(): it would also look in other versions and other sites' caches.
function fromCache(request, key, store) {
  return caches
    .open(CACHE)
    .then((cache) =>
      // ignoreVary: the entry was stored by this worker under this very URL, whatever headers the host varies on.
      cache.match(key, { ignoreVary: true }).then((hit) => {
        if (hit) return hit;
        return fetch(request).then((response) => {
          if (store && response.ok) cache.put(key, response.clone());
          return response;
        });
      }),
    )
    .catch(() => fetch(request));
}
`;
}
