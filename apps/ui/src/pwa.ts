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
  const register = () => void navigator.serviceWorker.register("./sw.js").catch(() => {});
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
