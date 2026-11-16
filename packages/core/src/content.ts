import type { Bank, Localized, Question } from "@exam/schema";

/** Compiled content ("dist"): a small root index, lazily loaded node manifests, one file per bank. */
export interface NodeRef { id: string; kind: string; title: Localized; hash: string; banks: number }
/** `retired` lists the ids of withdrawn questions (ascending), so the catalog can leave them out of what a learner has mastered without loading the bank; absent when none. */
export interface BankRef { id: string; subject: Localized; language: string; locales: string[]; questions: number; typed: number; retired?: number[]; hash: string }
export interface ContentIndex { format: string; version: string; kinds: Record<string, { title: Localized; place?: boolean }>; roots: NodeRef[] }
/** `children` and `banks` are each in display order; `order` lists the ids of both together (child nodes and banks) in display order. */
export interface NodeManifest { id: string; kind: string; title: Localized; children: NodeRef[]; banks: BankRef[]; order: string[] }
export interface BankBundle { bank: Bank; questions: Question[] }

export interface Http { get(url: string, signal?: AbortSignal): Promise<string> }
/** `keys` and `delete` let the client drop files the content no longer uses; a store without them keeps everything. */
export interface KeyValue {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  keys?(): Promise<string[]>;
  delete?(key: string): Promise<void>;
}

export interface ContentOptions {
  /** Content shipped inside the app: the fallback for the index when no network mirror answers, and the first place to look for hashed files. */
  snapshot?: string;
  /** How long one mirror may take, in milliseconds, before the next is asked. */
  timeouts?: { index: number; file: number };
  /** Cache keys (`banks/<hash>`, `nodes/<hash>`) that `tidy` never deletes; asked at the moment of each deletion, so the app can pin what an unfinished exam uses. */
  pinned?: () => string[];
}

export const HASH_LENGTH = 16;

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, HASH_LENGTH);
}

