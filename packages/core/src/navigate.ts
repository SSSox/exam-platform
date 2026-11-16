import type { BankRef, ContentIndex, NodeManifest, NodeRef } from "./content.ts";

/**
 * Walking the content tree: what a folder shows, where a single-choice chain ends,
 * and whether a remembered place still exists. Pure functions over manifests;
 * the caller supplies how a manifest is loaded.
 */

/** One line of a folder's list: a sub-folder or a bank, in display order. */
export type Entry = { type: "node"; ref: NodeRef } | { type: "bank"; ref: BankRef };

/** Where the app stands: a folder page (empty id is the root list) or a bank page. */
export type Target = { type: "node"; id: string } | { type: "bank"; node: string; id: string };

export type Loader = (ref: NodeRef) => Promise<NodeManifest>;

type Listing = Pick<NodeManifest, "children" | "banks"> & { order?: string[] };

/** Children and banks of a folder as one list, in the order the content gives (children first when it gives none). */
export function entriesOf(listing: Listing): Entry[] {
  const nodes = new Map(listing.children.map((ref) => [ref.id, ref]));
  const banks = new Map(listing.banks.map((ref) => [ref.id, ref]));
  const ordered: Entry[] = [];
  const seen = new Set<string>();
  for (const id of listing.order ?? []) {
    const node = nodes.get(id);
    const bank = banks.get(id);
    if (seen.has(id) || (!node && !bank)) continue;
    seen.add(id);
    ordered.push(node ? { type: "node", ref: node } : { type: "bank", ref: bank! });
  }
  for (const ref of listing.children) if (!seen.has(ref.id)) ordered.push({ type: "node", ref });
  for (const ref of listing.banks) if (!seen.has(ref.id)) ordered.push({ type: "bank", ref });
  return ordered;
}

/** A folder is a choice only when there is more than one thing to pick. */
export const isFork = (listing: Listing) => listing.children.length + listing.banks.length > 1;

/** Entries of the root list, which has no manifest of its own. */
export const rootEntries = (roots: NodeRef[]): Entry[] => roots.map((ref) => ({ type: "node", ref }));

/**
 * Follows folders that hold exactly one entry until there is a real choice.
 * `passed` are the manifests entered on the way, nearest to the start first.
 * A lone bank is the end of the line: the target is that bank.
 */
export async function descend(start: Entry[], from: string, load: Loader): Promise<{ target: Target; passed: NodeManifest[] }> {
  const passed: NodeManifest[] = [];
  let entries = start;
  let at = from;
  while (entries.length === 1) {
    const only = entries[0]!;
    if (only.type === "bank") return { target: { type: "bank", node: at, id: only.ref.id }, passed };
    const manifest = await load(only.ref);
    passed.push(manifest);
    at = manifest.id;
    entries = entriesOf(manifest);
  }
  return { target: { type: "node", id: at }, passed };
}

/**
 * Manifests from the root down along `path` (a folder id, which is the folder path).
 * Stops at the deepest folder that exists, so a remembered path that lost its tail still leads somewhere.
 */
export async function walk(roots: NodeRef[], path: string, load: Loader): Promise<NodeManifest[]> {
  const chain: NodeManifest[] = [];
  let next: NodeRef | undefined = roots.find((r) => path === r.id || path.startsWith(`${r.id}/`));
  while (next) {
    const manifest = await load(next);
    chain.push(manifest);
    if (manifest.id === path) break;
    next = manifest.children.find((c) => path === c.id || path.startsWith(`${c.id}/`));
  }
  return chain;
}

/**
 * The place worth remembering for a chain of folders. Content marks the kind that is a place
 * (a semester); without such a mark it is the first folder that holds banks directly.
 * Folders above it are steps of the ladder, folders below it are subjects, and a chain that
 * reaches neither has no place yet.
 */
export function placeOf(chain: NodeManifest[], kinds: ContentIndex["kinds"] = {}): string | undefined {
  return (chain.find((n) => kinds[n.kind]?.place) ?? chain.find((n) => n.banks.length > 0))?.id;
}

/** The remembered place if it still exists in the content, otherwise nothing. */
export async function restore(roots: NodeRef[], saved: string | undefined, load: Loader): Promise<NodeManifest | undefined> {
  if (!saved) return undefined;
  const chain = await walk(roots, saved, load);
  const last = chain.at(-1);
  return last?.id === saved ? last : undefined;
}
