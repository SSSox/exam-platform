import { describe, expect, it } from "vitest";
import { precacheList, shellVersion, workerSource } from "../scripts/worker.ts";

const SCOPE = "https://u.github.io/exam-platform/";
const PAGE_HTML = (extra = "") =>
  `<!doctype html><html><head><link rel="icon" href="./icon.svg"><script type="module" crossorigin src="./assets/index-AAA.js"></script>` +
  `<link rel="stylesheet" crossorigin href="./assets/index-BBB.css">${extra}</head><body></body></html>`;
const LIST = precacheList(["index.html", "manifest.webmanifest", "icon.svg", "assets/index-AAA.js", "assets/index-BBB.css", "assets/render-CCC.js"]);

type Handler = (event: any) => unknown;
type Caches = ReturnType<typeof fakeCaches>;

/** In-memory stand-ins for Cache Storage; entries are keyed by URL string. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  return {
    stores,
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return { match: async (key: string) => store.get(key)?.clone(), put: async (key: string, response: Response) => void store.set(key, response), keys: async () => [...store.keys()].map((url) => ({ url })) };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
}

type Net = { requests: { url: string; cache: string }[]; files: Record<string, string | Response> };

/** Runs the generated worker text with fake globals and returns its listeners. */
function boot(version: string, caches: Caches, net: Net, scope = SCOPE) {
  const handlers = new Map<string, Handler>();
  const skipped: number[] = [];
  const self = {
    registration: { scope },
    addEventListener: (type: string, fn: Handler) => void handlers.set(type, fn),
    skipWaiting: () => void skipped.push(1),
  };
  const fakeFetch = async (input: Request | string) => {
    const url = typeof input === "string" ? input : input.url;
    net.requests.push({ url, cache: typeof input === "string" ? "default" : input.cache });
    const body = net.files[url];
    if (body === undefined) return new Response("nope", { status: 404 });
    return body instanceof Response ? body.clone() : new Response(body);
  };
  new Function("self", "caches", "fetch", workerSource(LIST, version))(self, caches, fakeFetch);
  const run = async (type: string) => {
    const waits: Promise<unknown>[] = [];
    handlers.get(type)!({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  /** Sends a fetch event; resolves to the response the worker gave, or `undefined` when it did not call respondWith. */
  const route = async (url: string, method = "GET"): Promise<Response | undefined> => {
    let given: Promise<Response> | undefined;
    handlers.get("fetch")!({ request: new Request(url, { method }), respondWith: (p: Promise<Response>) => (given = p) });
    return given && (await given);
  };
  return { run, route, handlers, skipped };
}

const netFor = (html = PAGE_HTML(), scope = SCOPE): Net => ({
  requests: [],
  files: {
    [scope]: html,
    [scope + "manifest.webmanifest"]: "{}",
    [scope + "icon.svg"]: "<svg/>",
    [scope + "assets/index-AAA.js"]: "js",
    [scope + "assets/index-BBB.css"]: "css",
    [scope + "assets/render-CCC.js"]: "lazy",
  },
});

describe("worker install", () => {
  it("caches every file of the list; pages are fetched with a conditional request, hashed files from the HTTP cache", async () => {
    const caches = fakeCaches(), net = netFor();
    await boot("v1", caches, net).run("install");
    const [name] = [...caches.stores.keys()];
    expect([...caches.stores.get(name!)!.keys()].sort()).toEqual(LIST.map((f) => new URL(f, SCOPE).href).sort());
    const modes = Object.fromEntries(net.requests.map((r) => [r.url.replace(SCOPE, "./"), r.cache]));
    expect(modes["./"]).toBe("no-cache");
    expect(modes["./manifest.webmanifest"]).toBe("no-cache");
    expect(modes["./assets/index-AAA.js"]).toBe("default");
  });

  it("fails and stores nothing when one file is missing or not 2xx", async () => {
    const caches = fakeCaches(), net = netFor();
    net.files[SCOPE + "assets/render-CCC.js"] = new Response("gone", { status: 404 });
    await expect(boot("v1", caches, net).run("install")).rejects.toThrow();
    expect(caches.stores.size).toBe(0);
    delete net.files[SCOPE + "icon.svg"];
    await expect(boot("v1", caches, net).run("install")).rejects.toThrow();
    expect(caches.stores.size).toBe(0);
  });

  it("fails when the page names a script or style that is not in the list (a stale CDN page)", async () => {
    const caches = fakeCaches();
    const stale = netFor(PAGE_HTML(`<script type="module" src="./assets/index-OLD.js"></script>`));
    await expect(boot("v1", caches, stale).run("install")).rejects.toThrow(/index-OLD/);
    expect(caches.stores.size).toBe(0);
    const styled = netFor(PAGE_HTML(`<link rel="modulepreload" href="./assets/other-ZZZ.css">`));
    await expect(boot("v1", caches, styled).run("install")).rejects.toThrow(/other-ZZZ/);
    expect(caches.stores.size).toBe(0);
  });

  it("accepts a page whose assets are all listed, and ignores links outside assets/", async () => {
    const caches = fakeCaches();
    const ok = netFor(PAGE_HTML(`<link rel="modulepreload" href="./assets/render-CCC.js"><link rel="canonical" href="https://elsewhere.test/x.js">`));
    await boot("v1", caches, ok).run("install");
    expect(caches.stores.size).toBe(1);
  });
});

describe("worker fetch routing", () => {
  async function installed() {
    const caches = fakeCaches(), net = netFor();
    const worker = boot("v1", caches, net);
    await worker.run("install");
    net.requests.length = 0;
    return { worker, net, caches };
  }

  it("serves a listed file from the cache without the network", async () => {
    const { worker, net } = await installed();
    const response = await worker.route(SCOPE + "assets/index-AAA.js");
    expect(await response!.text()).toBe("js");
    expect(net.requests).toEqual([]);
  });

  it("serves the page for ./, ./?sw and index.html", async () => {
    const { worker } = await installed();
    for (const url of [SCOPE, SCOPE + "?sw", SCOPE + "index.html", SCOPE + "index.html?sw=1"]) {
      expect(await (await worker.route(url))!.text()).toContain("<!doctype html>");
    }
  });

  it("leaves banks, content/, other origins, other paths and unlisted files to the browser", async () => {
    const { worker } = await installed();
    for (const url of [
      "https://u.github.io/exam-content/index.json",
      SCOPE + "content/index.json",
      SCOPE + "latest.json",
      SCOPE + "assets/unknown-XXX.js",
      "https://cdn.example.com/assets/index-AAA.js",
      "https://u.github.io/other-copy/assets/index-AAA.js",
    ]) expect(await worker.route(url), url).toBeUndefined();
  });

  it("does not answer a POST, even for a listed file", async () => {
    const { worker } = await installed();
    expect(await worker.route(SCOPE + "assets/index-AAA.js", "POST")).toBeUndefined();
  });

  it("caches a KaTeX font on first use only", async () => {
    const { worker, net, caches } = await installed();
    const font = SCOPE + "assets/KaTeX_Main-Regular-GGG.woff2";
    net.files[font] = "font";
    expect(await (await worker.route(font))!.text()).toBe("font");
    net.requests.length = 0;
    expect(await (await worker.route(font))!.text()).toBe("font");
    expect(net.requests).toEqual([]);
    expect(await worker.route(font + "?v=1")).toBeUndefined();
    expect(caches.stores.size).toBe(1);
  });
});

describe("worker versions and activation", () => {
  const names = (caches: Caches) => [...caches.stores.keys()].sort();

  it("names the cache after the scope path and the version", async () => {
    const caches = fakeCaches();
    await boot("v1", caches, netFor()).run("install");
    expect(names(caches)[0]).toMatch(/^exam-trainer-shell-[0-9a-f]{8}-v1$/);
  });

  it("deletes its own older versions and the old unscoped names, nothing else", async () => {
    const caches = fakeCaches();
    await boot("v1", caches, netFor()).run("install");
    // A second copy of the app on the same origin, under another path.
    const fork = "https://u.github.io/fork/";
    await boot("v1", caches, netFor(PAGE_HTML(), fork), fork).run("install");
    const [own, forkName] = names(caches);
    expect(own).not.toBe(forkName);
    for (const name of ["exam-trainer-shell-0123456789ab", "exam-trainer-shell-notes", "other-site-cache"]) await caches.open(name);
    // Old unscoped names: one holds this copy's files, one a fork's (kept: the old name cannot say whose it is, its files can).
    await (await caches.open("exam-trainer-shell-aaaaaaaaaaaa")).put(SCOPE + "index.html", new Response("old"));
    await (await caches.open("exam-trainer-shell-bbbbbbbbbbbb")).put(fork + "index.html", new Response("old fork"));

    const next = boot("v2", caches, netFor());
    await next.run("install");
    await next.run("activate");
    const left = names(caches);
    expect(left).toContain(forkName);
    expect(left).toContain("exam-trainer-shell-notes");
    expect(left).toContain("other-site-cache");
    expect(left).not.toContain("exam-trainer-shell-0123456789ab");
    expect(left).not.toContain("exam-trainer-shell-aaaaaaaaaaaa");
    expect(left).toContain("exam-trainer-shell-bbbbbbbbbbbb");
    expect(left).not.toContain(own);
    expect(left.filter((n) => n.endsWith("-v2"))).toHaveLength(1);
    expect(left).toHaveLength(5);
  });

  it("keeps the current cache when it activates", async () => {
    const caches = fakeCaches();
    const worker = boot("v1", caches, netFor());
    await worker.run("install");
    await worker.run("activate");
    expect(names(caches)).toHaveLength(1);
  });
});

describe("skipWaiting", () => {
  it("is called only for an activate message", async () => {
    const worker = boot("v1", fakeCaches(), netFor());
    await worker.run("install");
    await worker.run("activate");
    expect(worker.skipped).toEqual([]);
    const page = { url: SCOPE + "#/session" };
    worker.handlers.get("message")!({ data: { type: "other" }, source: page });
    worker.handlers.get("message")!({ data: undefined, source: page });
    // Another site on the shared origin, or no sender, cannot switch this copy.
    worker.handlers.get("message")!({ data: { type: "activate" }, source: { url: "https://u.github.io/other-site/" } });
    worker.handlers.get("message")!({ data: { type: "activate" }, source: null });
    expect(worker.skipped).toEqual([]);
    worker.handlers.get("message")!({ data: { type: "activate" }, source: page });
    expect(worker.skipped).toEqual([1]);
  });
});

describe("shellVersion", () => {
  it("changes with the page", () => {
    expect(shellVersion(LIST, "a")).not.toBe(shellVersion(LIST, "b"));
  });
});
