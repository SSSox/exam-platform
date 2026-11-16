import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { appLinks, isShell } from "../src/lib.ts";
import { parseDownloads } from "../src/downloads-config.ts";

const both = { windows: "https://example.test/app.exe", android: "https://example.test/app.apk" };
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";
const PHONE = "Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36";

describe("links to the apps", () => {
  test("the web page offers both apps, Windows first on a computer", () => {
    expect(appLinks(both, false, DESKTOP)).toEqual([{ os: "windows", href: both.windows }, { os: "android", href: both.android }]);
  });

  test("a phone with Android sees its own app first", () => {
    expect(appLinks(both, false, PHONE).map((l) => l.os)).toEqual(["android", "windows"]);
  });

  test("inside the Windows or Android app there is nothing to download", () => {
    expect(appLinks(both, true, PHONE)).toEqual([]);
  });

  test("an app without an address is not offered", () => {
    expect(appLinks({ android: both.android }, false, DESKTOP)).toEqual([{ os: "android", href: both.android }]);
    expect(appLinks({}, false, DESKTOP)).toEqual([]);
  });

  test("the apps are told apart from the web page", () => {
    expect(isShell("tauri.localhost", {})).toBe(true);
    expect(isShell("localhost", { __TAURI_INTERNALS__: {} })).toBe(true); // `tauri dev`
    expect(isShell("localhost", { ExamSystemBars: {} })).toBe(true);
    expect(isShell("sssox.github.io", {})).toBe(false);
    expect(isShell("localhost", {})).toBe(false);
  });
});

describe("download addresses of a build", () => {
  const file = JSON.stringify(both);

  test("the file gives the addresses, a variable replaces one of them", () => {
    expect(parseDownloads(file, {})).toEqual(both);
    expect(parseDownloads(file, { android: " https://mirror.test/a.apk " })).toEqual({ windows: both.windows, android: "https://mirror.test/a.apk" });
    expect(parseDownloads(undefined, { windows: both.windows })).toEqual({ windows: both.windows });
    expect(parseDownloads(undefined, {})).toEqual({});
    expect(parseDownloads(`\uFEFF${file}`, {})).toEqual(both);
  });

  test("none in any case or an empty value hides a link", () => {
    expect(parseDownloads(file, { windows: "NONE", android: "" })).toEqual({});
    expect(parseDownloads(JSON.stringify({ windows: " None ", android: null }), {})).toEqual({});
  });

  test("anything but an https address stops the build and says where it came from", () => {
    expect(() => parseDownloads(file, { android: "http://x.test/a.apk" })).toThrow("VITE_DOWNLOAD_ANDROID must be an https address");
    expect(() => parseDownloads(JSON.stringify({ windows: "javascript:alert(1)" }), {})).toThrow("downloads.json: `windows` must be an https address");
    expect(() => parseDownloads(JSON.stringify({ windows: "https:///x" }), {})).toThrow("https address");
    expect(() => parseDownloads(JSON.stringify({ windows: [both.windows] }), {})).toThrow("must be a string");
    expect(() => parseDownloads("null", {})).toThrow("downloads.json: expected an object");
    expect(() => parseDownloads("{windows:", {})).toThrow(/^downloads\.json: /);
    expect(parseDownloads(JSON.stringify({ windows: "HTTPS://h.test/a.exe?v=1" }), {})).toEqual({ windows: "HTTPS://h.test/a.exe?v=1" });
  });

  test("an address that would not open, or carries an invisible character, stops the build", () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const backslash = String.fromCharCode(92);
    const cyrillicA = String.fromCharCode(0x430);
    for (const bad of [
      "https://:", "https://.", `https://h.test/a${zeroWidthSpace}`, "https://h.test/a\u0001",
      `https://${zeroWidthSpace}h.test/a`, "https://\th.test/a", `https://${backslash}evil.test/a`, `https://${cyrillicA}.test/a`,
    ]) {
      expect(() => parseDownloads(JSON.stringify({ windows: bad }), {}), bad).toThrow("must be an https address");
    }
  });

  test("a misspelt key or a UTF-16 file stops the build instead of hiding a link", () => {
    expect(() => parseDownloads(JSON.stringify({ Windows: both.windows }), {})).toThrow("downloads.json: unknown key `Windows`");
    expect(() => parseDownloads(Buffer.from(file, "utf16le").toString("utf8"), {})).toThrow("downloads.json: save the file as UTF-8");
  });
});

describe("interface strings", () => {
  const keys = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix.slice(0, -1)];
  const locale = (name: string) => keys(JSON.parse(readFileSync(new URL(`../src/locales/${name}.json`, import.meta.url), "utf8")));

  test("Kazakh and English have the same keys as Russian", () => {
    // Plural forms differ by language (_few and _many exist in Russian only), so they are compared without the suffix.
    const base = (name: string) => [...new Set(locale(name).map((k) => k.replace(/_(zero|one|two|few|many|other)$/, "")))].sort();
    expect(base("kk")).toEqual(base("ru"));
    expect(base("en")).toEqual(base("ru"));
  });
});
