import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { ContentClient, type Http, type KeyValue, type NodeManifest } from "@exam/core";
import { compileContent } from "../src/index.ts";
import { DEMO, SEMESTER, cleanTemp, copyDemo, readJson, tempDir } from "./demo.ts";

afterAll(cleanTemp);

const memory = (): KeyValue => {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) };
};

/** Serves a compiled folder under a fake origin; can be switched off or made to lie. */
function mirror(origin: string, dir: string, state = { up: true, corrupt: false }) {
  const http: Http = {
    async get(url) {
      if (!url.startsWith(origin) || !state.up) throw new Error("unreachable");
      const text = readFileSync(join(dir, url.slice(origin.length)), "utf8");
      return state.corrupt && !url.endsWith("index.json") ? text + " " : text;
    },
  };
  return { http, state };
}

const files = (dir: string, folder: string) => readdirSync(join(dir, folder)).sort();

describe("compiled content", () => {
  const out = tempDir("exam-dist-");
  const index = compileContent(DEMO, out);

  test("the tree is found from data alone and the index stays small", async () => {
    expect(index.roots.map((r) => [r.id, r.kind, r.banks])).toEqual([["demo", "university", 5]]);
    expect(readFileSync(join(out, "index.json"), "utf8").length).toBeLessThan(2000);

    const client = new ContentClient(["https://a.test/"], mirror("https://a.test/", out).http, memory());
    const university = await client.node(index.roots[0]!.hash);
    const faculty = await client.node(university.children[0]!.hash);
    const degree = await client.node(faculty.children[0]!.hash);
    expect(degree.children.map((c) => [c.id.split("/").pop(), c.banks])).toEqual([["applied-mathematics", 4], ["earth-sciences", 1]]);

    const year = await client.node((await client.node(degree.children[0]!.hash)).children[0]!.hash);
    const semester = await client.node(year.children[0]!.hash);
    expect(semester.id).toBe(SEMESTER);
    expect(semester.banks.map((b) => [b.id, b.questions])).toEqual([["demo/geography", 8], ["demo/arithmetic", 7]]);
    expect(semester.banks.map((b) => b.locales)).toEqual([["en", "ru"], ["en"]]);
    // Choice questions with `free_input` (5) and the numeric one count as typeable.
    expect(semester.banks[0]!.typed).toBe(6);

    const { bank, questions } = await client.bank(semester.banks[0]!.hash);
    expect(bank.id).toBe("demo/geography");
    expect(questions).toHaveLength(8);
  });

  test("`order` lists nodes and banks together in display order; `children` and `banks` follow it", () => {
    const manifest = (hash: string) => readJson(join(out, "nodes", `${hash}.json`)) as NodeManifest;
    const find = (id: string): NodeManifest => {
      let ref = index.roots[0]!;
      let current = manifest(ref.hash);
      while (current.id !== id) {
        ref = current.children.find((c) => id === c.id || id.startsWith(`${c.id}/`))!;
        current = manifest(ref.hash);
      }
      return current;
    };
    const semester = find(SEMESTER);
    expect(semester.order).toEqual(["demo/geography", `${SEMESTER}/natural-sciences`, "demo/arithmetic"]);
    expect(semester.children.map((c) => c.id)).toEqual([`${SEMESTER}/natural-sciences`]);
    expect(semester.banks.map((b) => b.id)).toEqual(["demo/geography", "demo/arithmetic"]);
    expect(find(`${SEMESTER}/natural-sciences`).order).toEqual(["demo/physics", "demo/chemistry"]);
    expect(find("demo/science/bachelor").order).toEqual(["demo/science/bachelor/applied-mathematics", "demo/science/bachelor/earth-sciences"]);
  });

  test("a node's bank count covers its whole subtree", () => {
    const find = (hash: string): NodeManifest => readJson(join(out, "nodes", `${hash}.json`));
    const university = find(index.roots[0]!.hash);
    expect(university.children[0]!.banks).toBe(5);
  });

  test("building twice gives the same version, so unchanged content keeps its URLs", () => {
    const again = tempDir("exam-dist-");
    expect(compileContent(DEMO, again).version).toBe(index.version);
    expect(files(again, "banks")).toEqual(files(out, "banks"));
    expect(files(again, "nodes")).toEqual(files(out, "nodes"));
  });

  test("changing one bank renames only that bank's file", () => {
    const edited = copyDemo();
    const path = join(edited, SEMESTER, "arithmetic/questions/t01.json");
    const file = readJson(path);
    file.questions[0].question = "Which fraction equals 0.75 exactly?";
    writeFileSync(path, JSON.stringify(file, null, 2));
    const dist = tempDir("exam-dist-");
    const changed = compileContent(edited, dist);
    expect(changed.version).not.toBe(index.version);
    const before = files(out, "banks");
    const after = files(dist, "banks");
    expect(after.filter((f) => !before.includes(f))).toHaveLength(1);
    expect(before.filter((f) => !after.includes(f))).toHaveLength(1);
  });

  test("withdrawn questions leave the count and are listed by id; a bank without any has no such field", () => {
    const semesterOf = (dist: string) =>
      files(dist, "nodes").map((f) => readJson(join(dist, "nodes", f)) as NodeManifest).find((m) => m.id === SEMESTER)!;
    const arithmetic = (dist: string) => semesterOf(dist).banks.find((b) => b.id === "demo/arithmetic")!;
    expect(arithmetic(out)).not.toHaveProperty("retired");

    const edited = copyDemo();
    const path = join(edited, SEMESTER, "arithmetic/questions/t01.json");
    const file = readJson(path);
    const [first, second] = file.questions as { id: number; retired?: boolean }[];
    // Marked out of order, so the list proves it is sorted by id.
    second!.retired = true;
    first!.retired = true;
    writeFileSync(path, JSON.stringify(file, null, 2));
    const dist = tempDir("exam-dist-");
    compileContent(edited, dist);

    const bank = arithmetic(dist);
    expect(bank.retired).toEqual([first!.id, second!.id].sort((a, b) => a - b));
    expect(bank.questions).toBe(arithmetic(out).questions - 2);
    expect(semesterOf(dist).banks.find((b) => b.id === "demo/geography")).not.toHaveProperty("retired");
  });

  test("reordering `items` changes the node manifest and the version but no bank file", () => {
    const edited = copyDemo();
    const path = join(edited, SEMESTER, "node.json");
    writeFileSync(path, JSON.stringify({ ...readJson(path), items: ["arithmetic", "natural-sciences", "geography"] }));
    const dist = tempDir("exam-dist-");
    const changed = compileContent(edited, dist);
    expect(changed.version).not.toBe(index.version);
    expect(files(dist, "banks")).toEqual(files(out, "banks"));
    const order = files(dist, "nodes")
      .map((f) => readJson(join(dist, "nodes", f)) as NodeManifest)
      .find((m) => m.id === SEMESTER)!.order;
    expect(order).toEqual(["demo/arithmetic", `${SEMESTER}/natural-sciences`, "demo/geography"]);
  });

  test("refuses an out folder that is, contains or sits inside the content folder, and leaves the content alone", () => {
    const root = copyDemo();
    for (const target of [root, join(root, "dist"), join(root, "demo"), join(root, "..")]) {
      expect(() => compileContent(root, target)).toThrow(/overlaps the content folder/);
    }
    expect(readdirSync(root).sort()).toEqual(["catalog.json", "demo"]);
    expect(compileContent(root, tempDir("exam-dist-")).version).toBe(index.version);
  });

  test("refuses content that does not validate", () => {
    const broken = copyDemo();
    writeFileSync(join(broken, SEMESTER, "node.json"), JSON.stringify({ kind: "semester", title: { en: "S" }, items: ["ghost"] }));
    expect(() => compileContent(broken, tempDir("exam-dist-"))).toThrow(/not a child folder/);
  });

  test("falls back to the next mirror, rejects tampered files, then works offline from cache", async () => {
    const a = mirror("https://a.test/", out), b = mirror("https://b.test/", out);
    const http: Http = { get: (url) => (url.startsWith("https://a.test/") ? a.http.get(url) : b.http.get(url)) };
    const cache = memory();
    const client = new ContentClient(["https://a.test/", "https://b.test/"], http, cache);

    a.state.up = false;
    expect((await client.index()).offline).toBe(false);

    a.state.up = true;
    a.state.corrupt = true;
    const hash = index.roots[0]!.hash;
    expect((await client.node(hash)).id).toBe("demo");

    a.state.up = b.state.up = false;
    expect(await client.index()).toMatchObject({ offline: true, index: { version: index.version } });
    expect((await client.node(hash)).id).toBe("demo");
    await expect(new ContentClient(["https://a.test/"], http, memory()).index()).rejects.toThrow(/unavailable/);

    b.state.up = true;
    b.state.corrupt = true;
    const child = (await client.node(hash)).children[0]!.hash;
    await expect(client.node(child)).rejects.toThrow(/cannot load/);
  });
});
