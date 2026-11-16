// Puts the content the app ships with into public/content (see apps/ui/src/platform.ts for the mirror list).
//
// Source, first match wins:
//   1. EXAM_CONTENT_DIR, if set. The value "none" ships no content: the app loads banks over the network.
//      A relative path is taken from the folder where npm was started (INIT_CWD), so prefer an absolute one.
//   2. the `exam-content` repository next to the code repository, if it exists.
//   3. examples/demo-content in this repository.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dirname; // apps/ui/scripts
const ui = resolve(here, "..");
const repo = resolve(ui, "../..");
const out = join(ui, "public", "content");
const cli = join(repo, "packages", "content-tools", "src", "cli.ts");

const fromEnv = process.env.EXAM_CONTENT_DIR?.trim();
const startedIn = process.env.INIT_CWD || process.cwd();
const sibling = resolve(repo, "..", "exam-content");

if (fromEnv?.toLowerCase() === "none") {
  rmSync(out, { recursive: true, force: true });
  console.log("content: EXAM_CONTENT_DIR=none, nothing embedded (public/content removed); the app loads banks over the network");
  process.exit(0);
}

let source;
let why;
if (fromEnv) {
  source = resolve(startedIn, fromEnv);
  why = "EXAM_CONTENT_DIR";
} else if (existsSync(join(sibling, "catalog.json"))) {
  source = sibling;
  why = "exam-content repository next to this one";
} else {
  source = join(repo, "examples", "demo-content");
  why = "demo content (no exam-content repository found)";
}

if (!existsSync(join(source, "catalog.json"))) {
  console.error(`content: ${source} has no catalog.json (source: ${why})`);
  process.exit(1);
}

console.log(`content: ${source} (${why})`);
const result = spawnSync(process.execPath, [cli, "compile", source, out], { stdio: "inherit" });
process.exit(result.status ?? 1);
