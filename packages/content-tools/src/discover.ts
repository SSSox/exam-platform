import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Node } from "@exam/schema";

/** A folder with `bank.json`: a bank of questions that belongs to the node whose folder holds it. */
export interface DiscoveredBank {
  dir: string;
  /** Folder name. */
  name: string;
}

/** A folder with `node.json`. */
export interface DiscoveredNode {
  /** Folder path from the content root, joined with "/". */
  id: string;
  dir: string;
  /** Folder name. */
  name: string;
  node: Node;
  /** Child nodes in display order. */
  children: DiscoveredNode[];
  /** Banks in display order. */
  banks: DiscoveredBank[];
  /** Folder names of child nodes and banks together, in display order. */
  order: string[];
}

export interface Discovery {
  /** Top-level nodes (universities) in display order. */
  roots: DiscoveredNode[];
  /** Structure errors: misplaced banks, folders nobody can read, empty nodes, unreadable `node.json`. */
  problems: string[];
}

/** Folders that are never part of the tree. `schema` and `source` are service folders of the content root only. */
const ROOT_ONLY = new Set(["schema", "source"]);
const ANYWHERE = new Set(["translations", "questions", "node_modules"]);

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const byCode =(a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isService = (name: string, atRoot: boolean) => name.startsWith(".") || ANYWHERE.has(name) || (atRoot && ROOT_ONLY.has(name));

type Kind = "node" | "bank" | "none";

/**
 * Walk a content repository: every folder with `node.json` is a node, every folder with `bank.json`
 * is a bank of its parent node. Display order inside a node: names listed in `items` first,
 * then the rest (nodes by `order` and name, banks by name). Never throws on a malformed layout:
 * what cannot be read is reported in `problems`.
 */
export function discoverContent(root: string): Discovery {
  const problems: string[] = [];
  const rel = (dir: string) => relative(root, dir).replaceAll("\\", "/") || ".";
  /** Exact-case file check: `existsSync` ignores case on Windows, where `Node.json` would pass and fail elsewhere. */
  const has = (dir: string, file: string) => existsSync(join(dir, file)) && readdirSync(dir).includes(file);
  /** Folder names become node ids and page addresses, so they stay URL-safe. */
  const checkName = (dir: string, name: string) => {
    if (!SAFE_NAME.test(name)) problems.push(`${rel(dir)}: folder name "${name}" must use only latin letters, digits, "-", "_" and "."`);
  };
  const subdirs = (dir: string, atRoot: boolean) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isService(e.name, atRoot))
      .map((e) => e.name)
      .sort(byCode);

  /** True if a node or bank sits anywhere inside `dir`. */
  const holdsContent = (dir: string): boolean => has(dir, "node.json") || has(dir, "bank.json") || subdirs(dir, false).some((n) => holdsContent(join(dir, n)));

  /** True if a `.json` file (any letter case) lies anywhere inside `dir`, service folders (`.git`, `node_modules`) aside. */
  const hasJson = (dir: string): boolean =>
    readdirSync(dir, { withFileTypes: true }).some((e) =>
      e.isDirectory() ? !isService(e.name, false) && hasJson(join(dir, e.name)) : e.name.toLowerCase().endsWith(".json"));

  /** `translations` and `questions` belong inside a bank folder; elsewhere their JSON would be skipped without a word. */
  const checkReserved = (dir: string) => {
    for (const name of ["translations", "questions"]) {
      const path = join(dir, name);
      if (existsSync(path) && statSync(path).isDirectory() && hasJson(path)) {
        problems.push(`${rel(path)}: "${name}" holds JSON outside a bank folder (a bank needs a bank.json) and would be ignored`);
      }
    }
  };

  const classify = (dir: string): Kind => {
    const node = has(dir, "node.json");
    const bank = has(dir, "bank.json");
    if (node && bank) {
      problems.push(`${rel(dir)}: folder has both node.json and bank.json; a folder is either a node or a bank`);
      return "none";
    }
    if (node) return "node";
    if (bank) return "bank";
    if (hasJson(dir) || subdirs(dir, false).some((n) => holdsContent(join(dir, n)))) {
      problems.push(`${rel(dir)}: folder has neither node.json nor bank.json, so its content would be ignored`);
    }
    return "none";
  };

  const readNode = (dir: string): Node | undefined => {
    const path = join(dir, "node.json");
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      problems.push(`${rel(path)}: ${(e as Error).message}`);
      return undefined;
    }
    const result = Node.safeParse(data);
    if (result.success) return result.data;
    for (const issue of result.error.issues) problems.push(`${rel(path)}: ${issue.path.join(".")}: ${issue.message}`);
    return undefined;
  };

  const visit = (dir: string, name: string, id: string): DiscoveredNode | undefined => {
    const node = readNode(dir);
    if (!node) return undefined;

    checkReserved(dir);
    const children = new Map<string, DiscoveredNode>();
    const banks = new Map<string, DiscoveredBank>();
    let unreadable = 0;
    for (const child of subdirs(dir, false)) {
      const path = join(dir, child);
      const kind = classify(path);
      if (kind !== "none") checkName(path, child);
      if (kind === "bank") {
        banks.set(child, { dir: path, name: child });
        if (subdirs(path, false).some((n) => holdsContent(join(path, n)))) problems.push(`${rel(path)}: a bank folder cannot contain nodes or banks`);
      } else if (kind === "node") {
        const found = visit(path, child, `${id}/${child}`);
        if (found) children.set(child, found);
        else unreadable++;
      }
    }

    const listed = [...new Set(node.items ?? [])].filter((n) => children.has(n) || banks.has(n));
    const rest = (names: string[]) => names.filter((n) => !listed.includes(n));
    const nodesLeft = rest([...children.keys()]).sort((a, b) => (children.get(a)!.node.order ?? 0) - (children.get(b)!.node.order ?? 0) || byCode(a, b));
    const banksLeft = rest([...banks.keys()]).sort(byCode);
    const order = [...listed, ...nodesLeft, ...banksLeft];

    // A child whose node.json could not be read is already reported; do not add "empty" on top.
    if (order.length === 0 && unreadable === 0) problems.push(`${rel(dir)}: node has no child nodes and no banks`);
    return {
      id, dir, name, node,
      children: order.filter((n) => children.has(n)).map((n) => children.get(n)!),
      banks: order.filter((n) => banks.has(n)).map((n) => banks.get(n)!),
      order,
    };
  };

  if (!existsSync(root) || !statSync(root).isDirectory()) return { roots: [], problems: [`${root}: content root is not a folder`] };
  if (has(root, "bank.json")) problems.push("bank.json: a bank must live inside a node folder, not in the content root");
  if (has(root, "node.json")) problems.push("node.json: the content root is not a node; point at the folder that holds catalog.json");

  checkReserved(root);
  const roots: DiscoveredNode[] = [];
  for (const name of subdirs(root, true)) {
    const dir = join(root, name);
    const kind = classify(dir);
    if (kind === "node") checkName(dir, name);
    if (kind === "bank") problems.push(`${name}: a bank must live inside a node folder, not in the content root`);
    else if (kind === "node") {
      const found = visit(dir, name, name);
      if (found) roots.push(found);
    }
  }
  roots.sort((a, b) => (a.node.order ?? 0) - (b.node.order ?? 0) || byCode(a.name, b.name));
  return { roots, problems };
}

/** Every node of the forest, parents before children. */
export function listNodes(roots: DiscoveredNode[]): DiscoveredNode[] {
  return roots.flatMap((n) => [n, ...listNodes(n.children)]);
}

/** Every bank of the forest with the node that holds it. */
export function listBanks(roots: DiscoveredNode[]): (DiscoveredBank & { parent: DiscoveredNode })[] {
  return listNodes(roots).flatMap((parent) => parent.banks.map((b) => ({ ...b, parent })));
}
