import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { discoverContent, listBanks, listNodes, validateContent } from "../src/index.ts";
import { DEMO, SEMESTER, cleanTemp, tempDir, writeTree } from "./demo.ts";

afterAll(cleanTemp);

const node = (extra = {}) => ({ kind: "university", title: { en: "N" }, ...extra });
const bank = { id: "x/bank" };

describe("tree discovery on the demo content", () => {
  const { roots, problems } = discoverContent(DEMO);
  const nodes = listNodes(roots);
  const at = (id: string) => nodes.find((n) => n.id === id)!;

  test("finds the whole tree with no problems; ids are folder paths", () => {
    expect(problems).toEqual([]);
    expect(roots.map((r) => r.id)).toEqual(["demo"]);
    expect(nodes.map((n) => n.name)).toEqual([
      "demo", "science", "bachelor", "applied-mathematics", "year-1", "semester-1", "natural-sciences", "earth-sciences", "year-1", "semester-1",
    ]);
    expect(nodes.map((n) => n.id)).toContain("demo/science/bachelor/earth-sciences/year-1/semester-1");
    expect(listBanks(roots).map((b) => b.name).sort()).toEqual(["arithmetic", "astronomy", "chemistry", "geography", "physics"]);
  });

  test("a fork keeps both branches, in `order` of the node, then by name", () => {
    expect(at("demo/science/bachelor").children.map((c) => c.name)).toEqual(["applied-mathematics", "earth-sciences"]);
  });

  test("`items` sets the display order, and a folder left out follows the listed ones", () => {
    const semester = at(SEMESTER);
    expect(semester.node.items).toEqual(["geography", "natural-sciences"]);
    expect(semester.order).toEqual(["geography", "natural-sciences", "arithmetic"]);
    expect(semester.children.map((c) => c.name)).toEqual(["natural-sciences"]);
    expect(semester.banks.map((b) => b.name)).toEqual(["geography", "arithmetic"]);
  });

  test("a bank sits next to child nodes inside the same node, and a group node holds its own banks", () => {
    const group = at(`${SEMESTER}/natural-sciences`);
    expect(group.node.kind).toBe("subject");
    expect(group.order).toEqual(["physics", "chemistry"]);
    expect(at(SEMESTER).banks.length).toBeGreaterThan(0);
    expect(at(SEMESTER).children.length).toBeGreaterThan(0);
  });

  test("translation sidecars are not mistaken for banks", () => {
    expect(listBanks(roots).filter((b) => b.dir.includes("translations"))).toEqual([]);
  });
});

