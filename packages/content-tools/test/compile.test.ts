import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileContent } from "../src/index.ts";
import { cleanTemp, copyDemo, tempDir } from "./demo.ts";

afterAll(cleanTemp);

const names = (dir: string) => readdirSync(dir).sort();
const NOT_ERASED = /not empty and does not look like a previous build/;

/** `compile` must refuse before it deletes anything: the content tree has to be exactly as it was. */
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();

describe("compile: what it is allowed to erase", () => {
  it("refuses a non-empty folder that is not a previous build and keeps its files", () => {
    const root = copyDemo();
    const out = tempDir("exam-out-");
    writeFileSync(join(out, "notes.txt"), "mine");
    mkdirSync(join(out, "nodes"));
    expect(() => compileContent(root, out)).toThrow(NOT_ERASED);
    expect(readFileSync(join(out, "notes.txt"), "utf8")).toBe("mine");
    expect(names(out)).toEqual(["nodes", "notes.txt"]);
  });

  it("refuses folders and an index that only share a build's names", () => {
    const root = copyDemo();
    const mine = tempDir("exam-out-");
    mkdirSync(join(mine, "nodes", "mine"), { recursive: true });
    writeFileSync(join(mine, "nodes", "mine", "thesis.txt"), "mine");
    expect(() => compileContent(root, mine)).toThrow(NOT_ERASED);
    expect(readFileSync(join(mine, "nodes", "mine", "thesis.txt"), "utf8")).toBe("mine");

    const site = tempDir("exam-out-");
    writeFileSync(join(site, "index.json"), '{"name":"my-site"}');
    expect(() => compileContent(root, site)).toThrow(NOT_ERASED);
    expect(readFileSync(join(site, "index.json"), "utf8")).toBe('{"name":"my-site"}');
  });

  it("refuses a folder with a foreign file beside a real build", () => {
    const root = copyDemo();
    const out = tempDir("exam-out-");
    compileContent(root, out);
    writeFileSync(join(out, "README.md"), "mine");
    expect(() => compileContent(root, out)).toThrow(NOT_ERASED);
    expect(existsSync(join(out, "README.md"))).toBe(true);
    expect(existsSync(join(out, "index.json"))).toBe(true);
  });

  it("builds into an empty, a missing, a previous-build and an interrupted-build folder", () => {
    const root = copyDemo();
    const base = tempDir("exam-out-");

    const empty = join(base, "empty");
    mkdirSync(empty);
    const index = compileContent(root, empty);
    expect(names(empty)).toEqual(["banks", "index.json", "nodes"]);

    const missing = join(base, "deep", "missing");
    expect(compileContent(root, missing).version).toBe(index.version);
    expect(existsSync(join(missing, "index.json"))).toBe(true);

    // Same folder again: the old files go, the new build is whole.
    writeFileSync(join(empty, "banks", "0123456789abcdef.json"), "{}");
    expect(compileContent(root, empty).version).toBe(index.version);
    expect(existsSync(join(empty, "banks", "0123456789abcdef.json"))).toBe(false);

    // index.json is written last, so an interrupted build has only nodes/ and banks/.
    const interrupted = join(base, "interrupted");
    mkdirSync(join(interrupted, "nodes"), { recursive: true });
    mkdirSync(join(interrupted, "banks"));
    writeFileSync(join(interrupted, "banks", "fedcba9876543210.json"), "{}");
    expect(compileContent(root, interrupted).version).toBe(index.version);
    expect(existsSync(join(interrupted, "banks", "fedcba9876543210.json"))).toBe(false);
  });

  it("refuses an out path that is a file and keeps it", () => {
    const root = copyDemo();
    const file = join(tempDir("exam-out-"), "out.json");
    writeFileSync(file, "precious");
    expect(() => compileContent(root, file)).toThrow(/is a file, not a folder/);
    expect(readFileSync(file, "utf8")).toBe("precious");
  });

  it("refuses the content folder, its parent, a folder inside it and a relative path to the parent", () => {
    const root = copyDemo();
    const before = snapshot(root);
    for (const target of [root, join(root, "dist"), join(root, "demo"), dirname(root), join(root, "..", ".")]) {
      expect(() => compileContent(root, target)).toThrow(/overlaps the content folder/);
    }
    expect(snapshot(root)).toEqual(before);
  });

  it("compares real paths: a different spelling of the content folder is still the content folder", () => {
    const root = copyDemo();
    const before = snapshot(root);
    const spelled = join(root, "demo", "..");
    expect(() => compileContent(root, spelled)).toThrow(/overlaps the content folder/);
    if (process.platform === "win32") {
      expect(() => compileContent(root, root.toUpperCase())).toThrow(/overlaps the content folder/);
    }
    expect(snapshot(root)).toEqual(before);
  });

  const junction = (() => {
    const target = tempDir("exam-link-");
    try {
      symlinkSync(target, join(tempDir("exam-link-"), "probe"), "junction");
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  })();

  (junction ? it.skip : it)(`refuses an out path that reaches the content through a junction${junction ? ` (skipped: cannot create junctions here: ${junction})` : ""}`, () => {
    const demo = copyDemo();
    const link = join(tempDir("exam-link-"), "link");
    symlinkSync(demo, link, "junction");
    const before = snapshot(demo);
    expect(() => compileContent(demo, join(link, "demo-out"))).toThrow(/overlaps the content folder/);
    expect(() => compileContent(demo, link)).toThrow(/overlaps the content folder/);
    expect(snapshot(demo)).toEqual(before);
    expect(existsSync(join(demo, "demo-out"))).toBe(false);
  });
});
