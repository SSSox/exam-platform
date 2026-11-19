import { useSyncExternalStore } from "react";
import { isShell } from "./lib.ts";

/**
 * Whether to register the offline worker. Only in a production build, where the browser has workers, outside the Windows and Android
 * shells (a worker there would keep serving the old interface after an app update), and on https. A local http preview needs the
 * explicit `?sw` flag: without it a worker on localhost would keep serving stale builds to developers and to the screenshot tool.
 */
export function shouldRegisterWorker(env: { prod: boolean; supported: boolean; shell: boolean; protocol: string; search: string }): boolean {
  if (!env.prod || !env.supported || env.shell) return false;
  return env.protocol === "https:" || new URLSearchParams(env.search).has("sw");
}

let waiting: ServiceWorker | undefined;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The new version of the site that is installed and waits for the button, or nothing. Used by `useSyncExternalStore`. */
export const useSiteUpdate = (): boolean => useSyncExternalStore(subscribe, () => waiting !== undefined);

/** Tells the waiting worker to take over; the pages reload on `controllerchange`. Only the button calls this. */
export const applySiteUpdate = () => waiting?.postMessage({ type: "activate" });

/** Shows the button only while an older worker still controls this page: on the first visit there is nothing to replace. */
function watch(reg: ServiceWorkerRegistration): void {
  const check = () => {
    if (reg.waiting && navigator.serviceWorker.controller && waiting !== reg.waiting) {
      waiting = reg.waiting;
      listeners.forEach((listener) => listener());
    }
  };
  check();
  reg.addEventListener("updatefound", () => {
    const next = reg.installing;
    next?.addEventListener("statechange", () => {
      if (next.state === "installed") check();
    });
  });
}

/** Whether a failed lazy chunk should reload the page: not when the page already reloaded for this a moment ago (a loop). */
export function reloadAllowed(last: number | null, now: number, span = 10_000): boolean {
  return last == null || !Number.isFinite(last) || now - last >= span || now < last;
}

/**
 * A lazy chunk that 404s after a deploy (the host no longer has the old hashed files): one reload fetches the new page.
 * The mark lives in sessionStorage, so a second failure within seconds shows the usual error instead of looping.
 */
export function reloadOnChunkError(event: Event): void {
  try {
    const raw = sessionStorage.getItem(CHUNK_RELOAD);
    if (!reloadAllowed(raw == null ? null : Number(raw), Date.now())) return;
    sessionStorage.setItem(CHUNK_RELOAD, String(Date.now()));
  } catch {
    return; // without storage a loop could not be stopped
  }
  event.preventDefault();
  location.reload();
}

const CHUNK_RELOAD = "exam-chunk-reload";

/** Registers `sw.js` after the page has loaded, so it never competes with the first render. A failure is ignored: the page works without it. */
export function registerWorker(): void {
  const allowed = shouldRegisterWorker({
    prod: import.meta.env.PROD,
    supported: "serviceWorker" in navigator,
    shell: isShell(location.hostname, window), // same check as `inShell()` in platform.ts, which cannot be imported without its storage setup
    protocol: location.protocol,
    search: location.search,
  });
  if (!allowed) return;
  // Only a page that already had a worker reloads when another one takes over, and only once.
  let reloading = false;
  const controlled = navigator.serviceWorker.controller != null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlled || reloading) return;
    reloading = true;
    location.reload();
  });
  const register = () => void navigator.serviceWorker.register("./sw.js").then(watch).catch(() => {});
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
