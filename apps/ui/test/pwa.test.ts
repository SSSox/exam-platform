import { describe, expect, it } from "vitest";
import { precacheList, shellVersion, workerSource } from "../scripts/worker.ts";
import { reloadAllowed, shouldRegisterWorker } from "../src/pwa.ts";

const build = [
  "index.html",
  "sw.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
  "assets/index-AAA.js",
  "assets/index-BBB.css",
  "assets/render-CCC.js",
  "assets/math-DDD.js",
  "assets/katex-EEE.css",
  "assets/nunito-latin-wght-normal-FFF.woff2",
  "assets/KaTeX_Main-Regular-GGG.woff2",
  "assets/KaTeX_Main-Regular-HHH.ttf",
  "assets/index-AAA.js.map",
  "content/index.json",
  "content/nodes/abc.json",
];

describe("precacheList", () => {
  const list = precacheList(build);
  it("has the page, every script and style (lazy chunks too), Nunito and the static files", () => {
    expect(list).toEqual([
      "./",
      "assets/index-AAA.js",
      "assets/index-BBB.css",
      "assets/katex-EEE.css",
      "assets/math-DDD.js",
      "assets/nunito-latin-wght-normal-FFF.woff2",
      "assets/render-CCC.js",
      "manifest.webmanifest",
      "icon.svg",
      "icon-192.png",
      "icon-512.png",
      "icon-maskable-512.png",
      "apple-touch-icon.png",
    ]);
  });
  it("leaves out content, KaTeX fonts, source maps, the worker and index.html as a separate entry", () => {
    expect(list.some((f) => f.startsWith("content/") || f.includes("KaTeX_") || f.endsWith(".map") || f === "sw.js" || f === "index.html")).toBe(false);
  });
  it("works the same without content and lists only static files that exist", () => {
    expect(precacheList(["index.html", "assets/a.js"])).toEqual(["./", "assets/a.js"]);
    expect(precacheList(build.filter((f) => !f.startsWith("content/")))).toEqual(list);
  });
  it("accepts Windows separators", () => {
    expect(precacheList(["assets\\a.js"])).toEqual(["./", "assets/a.js"]);
  });
});

describe("shellVersion", () => {
  const list = precacheList(build);
  const base = shellVersion(list, "<html>a</html>");
  it("is stable for the same input, whatever the order", () => {
    expect(shellVersion([...list].reverse(), "<html>a</html>")).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{12}$/);
  });
  it("changes with a file name or the page", () => {
    expect(shellVersion(precacheList([...build, "assets/new-ZZZ.js"]), "<html>a</html>")).not.toBe(base);
    expect(shellVersion(precacheList(build.map((f) => f.replace("AAA", "A2"))), "<html>a</html>")).not.toBe(base);
    expect(shellVersion(list, "<html>b</html>")).not.toBe(base);
  });
});

describe("workerSource", () => {
  const list = precacheList(build);
  const text = workerSource(list, "abc123");
  it("is valid script text with the version and the list", () => {
    expect(() => new Function(text)).not.toThrow();
    expect(text).toContain('"exam-trainer-shell-"');
    expect(text).toContain('"abc123"');
    for (const f of list) expect(text).toContain(JSON.stringify(f));
  });
  it("never claims clients (skipWaiting is covered by worker.test.ts)", () => {
    expect(text).not.toMatch(/clients\.claim\(/);
  });
});

describe("shouldRegisterWorker", () => {
  const ok = { prod: true, supported: true, shell: false, protocol: "https:", search: "" };
  it("registers in a production build on https", () => {
    expect(shouldRegisterWorker(ok)).toBe(true);
  });
  it("needs a production build, worker support and no shell", () => {
    expect(shouldRegisterWorker({ ...ok, prod: false })).toBe(false);
    expect(shouldRegisterWorker({ ...ok, supported: false })).toBe(false);
    expect(shouldRegisterWorker({ ...ok, shell: true })).toBe(false);
  });
  it("on http only with the ?sw flag", () => {
    expect(shouldRegisterWorker({ ...ok, protocol: "http:" })).toBe(false);
    expect(shouldRegisterWorker({ ...ok, protocol: "http:", search: "?x=1" })).toBe(false);
    expect(shouldRegisterWorker({ ...ok, protocol: "http:", search: "?sw" })).toBe(true);
    expect(shouldRegisterWorker({ ...ok, protocol: "http:", search: "?a=1&sw=1" })).toBe(true);
  });
  it("keeps the shell and prod gates even with the flag", () => {
    expect(shouldRegisterWorker({ ...ok, shell: true, search: "?sw" })).toBe(false);
    expect(shouldRegisterWorker({ ...ok, prod: false, protocol: "http:", search: "?sw" })).toBe(false);
  });
});

describe("reloadAllowed", () => {
  it("reloads at once the first time and not again within ten seconds", () => {
    expect(reloadAllowed(null, 1000)).toBe(true);
    expect(reloadAllowed(1000, 5000)).toBe(false);
    expect(reloadAllowed(1000, 11_000)).toBe(true);
  });
  it("ignores a garbage or future mark", () => {
    expect(reloadAllowed(Number.NaN, 1000)).toBe(true);
    expect(reloadAllowed(9000, 1000)).toBe(true);
    // Offline the chunk is missing for want of a network: no reload, whatever the mark says.
    expect(reloadAllowed(null, 1000, false)).toBe(false);
  });
});
