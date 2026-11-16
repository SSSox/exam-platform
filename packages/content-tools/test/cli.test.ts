import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { DEMO, FIXTURES, cleanTemp, copyDemo, readJson, tempDir, writeTree } from "./demo.ts";

afterAll(cleanTemp);

const CLI = join(import.meta.dirname, "../src/cli.ts");
const V1 = join(FIXTURES, "v1-sample.json");

function run(...args: string[]) {
  return runIn(undefined, ...args);
}

function runIn(cwd: string | undefined, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** A content root with one node, ready to receive a migrated bank at `uni/sample`. */
function emptyRepo() {
  return writeTree(tempDir("exam-cli-"), {
    "catalog.json": { format: "exambank/2", kinds: { university: { title: { en: "University" } } } },
    "uni/node.json": { kind: "university", title: { en: "University" } },
  });
}

describe("migrate -> validate -> verify on a small 1.0 file", () => {
  const root = emptyRepo();
  const bankDir = join(root, "uni/sample");

  test("migrate writes bank.json and questions/ into the given bank folder", () => {
    const r = run("migrate", V1, "uni/sample", bankDir);
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toBe("uni/sample: 2 files, 5 questions");
    expect(readJson(join(bankDir, "bank.json")).id).toBe("uni/sample");
    expect(existsSync(join(bankDir, "questions/t01.json"))).toBe(true);
    expect(existsSync(join(bankDir, "questions/t02.json"))).toBe(true);
  });

  test("the migrated bank sits in the tree and validates", () => {
    expect(run("validate", root)).toMatchObject({ code: 0, out: "OK: 1 banks, 5 questions" });
  });

  test("verify proves the bank restores the original file", () => {
    const r = run("verify", V1, bankDir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/identical to the original \(5 questions/);
  });

  test("verify reports a mismatch after any edit", () => {
    const path = join(bankDir, "questions/t01.json");
    const file = readJson(path);
    file.questions[0].question = "Which colour do blue and yellow make?";
    writeFileSync(path, JSON.stringify(file, null, 2));
    const r = run("verify", V1, bankDir);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/MISMATCH in .*: questions/);
  });
});

describe("other commands", () => {
  test("validate prints the counts, or the errors and a non-zero exit", () => {
    expect(run("validate", DEMO).out).toMatch(/^OK: 5 banks, \d+ questions$/);
    const root = writeTree(tempDir("exam-cli-"), { "catalog.json": { format: "exambank/2", kinds: {} }, "bank.json": { id: "x" } });
    const r = run("validate", root);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/a bank must live inside a node folder/);
    expect(r.err).toMatch(/\d+ error\(s\)$/);
  });

  test("compile into the current folder erases nothing when it holds other files", () => {
    const repo = writeTree(tempDir("exam-cli-"), { "package.json": "{}", "src/code.ts": "// mine" });
    const bad = runIn(repo, "compile", DEMO, ".");
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/not empty and does not look like a previous build/);
    expect(existsSync(join(repo, "src", "code.ts"))).toBe(true);
    expect(existsSync(join(repo, "package.json"))).toBe(true);
  });

  test("merge-translations on content that is already merged changes no file", () => {
    expect(run("merge-translations", copyDemo())).toMatchObject({ code: 0, out: "merged 4 sidecar(s), 0 file(s) changed, 0 warning(s)" });
  });

  test("compile builds the hashed folder; an invalid tree stops it", () => {
    const out = tempDir("exam-cli-");
    const ok = run("compile", DEMO, out);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^compiled version [0-9a-f]{16}: 5 bank links$/);
    expect(JSON.parse(readFileSync(join(out, "index.json"), "utf8")).roots[0].id).toBe("demo");

    const bad = run("compile", writeTree(tempDir("exam-cli-"), { "catalog.json": { format: "exambank/2", kinds: {} }, "lonely/bank.json": {} }), out);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/content is invalid/);
  });

  test("schema writes the node schema with `items` and without the removed `banks`", () => {
    const out = tempDir("exam-cli-");
    expect(run("schema", out).code).toBe(0);
    const node = readJson(join(out, "node.schema.json"));
    expect(Object.keys(node.properties)).toEqual(expect.arrayContaining(["kind", "title", "order", "items"]));
    expect(node.properties).not.toHaveProperty("banks");
  });

  test("missing arguments and unknown commands print usage and exit 1", () => {
    expect(run("migrate")).toMatchObject({ code: 1 });
    expect(run("migrate").err).toMatch(/usage: migrate <v1\.json> <bank-id> <bank-dir>/);
    const unknown = run("frobnicate");
    expect(unknown.code).toBe(1);
    expect(unknown.err).toMatch(/migrate <v1\.json> <bank-id> <bank-dir>/);
  });
});
