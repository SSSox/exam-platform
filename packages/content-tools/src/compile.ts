import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HASH_LENGTH, answerModes, type BankBundle, type BankRef, type ContentIndex, type NodeManifest, type NodeRef } from "@exam/core";
import { Catalog, FORMAT } from "@exam/schema";
import { discoverContent, type DiscoveredNode } from "./discover.ts";
import { loadBank, validateContent } from "./validate.ts";

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);

function localesOf(value: unknown, language: string, into: Set<string>) {
  if (typeof value === "string") into.add(language);
  else if (value && typeof value === "object") for (const locale of Object.keys(value)) into.add(locale);
}

/** Real path of an existing folder or file; a not-yet-existing tail is appended to the real path of the nearest existing parent. */
function realPathOf(path: string): string {
  let existing = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...tail.reverse());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // A link whose target is gone also reports ENOENT; writing through it would land somewhere unknown.
    if (lstatOrNull(existing)) throw new Error(`"${existing}" is a broken link`);
    const parent = dirname(existing);
    if (parent === existing) throw new Error(`no existing folder above "${path}"`);
    tail.push(existing.slice(parent.length).replace(/^[\/]+/, ""));
    existing = parent;
  }
}

const lstatOrNull = (path: string) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

/** Windows paths ignore case; elsewhere they do not. */
const same = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

/** True when neither real path is the other or inside the other. */
function apart(a: string, b: string): boolean {
  const outside = (from: string, to: string) => {
    const path = relative(same(from), same(to));
    return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
  };
  return outside(a, b) && outside(b, a);
}

/** What a build leaves in its folder: `index.json` goes last, so an interrupted build has only the other two. */
const BUILD_ENTRIES = new Set(["nodes", "banks", "index.json"]);
const HASHED_FILE = new RegExp(`^[0-9a-f]{${HASH_LENGTH}}\\.json$`);

/** The entries to erase from `out`, or an error when it holds anything that is not a build. Touches nothing. */
function staleBuild(out: string): string[] {
  const info = lstatOrNull(out);
  if (!info) return [];
  if (!info.isDirectory()) throw new Error(`out path "${out}" is a file, not a folder; choose another one`);
  const entries = readdirSync(out);
  // The names alone are too common ("nodes", "index.json"): a build's folders hold nothing but hashed files, and its index lists roots.
  const foreign = entries.filter((name) => {
    if (!BUILD_ENTRIES.has(name)) return true;
    const path = join(out, name);
    const entry = lstatOrNull(path)!;
    if (name !== "index.json") return !entry.isDirectory() || readdirSync(path, { withFileTypes: true }).some((file) => !file.isFile() || !HASHED_FILE.test(file.name));
    if (!entry.isFile()) return true;
    try {
      return !Array.isArray(JSON.parse(readFileSync(path, "utf8")).roots);
    } catch {
      return true;
    }
  });
  if (foreign.length) {
    throw new Error(`out folder "${out}" is not empty and does not look like a previous build (found ${foreign.slice(0, 3).map((n) => `"${n}"`).join(", ")}); clear it by hand or choose another folder`);
  }
  return entries;
}

/**
 * Build the static "dist" the apps download. File names are content hashes, so a file never
 * changes once published and an unchanged bank keeps its URL across builds.
 */
export function compileContent(root: string, out: string): ContentIndex {
  const { errors } = validateContent(root);
  if (errors.length) throw new Error(`content is invalid:\n${errors.join("\n")}`);

  // Old files in `out` are erased, so it must be neither the content tree, nor inside it, nor one of its parents.
  // Compared by real path: `..`, links and junctions cannot hide the overlap. Nothing is erased before the checks pass.
  const realOut = realPathOf(out);
  if (!apart(realPathOf(root), realOut)) throw new Error(`out folder "${out}" overlaps the content folder "${root}"`);
  staleBuild(realOut);

  // The whole build is made in memory first, so the content is read before anything in `out` is touched.
  const files = new Map<string, string>();
  const emit = (folder: string, data: unknown): string => {
    const text = JSON.stringify(data);
    const hash = hashOf(text);
    files.set(join(folder, `${hash}.json`), text);
    return hash;
  };

  const bankRef = (dir: string): BankRef => {
    const { bank, questions } = loadBank(dir)!;
    const bundle: BankBundle = { bank, questions };
    const locales = new Set<string>();
    for (const q of questions) localesOf(q.question, bank.language, locales);
    const retired = questions.filter((q) => q.retired).map((q) => q.id).sort((a, b) => a - b);
    return {
      id: bank.id, subject: bank.subject, language: bank.language, locales: [...locales].sort(),
      questions: questions.length - retired.length,
      typed: questions.filter((q) => !q.retired && answerModes(q).includes("typed")).length,
      // Only when there are some, so a bank without withdrawn questions compiles to the same bytes as before.
      ...(retired.length ? { retired } : {}),
      hash: emit("banks", bundle),
    };
  };

  const node = (found: DiscoveredNode): NodeRef => {
    const children = found.children.map(node);
    const banks = found.banks.map((b) => bankRef(b.dir));
    // Folder names are only the way content is laid out; clients see ids.
    const ids = new Map<string, string>([...found.children.map((c, i) => [c.name, children[i]!.id] as const), ...found.banks.map((b, i) => [b.name, banks[i]!.id] as const)]);
    const manifest: NodeManifest = { id: found.id, kind: found.node.kind, title: found.node.title, children, banks, order: found.order.map((name) => ids.get(name)!) };
    return {
      id: found.id, kind: found.node.kind, title: found.node.title, hash: emit("nodes", manifest),
      banks: banks.length + children.reduce((n, c) => n + c.banks, 0),
    };
  };

  const roots = discoverContent(root).roots.map(node);
  const catalog = Catalog.parse(JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")));
  const body = { format: FORMAT, kinds: catalog.kinds, roots };
  const index: ContentIndex = { ...body, version: hashOf(JSON.stringify(body)) };

  for (const name of staleBuild(realOut)) rmSync(join(realOut, name), { recursive: true, force: true });
  mkdirSync(realOut, { recursive: true });
  for (const [path, text] of files) {
    mkdirSync(join(realOut, dirname(path)), { recursive: true });
    writeFileSync(join(realOut, path), text, "utf8");
  }
  writeFileSync(join(realOut, "index.json"), JSON.stringify(index), "utf8");
  return index;
}