const parse = (text: string | undefined): unknown => {
  if (text == null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isRef = (value: unknown) => typeof value === "object" && value != null && typeof (value as NodeRef).id === "string" && typeof (value as NodeRef).hash === "string";

/** Only what the app reads is checked, so an index that later gains a field still loads in apps already installed. */
const isIndex = (value: unknown): value is ContentIndex => {
  const index = value as ContentIndex;
  return typeof index === "object" && index != null && typeof index.version === "string" && typeof index.kinds === "object" && index.kinds != null
    && Array.isArray(index.roots) && index.roots.every(isRef);
};

const isManifest = (value: unknown): value is NodeManifest => {
  const node = value as NodeManifest;
  return typeof node === "object" && node != null && typeof node.id === "string" && Array.isArray(node.children) && Array.isArray(node.banks);
};

/**
 * Reads compiled content from an ordered list of network mirrors and the snapshot shipped with the app.
 * Hashed files never change, so they are cached forever and may come from anywhere that has the same bytes; only the index is re-fetched.
 */
export class ContentClient {
  private bases: string[];
  private http: Http;
  private cache: KeyValue;
  private snapshot?: string;
  private timeouts: { index: number; file: number };
  private pinned?: () => string[];
  /** Indexes being accepted right now, by `version`, so a repeated `index()` does not start a second pass. */
  private accepting = new Map<string, Promise<void>>();
  /** Hashed files being downloaded right now, by cache key. */
  private loading = new Map<string, Promise<string>>();

  constructor(bases: string[], http: Http, cache: KeyValue, options: ContentOptions = {}) {
    this.bases = bases;
    this.http = http;
    this.cache = cache;
    this.snapshot = options.snapshot;
    this.timeouts = options.timeouts ?? { index: 6000, file: 30000 };
    this.pinned = options.pinned;
  }

  /** A mirror that hangs (a captive portal, a dying connection) is given up after `ms`, even if the transport ignores the abort. */
  private request(url: string, ms: number): Promise<string> {
    const control = new AbortController();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        control.abort();
        reject(new Error(`timed out: ${url}`));
      }, ms);
      Promise.resolve().then(() => this.http.get(url, control.signal)).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  private async fromMirrors(bases: string[], path: string, ms: number, accept: (text: string) => Promise<boolean>): Promise<string | undefined> {
    for (const base of bases) {
      try {
        const text = await this.request(`${base.replace(/\/$/, "")}/${path}`, ms);
        if (await accept(text)) return text;
      } catch {
        // try the next mirror
      }
    }
    return undefined;
  }

  private async read(key: string): Promise<string | undefined> {
    try {
      return await this.cache.get(key);
    } catch {
      return undefined;
    }
  }

  /** False when the value could not be stored; it is then loaded again next time. */
  private async store(key: string, value: string): Promise<boolean> {
    try {
      await this.cache.set(key, value);
      return true;
    } catch {
      return false;
    }
  }

  private async shipped(): Promise<ContentIndex | undefined> {
    if (!this.snapshot) return undefined;
    const text = await this.fromMirrors([this.snapshot], "index.json", this.timeouts.index, async (t) => isIndex(parse(t)));
    return text ? JSON.parse(text) : undefined;
  }

  /**
   * The newest index a network mirror gives; without one, the last network index seen, then the snapshot shipped with the app.
   * `offline` says the index did not come from the network although mirrors are configured. The snapshot is never stored as the index:
   * it may be older than the stored one, and the content hash in `version` cannot tell which is newer.
   * A fresh index is returned and used at once but stored later, in the background (`accept`): the next offline start reads the stored
   * one, so it is stored only once the files that were stored for the old one have their replacements. The first index, or one with the
   * stored version, is stored immediately.
   */
  async index(): Promise<{ index: ContentIndex; offline: boolean }> {
    // With no network mirror the shipped content is the source itself, not a fallback.
    if (this.bases.length === 0) {
      const own = await this.shipped();
      if (own) return { index: own, offline: false };
      throw new Error("no content is shipped and no mirror is configured");
    }
    const fresh = await this.fromMirrors(this.bases, "index.json", this.timeouts.index, async (t) => isIndex(parse(t)));
    if (fresh) {
      const index: ContentIndex = JSON.parse(fresh);
      const old = parse(await this.read("index"));
      if (!isIndex(old) || old.version === index.version) {
        // Tidied only against an index that is stored: the next offline start reads the stored one and needs its files.
        if (await this.store("index", fresh)) void this.tidy(index);
      } else if (!this.accepting.has(index.version)) {
        const pass = this.accept(index, fresh, old).finally(() => this.accepting.delete(index.version));
        this.accepting.set(index.version, pass);
      }
      return { index, offline: false };
    }
    const cached = parse(await this.read("index"));
    if (isIndex(cached)) return { index: cached, offline: true };
    const own = await this.shipped();
    if (own) return { index: own, offline: true };
    throw new Error("content is unavailable and nothing is cached");
  }

  /**
   * Stores `fresh` over the stored index `old` once whatever was stored for `old` is replaced: walks `old` over the cache only, then
   * walks `fresh` and downloads a node that `old` had stored (under the same id) and a bank that `old` had stored, nothing else, so
   * what opened offline before still opens and the whole catalog is not downloaded. Any failure leaves the stored index and files as
   * they were; it never throws.
   */
  private async accept(index: ContentIndex, text: string, old: ContentIndex): Promise<void> {
    try {
      const nodes = new Set<string>(), banks = new Set<string>(), seen = new Set<string>();
      const scan = async (ref: NodeRef): Promise<void> => {
        if (seen.has(ref.hash)) return;
        seen.add(ref.hash);
        const node = parse(await this.read(`nodes/${ref.hash}`));
        if (!isManifest(node)) return;
        nodes.add(ref.id);
        for (const bank of node.banks) if (await this.isCached("banks", bank.hash)) banks.add(bank.id);
        for (const child of node.children) await scan(child);
      };
      for (const root of old.roots) await scan(root);

      // A file that was downloaded but could not be stored (no room) is not a replacement: the old one must stay.
      const kept = async (folder: "nodes" | "banks", hash: string) => {
        if (!(await this.isCached(folder, hash))) throw new Error(`${folder}/${hash} is not stored`);
      };
      const done = new Set<string>();
      const visit =async (ref: NodeRef): Promise<void> => {
        if (done.has(ref.hash)) return;
        done.add(ref.hash);
        let node: unknown = parse(await this.read(`nodes/${ref.hash}`));
        if (!isManifest(node)) {
          if (!nodes.has(ref.id)) return;
          node = await this.node(ref.hash);
          await kept("nodes", ref.hash);
        }
        const manifest = node as NodeManifest;
        for (const bank of manifest.banks) {
          if (!banks.has(bank.id) || (await this.isCached("banks", bank.hash))) continue;
          await this.bank(bank.hash);
          await kept("banks", bank.hash);
        }
        for (const child of manifest.children) await visit(child);
      };
      for (const root of index.roots) await visit(root);
      if (await this.store("index", text)) await this.tidy(index);
    } catch {
      // the stored index stays; the next start tries again
    }
  }

  private async blob<T>(folder: string, hash: string): Promise<T> {
    const key = `${folder}/${hash}`;
    const cached = parse(await this.read(key));
    if (cached !== undefined) return cached as T;
    // Screens that ask for the same file at once share one download; each gets its own parsed copy.
    let text = this.loading.get(key);
    if (!text) {
      text = this.download(key, hash).finally(() => this.loading.delete(key));
      this.loading.set(key, text);
    }
    return JSON.parse(await text);
  }

  private async download(key: string, hash: string): Promise<string> {
    // The snapshot first: a file shipped with the app needs no request to the network. A copy with other bytes (stale, tampered, an error page) is skipped.
    const sources = this.snapshot ? [this.snapshot, ...this.bases] : this.bases;
    const text = await this.fromMirrors(sources, `${key}.json`, this.timeouts.file, async (t) => (await sha256(t)) === hash);
    if (!text) throw new Error(`cannot load ${key}`);
    await this.store(key, text);
    return text;
  }

  node(hash: string) { return this.blob<NodeManifest>("nodes", hash); }
  bank(hash: string) { return this.blob<BankBundle>("banks", hash); }
  isCached(folder: "nodes" | "banks", hash: string) { return this.read(`${folder}/${hash}`).then((v) => v != null); }

  /**
   * Drops stored node and bank files that the given index, already stored, no longer reaches, and only when every node it reaches is
   * stored. Keys the `pinned` option lists are never dropped. Until then what it reaches is not fully known: an unchanged folder keeps its old file under a root not downloaded yet, a moved
   * bank or a renamed folder sits under another node, and deleting them would break them offline. An index without roots deletes nothing.
   * Only `nodes/` and `banks/` keys are touched; a failure leaves the rest.
   */
  async tidy(index: ContentIndex): Promise<void> {
    if (!this.cache.keys || !this.cache.delete) return;
    try {
      const keys = await this.cache.keys();
      const keep = new Set<string>();
      let complete = index.roots.length > 0;
      const visit = async (ref: NodeRef): Promise<void> => {
        const key = `nodes/${ref.hash}`;
        if (keep.has(key)) return;
        const node = parse(await this.read(key));
        if (!isManifest(node)) {
          complete = false;
          return;
        }
        keep.add(key);
        for (const bank of node.banks) keep.add(`banks/${bank.hash}`);
        for (const child of node.children) await visit(child);
      };
      for (const root of index.roots) await visit(root);
      if (!complete) return;
      for (const key of keys) {
        if ((key.startsWith("nodes/") || key.startsWith("banks/")) && !keep.has(key) && !this.pinned?.().includes(key)) await this.cache.delete(key);
      }
    } catch {
      // housekeeping only: whatever is left stays usable
    }
  }
}