describe("order without `items`", () => {
  test("nodes by `order` then name come first, banks by name follow; unknown and repeated names in `items` are skipped", () => {
    const root = writeTree(tempDir(), {
      "u/node.json": node(),
      "u/zeta/node.json": node({ order: 1 }),
      "u/alpha/node.json": node({ order: 2 }),
      "u/beta/node.json": node({ order: 2 }),
      "u/m-bank/bank.json": bank,
      "u/a-bank/bank.json": bank,
      "u/zeta/b/bank.json": bank,
      "u/alpha/b/bank.json": bank,
      "u/beta/b/bank.json": bank,
    });
    expect(discoverContent(root).roots[0]!.order).toEqual(["zeta", "alpha", "beta", "a-bank", "m-bank"]);

    writeTree(root, { "u/node.json": node({ items: ["m-bank", "ghost", "m-bank", "alpha"] }) });
    expect(discoverContent(root).roots[0]!.order).toEqual(["m-bank", "alpha", "zeta", "beta", "a-bank"]);
  });

  test("top-level nodes are sorted by `order`, then name", () => {
    const root = writeTree(tempDir(), {
      "b/node.json": node({ order: 1 }), "b/x/bank.json": bank,
      "a/node.json": node({ order: 2 }), "a/x/bank.json": bank,
      "c/node.json": node({ order: 1 }), "c/x/bank.json": bank,
    });
    expect(discoverContent(root).roots.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});

describe("layout problems", () => {
  const base = { "u/node.json": node(), "u/ok/bank.json": bank };
  const problemsOf = (files: Record<string, unknown>) => discoverContent(writeTree(tempDir(), { ...base, ...files })).problems.join("\n");

  test("a clean layout has none, and service folders are skipped", () => {
    expect(problemsOf({
      "schema/node.schema.json": {}, "source/v1.json": {}, ".git/config.json": {}, "u/node_modules/x.json": {},
      "u/assets/run.mjs": "x", "u/assets/.cache/a.json": {}, "u/assets/node_modules/p/package.json": {},
      "u/ok/translations/ru/bank.json": {}, "u/ok/questions/t01.json": {},
    })).toBe("");
  });

  test.each<[string, Record<string, unknown>, RegExp]>([
    ["a bank in the content root", { "bank.json": bank }, /^bank\.json: a bank must live inside a node/m],
    ["a bank folder right under the content root", { "lonely/bank.json": bank }, /^lonely: a bank must live inside a node/m],
    ["a folder with both node.json and bank.json", { "u/both/node.json": node(), "u/both/bank.json": bank }, /u\/both: folder has both/],
    ["a folder with JSON but no node.json or bank.json", { "u/stray/data.json": {} }, /u\/stray: folder has neither/],
    ["a middle folder without node.json that holds nodes", { "u/gap/inner/node.json": node(), "u/gap/inner/b/bank.json": bank }, /u\/gap: folder has neither/],
    ["JSON nested two levels deep in a folder without markers", { "u/stray/inner/x.json": {} }, /u\/stray: folder has neither/],
    ["a marker file with an upper-case extension", { "u/Loud/node.JSON": node() }, /u\/Loud: folder has neither/],
    ["a node title with no language", { "u/t/node.json": node({ title: {} }), "u/t/b/bank.json": bank }, /u\/t\/node\.json: title/],
    ["a node title that is only blank", { "u/t/node.json": node({ title: { en: "  " } }), "u/t/b/bank.json": bank }, /u\/t\/node\.json: title/],
    ["a node.json spelled in another case", { "u/Cased/Node.json": node(), "u/Cased/b/bank.json": bank }, /u\/Cased: folder has neither/],
    ["a node folder with a space and a non-latin letter", { "u/Мой вуз/node.json": node(), "u/Мой вуз/b/bank.json": bank }, /u\/Мой вуз: folder name "Мой вуз" must use only latin/],
    ["a bank folder with an ampersand", { "u/a&b/bank.json": bank }, /u\/a&b: folder name "a&b" must use only latin/],
    ["a node with no children and no banks", { "u/empty/node.json": node() }, /u\/empty: node has no child nodes and no banks/],
    ["a node.json that is not JSON", { "u/broken/node.json": "{ nope" }, /u\/broken\/node\.json: /],
    ["a node.json with the removed `banks` field", { "u/old/node.json": node({ banks: ["x/bank"] }) }, /u\/old\/node\.json: .*banks/],
    ["a node.json in the content root", { "node.json": node() }, /content root is not a node/],
    ["sidecars left in a translations folder at the content root", { "translations/u/ok/ru/bank.json": {} }, /^translations: "translations" holds JSON outside a bank folder/m],
    ["sidecars in a translations folder of a node", { "u/translations/ru/bank.json": {} }, /u\/translations: "translations" holds JSON outside a bank folder/],
    ["a node folder named like a service folder", { "u/questions/node.json": node(), "u/questions/b/bank.json": bank }, /u\/questions: "questions" holds JSON outside a bank folder/],
    ["a node inside a bank folder", { "u/ok/inner/node.json": node(), "u/ok/inner/b/bank.json": bank }, /u\/ok: a bank folder cannot contain nodes or banks/],
    ["a bank inside a bank folder", { "u/ok/inner/bank.json": bank }, /u\/ok: a bank folder cannot contain nodes or banks/],
  ])("reports %s", (_name, files, message) => {
    expect(problemsOf(files)).toMatch(message);
  });

  test("an unreadable child node is reported once, without an extra \"empty node\" error", () => {
    const text = discoverContent(writeTree(tempDir(), { "u/node.json": node(), "u/broken/node.json": "{ nope" })).problems.join(String.fromCharCode(10));
    expect(text).toMatch(/u\/broken\/node\.json/);
    expect(text).not.toMatch(/no child nodes/);
  });

  test("a content root that does not exist is reported, not thrown", () => {
    const missing = join(tempDir(), "nope");
    expect(discoverContent(missing)).toEqual({ roots: [], problems: [expect.stringMatching(/content root is not a folder/)] });
    expect(validateContent(missing).errors.join("\n")).toMatch(/content root is not a folder/);
  });

  test("a folder without any JSON (notes, images) is not a problem", () => {
    expect(problemsOf({ "u/notes/readme.md": "# notes" })).toBe("");
  });
});
