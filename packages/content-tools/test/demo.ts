import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The demo content repository shipped with the code; tests read it but never write into it. */
export const DEMO = join(import.meta.dirname, "../../../examples/demo-content");
/** Folder of the first semester of the demo tree: two banks plus the `natural-sciences` group. */
export const SEMESTER = "demo/science/bachelor/applied-mathematics/year-1/semester-1";
export const FIXTURES = join(import.meta.dirname, "fixtures");

const made: string[] = [];

export function tempDir(prefix = "exam-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Remove every folder `tempDir` handed out; call from `afterAll`. */
export function cleanTemp() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A writable copy of the demo content. */
export function copyDemo(): string {
  const dir = tempDir("exam-demo-");
  cpSync(DEMO, dir, { recursive: true });
  return dir;
}

/** Write files (path -> JSON value, or a raw string) under `root`. */
export function writeTree(root: string, files: Record<string, unknown>): string {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
  }
  return root;
}

export const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
