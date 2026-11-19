import { describe, expect, test } from "vitest";
import { ContentClient, sha256, type Http, type KeyValue } from "../src/content.ts";

const REMOTE = "https://mirror.test/content";
const SLOW = "https://slow.test/content";
const SHIPPED = "./content";

const memory = (entries: Record<string, string> = {}) => {
  const map = new Map(Object.entries(entries));
  const store: KeyValue = {
    get: async (key) => map.get(key),
    set: async (key, value) => void map.set(key, value),
    keys: async () => [...map.keys()],
    delete: async (key) => void map.delete(key),
  };
  return Object.assign(store, { map });
};

/** Serves the given files by full address; a mirror under SLOW never answers until the request is aborted. */
const web = (files: Record<string, string>) => {
  const asked: string[] = [];
  const http: Http = {
    get: (url, signal) => {
      asked.push(url);
      if (url.startsWith(SLOW)) return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      return url in files ? Promise.resolve(files[url]!) : Promise.reject(new Error(`404 ${url}`));
    },
  };
  return Object.assign(http, { asked });
};

const index = (version: string, roots: { id: string; hash: string }[] = []) =>
  JSON.stringify({ format: "exambank/2", version, kinds: {}, roots: roots.map((r) => ({ ...r, kind: "k", title: "x", banks: 0 })) });
const manifest = (id: string, children: { id: string; hash: string }[], banks: string[]) =>
  JSON.stringify({ id, kind: "k", title: "x", children: children.map((c) => ({ ...c, kind: "k", title: "x", banks: 0 })), banks: banks.map((hash) => ({ id: `b-${hash}`, subject: "x", language: "ru", locales: ["ru"], questions: 1, typed: 0, hash })), order: [] });
const fast = { index: 30, file: 30 };

describe("the content index", () => {
  test("a network index is used and kept for the next start", async () => {
    const cache = memory();
    const client = new ContentClient([REMOTE], web({ [`${REMOTE}/index.json`]: index("v2") }), cache, { snapshot: SHIPPED });
    const result = await client.index();
    expect(result).toMatchObject({ index: { version: "v2" }, offline: false });
    expect(JSON.parse(cache.map.get("index")!).version).toBe("v2");
  });

  test("offline, the last network index wins over the shipped snapshot, and the snapshot does not replace it", async () => {
    const cache = memory({ index: index("v1") });
    const client = new ContentClient([REMOTE], web({ [`${SHIPPED}/index.json`]: index("v0") }), cache, { snapshot: SHIPPED });
    expect(await client.index()).toMatchObject({ index: { version: "v1" }, offline: true });
    expect(JSON.parse(cache.map.get("index")!).version).toBe("v1");
  });

  test("first start without a network uses the shipped snapshot and says the app is offline", async () => {
    const cache = memory();
    const client = new ContentClient([REMOTE], web({ [`${SHIPPED}/index.json`]: index("v0") }), cache, { snapshot: SHIPPED });
    expect(await client.index()).toMatchObject({ index: { version: "v0" }, offline: true });
    expect(cache.map.has("index")).toBe(false);
  });

  test("a build with no network mirror treats its snapshot as the source, not as being offline", async () => {
    const client = new ContentClient([], web({ [`${SHIPPED}/index.json`]: index("v0") }), memory({ index: index("old") }), { snapshot: SHIPPED });
    expect(await client.index()).toMatchObject({ index: { version: "v0" }, offline: false });
  });

  test("a mirror that never answers is given up after the timeout and the next one is asked", async () => {
    const http = web({ [`${REMOTE}/index.json`]: index("v2") });
    const client = new ContentClient([SLOW, REMOTE], http, memory(), { timeouts: fast });
    expect(await client.index()).toMatchObject({ index: { version: "v2" }, offline: false });
    expect(http.asked).toEqual([`${SLOW}/index.json`, `${REMOTE}/index.json`]);
  });

  test("a broken index (an error page, a file without roots) is neither used nor kept", async () => {
    for (const broken of ["<html>Not found</html>", JSON.stringify({ version: "v9" })]) {
      const cache = memory({ index: index("v1") });
      const client = new ContentClient([REMOTE], web({ [`${REMOTE}/index.json`]: broken }), cache);
      expect(await client.index()).toMatchObject({ index: { version: "v1" }, offline: true });
      expect(JSON.parse(cache.map.get("index")!).version).toBe("v1");
    }
  });

  test("an unreadable stored index falls through to the snapshot instead of failing the start", async () => {
    const client = new ContentClient([REMOTE], web({ [`${SHIPPED}/index.json`]: index("v0") }), memory({ index: "{oops" }), { snapshot: SHIPPED });
    expect(await client.index()).toMatchObject({ index: { version: "v0" }, offline: true });
  });

  test("storage that refuses writes does not fail the load", async () => {
    const cache: KeyValue = { get: async () => undefined, set: () => Promise.reject(new Error("quota")) };
    const client = new ContentClient([REMOTE], web({ [`${REMOTE}/index.json`]: index("v2") }), cache);
    expect(await client.index()).toMatchObject({ index: { version: "v2" }, offline: false });
  });

  test("nothing anywhere is an error the screen can offer to retry", async () => {
    await expect(new ContentClient([REMOTE], web({}), memory(), { snapshot: SHIPPED }).index()).rejects.toThrow();
  });
});

describe("hashed files", () => {
  test("come from the snapshot first, so a bank shipped with the app opens without a request to the network", async () => {
    const text = manifest("n", [], []);
    const hash = await sha256(text);
    const http = web({ [`${SHIPPED}/nodes/${hash}.json`]: text, [`${REMOTE}/nodes/${hash}.json`]: text });
    await new ContentClient([REMOTE], http, memory(), { snapshot: SHIPPED }).node(hash);
    expect(http.asked).toEqual([`${SHIPPED}/nodes/${hash}.json`]);
  });

  test("a copy with other bytes is skipped and the next mirror is asked", async () => {
    const text = manifest("n", [], []);
    const hash = await sha256(text);
    const http = web({ [`${SHIPPED}/nodes/${hash}.json`]: manifest("old", [], []), [`${REMOTE}/nodes/${hash}.json`]: text });
    const node = await new ContentClient([REMOTE], http, memory(), { snapshot: SHIPPED }).node(hash);
    expect(node.id).toBe("n");
  });

  test("two screens asking for the same file at once share one download", async () => {
    const text = manifest("n", [], []);
    const hash = await sha256(text);
    const http = web({ [`${REMOTE}/nodes/${hash}.json`]: text });
    const client = new ContentClient([REMOTE], http, memory());
    const [a, b] = await Promise.all([client.node(hash), client.node(hash)]);
    expect(http.asked).toEqual([`${REMOTE}/nodes/${hash}.json`]);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  test("a failed download is not remembered, so trying again asks the network again", async () => {
    const text = manifest("n", [], []);
    const hash = await sha256(text);
    const files: Record<string, string> = {};
    const http = web(files);
    const client = new ContentClient([REMOTE], http, memory());
    await expect(client.node(hash)).rejects.toThrow();
    files[`${REMOTE}/nodes/${hash}.json`] = text;
    expect((await client.node(hash)).id).toBe("n");
    expect(http.asked).toHaveLength(2);
  });

  test("a mirror that hangs on a file is given up after the timeout", async () => {
    const text = manifest("n", [], []);
    const hash = await sha256(text);
    const node = await new ContentClient([SLOW, REMOTE], web({ [`${REMOTE}/nodes/${hash}.json`]: text }), memory(), { timeouts: fast }).node(hash);
    expect(node.id).toBe("n");
  });
});

describe("tidying stored files", () => {
  test("removes node and bank files the current index no longer reaches, and nothing else", async () => {
    const cache = memory({
      index: index("v2", [{ id: "root", hash: "r2" }]),
      "nodes/r2": manifest("root", [], ["b2"]),
      "nodes/r1": manifest("root", [], ["b1"]),
      "banks/b2": "{}",
      "banks/b1": "{}",
      "nodes/gone": manifest("removed", [], ["b9"]),
      "banks/b9": "{}",
    });
    await new ContentClient([REMOTE], web({}), cache).tidy(JSON.parse(cache.map.get("index")!));
    expect([...cache.map.keys()].sort()).toEqual(["banks/b2", "index", "nodes/r2"]);
  });

  test("after an update, an unchanged folder keeps its file and bank; the replaced ones go", async () => {
    // v2 changed only T; S kept its hash, so its stored file is current although it was downloaded under v1.
    const cache = memory({
      "nodes/r1": manifest("root", [{ id: "S", hash: "s1" }, { id: "T", hash: "t1" }], []),
      "nodes/r2": manifest("root", [{ id: "S", hash: "s1" }, { id: "T", hash: "t2" }], []),
      "nodes/s1": manifest("S", [], ["bs"]),
      "nodes/t1": manifest("T", [], ["bt1"]),
      "nodes/t2": manifest("T", [], ["bt2"]),
      "banks/bs": "{}",
      "banks/bt1": "{}",
    });
    await new ContentClient([REMOTE], web({}), cache).tidy(JSON.parse(index("v2", [{ id: "root", hash: "r2" }])));
    expect([...cache.map.keys()].sort()).toEqual(["banks/bs", "nodes/r2", "nodes/s1", "nodes/t2"]);
  });

  test("while a node the index reaches is not downloaded yet, nothing is removed", async () => {
    // The new root is not here yet: an unchanged folder under it still points at the stored files.
    const stored = {
      "nodes/r1": manifest("root", [{ id: "S", hash: "s1" }], []),
      "nodes/s1": manifest("S", [], ["bs"]),
      "banks/bs": "{}",
    };
    const cache = memory(stored);
    await new ContentClient([REMOTE], web({}), cache).tidy(JSON.parse(index("v2", [{ id: "root", hash: "r2" }])));
    expect([...cache.map.keys()].sort()).toEqual(Object.keys(stored).sort());
  });

  test("an index without roots removes nothing", async () => {
    const cache = memory({ "nodes/r1": manifest("root", [], ["b1"]), "banks/b1": "{}" });
    await new ContentClient([REMOTE], web({}), cache).tidy(JSON.parse(index("v2", [])));
    expect([...cache.map.keys()].sort()).toEqual(["banks/b1", "nodes/r1"]);
  });

  test("two content updates in a row keep a bank that is still current", async () => {
    // v2 changed A (a1 -> a2, bank ba2); v3 changed only B. On the start that got v3 the new root is not stored yet.
    const cache = memory({
      "nodes/r1": manifest("root", [{ id: "A", hash: "a1" }], []),
      "nodes/r2": manifest("root", [{ id: "A", hash: "a2" }, { id: "B", hash: "b2" }], []),
      "nodes/a1": manifest("A", [], ["ba1"]),
      "nodes/a2": manifest("A", [], ["ba2"]),
      "banks/ba1": "{}",
      "banks/ba2": "{}",
    });
    await new ContentClient([REMOTE], web({}), cache).tidy(JSON.parse(index("v3", [{ id: "root", hash: "r3" }])));
    expect(cache.map.has("banks/ba2")).toBe(true);
    expect(cache.map.has("nodes/a2")).toBe(true);
  });

  test("a renamed folder keeps its bank until the new node is downloaded", async () => {
    const cache = memory({ "nodes/x1": manifest("old-name", [], ["B"]), "banks/B": "{}" });
    await new ContentClient([REMOTE], web({}), cache).tidy(JSON.parse(index("v2", [{ id: "new-name", hash: "y1" }])));
    expect(cache.map.has("banks/B")).toBe(true);
  });

  // Both versions are stored, so tidying against v2 would remove the v1 files.
  const twoVersions = () => memory({
    index: index("v1", [{ id: "root", hash: "r1" }]),
    "nodes/r1": manifest("root", [], ["b1"]),
    "banks/b1": "{}",
    "nodes/r2": manifest("root", [], ["b2"]),
    "banks/b2": "{}",
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("a network index tidies the stored files behind it", async () => {
    const cache = twoVersions();
    await new ContentClient([REMOTE], web({ [`${REMOTE}/index.json`]: index("v2", [{ id: "root", hash: "r2" }]) }), cache).index();
    await settle();
    expect([...cache.map.keys()].sort()).toEqual(["banks/b2", "index", "nodes/r2"]);
  });

  test("nothing is tidied when the fresh index could not be stored, since the next offline start reads the old one", async () => {
    const cache = twoVersions();
    cache.set = () => Promise.reject(new Error("quota"));
    const client = new ContentClient([REMOTE], web({ [`${REMOTE}/index.json`]: index("v2", [{ id: "root", hash: "r2" }]) }), cache);
    expect(await client.index()).toMatchObject({ index: { version: "v2" }, offline: false });
    await settle();
    expect([...cache.map.keys()].sort()).toEqual(["banks/b1", "banks/b2", "index", "nodes/r1", "nodes/r2"]);
  });
});

/** Hashed files the network can serve (a mirror only accepts bytes that match the name). */
const hashed = async (text: string) => ({ text, hash: await sha256(text) });
const nodeText = (id: string, children: { id: string; hash: string }[], banks: { id: string; hash: string }[]) =>
  JSON.stringify({ id, kind: "k", title: "x", children: children.map((c) => ({ ...c, kind: "k", title: "x", banks: 0 })), banks: banks.map((b) => ({ ...b, subject: "x", language: "ru", locales: ["ru"], questions: 1, typed: 0 })), order: [] });
const until = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
const stored = (cache: { map: Map<string, string> }) => JSON.parse(cache.map.get("index")!).version;

describe("accepting a fresh index", () => {
  test("an update seen online is usable on the next offline start", async () => {
    const r1 = await hashed(nodeText("root", [], [])), r2 = await hashed(nodeText("root", [], [{ id: "B", hash: "bz" }]));
    const cache = memory({ index: index("v1", [{ id: "root", hash: r1.hash }]), [`nodes/${r1.hash}`]: r1.text });
    const online = web({ [`${REMOTE}/index.json`]: index("v2", [{ id: "root", hash: r2.hash }]), [`${REMOTE}/nodes/${r2.hash}.json`]: r2.text });
    expect((await new ContentClient([REMOTE], online, cache).index()).index.version).toBe("v2");
    await until(() => stored(cache) === "v2");

    const offline = new ContentClient([REMOTE], web({}), cache);
    const { index: seen, offline: flag } = await offline.index();
    expect(flag).toBe(true);
    expect((await offline.node(seen.roots[0]!.hash)).id).toBe("root");
  });

  test("when a file the new index needs cannot be loaded, the old index stays and everything keeps opening", async () => {
    const r1 = await hashed(nodeText("root", [], [])), r2 = await hashed(nodeText("root", [], [{ id: "B", hash: "bz" }]));
    const cache = memory({ index: index("v1", [{ id: "root", hash: r1.hash }]), [`nodes/${r1.hash}`]: r1.text });
    const online = web({ [`${REMOTE}/index.json`]: index("v2", [{ id: "root", hash: r2.hash }]) });
    expect((await new ContentClient([REMOTE], online, cache).index()).index.version).toBe("v2");
    await pause();
    expect(stored(cache)).toBe("v1");
    expect(cache.map.has(`nodes/${r1.hash}`)).toBe(true);

    const offline = new ContentClient([REMOTE], web({}), cache);
    const { index: seen } = await offline.index();
    expect(seen.version).toBe("v1");
    expect((await offline.node(seen.roots[0]!.hash)).id).toBe("root");
  });

  test("a replacement that was downloaded but could not be stored is no replacement: the old bank and index stay", async () => {
    const b1 = await hashed(JSON.stringify({ bank: { id: "B" }, questions: [] })), b2 = await hashed(JSON.stringify({ bank: { id: "B", v: 2 }, questions: [] }));
    const r1 = await hashed(nodeText("root", [], [{ id: "B", hash: b1.hash }])), r2 = await hashed(nodeText("root", [], [{ id: "B", hash: b2.hash }]));
    const cache = memory({ index: index("v1", [{ id: "root", hash: r1.hash }]), [`nodes/${r1.hash}`]: r1.text, [`banks/${b1.hash}`]: b1.text });
    const put = cache.set;
    cache.set = (key, value) => (key === `banks/${b2.hash}` ? Promise.reject(new Error("quota")) : put(key, value));
    const online = web({
      [`${REMOTE}/index.json`]: index("v2", [{ id: "root", hash: r2.hash }]),
      [`${REMOTE}/nodes/${r2.hash}.json`]: r2.text,
      [`${REMOTE}/banks/${b2.hash}.json`]: b2.text,
    });
    await new ContentClient([REMOTE], online, cache).index();
    await pause();
    expect(stored(cache)).toBe("v1");
    expect(cache.map.has(`banks/${b1.hash}`)).toBe(true);
  });

  test("a bank that was stored is replaced by its new version, and the old file goes only after the new one is stored", async () => {
    const b1 = await hashed(JSON.stringify({ bank: { id: "B" }, questions: [] })), b2 = await hashed(JSON.stringify({ bank: { id: "B", v: 2 }, questions: [] }));
    const r1 = await hashed(nodeText("root", [], [{ id: "B", hash: b1.hash }])), r2 = await hashed(nodeText("root", [], [{ id: "B", hash: b2.hash }]));
    const cache = memory({ index: index("v1", [{ id: "root", hash: r1.hash }]), [`nodes/${r1.hash}`]: r1.text, [`banks/${b1.hash}`]: b1.text });
    const order: boolean[] = [];
    const remove = cache.delete!;
    cache.delete = async (key) => {
      if (key === `banks/${b1.hash}`) order.push(cache.map.has(`banks/${b2.hash}`));
      return remove(key);
    };
    const online = web({
      [`${REMOTE}/index.json`]: index("v2", [{ id: "root", hash: r2.hash }]),
      [`${REMOTE}/nodes/${r2.hash}.json`]: r2.text,
      [`${REMOTE}/banks/${b2.hash}.json`]: b2.text,
    });
    await new ContentClient([REMOTE], online, cache).index();
    await until(() => !cache.map.has(`banks/${b1.hash}`));

    expect(order).toEqual([true]);
    const offline = new ContentClient([REMOTE], web({}), cache);
    const { index: seen } = await offline.index();
    const root = await offline.node(seen.roots[0]!.hash);
    expect((await offline.bank(root.banks[0]!.hash)).bank).toMatchObject({ id: "B", v: 2 });
  });

  test("a section nobody opened is not downloaded, and the same index is not accepted twice at once", async () => {
    const s1 = await hashed(nodeText("S", [], [])), s2 = await hashed(nodeText("S", [], [{ id: "N", hash: "nn" }])), u2 = await hashed(nodeText("U", [], []));
    const r1 = await hashed(nodeText("root", [{ id: "S", hash: s1.hash }, { id: "U", hash: "u1" }], []));
    const r2 = await hashed(nodeText("root", [{ id: "S", hash: s2.hash }, { id: "U", hash: u2.hash }], []));
    const cache = memory({ index: index("v1", [{ id: "root", hash: r1.hash }]), [`nodes/${r1.hash}`]: r1.text, [`nodes/${s1.hash}`]: s1.text });
    const online = web({
      [`${REMOTE}/index.json`]: index("v2", [{ id: "root", hash: r2.hash }]),
      [`${REMOTE}/nodes/${r2.hash}.json`]: r2.text,
      [`${REMOTE}/nodes/${s2.hash}.json`]: s2.text,
      [`${REMOTE}/nodes/${u2.hash}.json`]: u2.text,
    });
    const client = new ContentClient([REMOTE], online, cache);
    await Promise.all([client.index(), client.index()]);
    await until(() => stored(cache) === "v2");

    expect(stored(cache)).toBe("v2");
    expect(online.asked.filter((url) => url.includes(`/nodes/${u2.hash}`))).toEqual([]);
    expect(online.asked.filter((url) => url.includes(`/nodes/${s2.hash}`))).toHaveLength(1);
    expect(online.asked.filter((url) => url.includes(`/nodes/${r2.hash}`))).toHaveLength(1);
  });

  test("the first start stores the index at once", async () => {
    const cache = memory();
    await new ContentClient([REMOTE], web({ [`${REMOTE}/index.json`]: index("v1", [{ id: "root", hash: "r1" }]) }), cache).index();
    expect(stored(cache)).toBe("v1");
  });

  test("a key the app pinned survives tidying, even one pinned after the tidy began", async () => {
    const pinned: string[] = [];
    const cache = memory({
      index: index("v2", [{ id: "root", hash: "r2" }]),
      "nodes/r2": manifest("root", [], ["b2"]),
      "banks/b2": "{}",
      "banks/b1": "{}",
      "banks/b0": "{}",
    });
    const client = new ContentClient([REMOTE], web({}), cache, { pinned: () => pinned });
    pinned.push("banks/b1");
    await client.tidy(JSON.parse(cache.map.get("index")!));
    expect([...cache.map.keys()].sort()).toEqual(["banks/b1", "banks/b2", "index", "nodes/r2"]);
  });
});

describe("what the device holds", () => {
  const hangs: Http & { asked: string[] } = Object.assign({ get: () => new Promise<string>(() => {}) } as Http, { asked: [] as string[] });

  test("stored() gives the stored index without asking the network, and writes nothing", async () => {
    const cache = memory({ index: index("v1") });
    const calls: string[] = [];
    const http: Http = { get: (url) => (calls.push(url), hangs.get(url)) };
    const client = new ContentClient([REMOTE], http, cache, { snapshot: SHIPPED });
    expect((await client.stored())?.version).toBe("v1");
    expect(calls.filter((u) => u.startsWith(REMOTE))).toEqual([]);
    expect([...cache.map.keys()]).toEqual(["index"]);
  });

  test("stored() falls back to the shipped snapshot, then to nothing", async () => {
    const cache = memory();
    const withSnapshot = new ContentClient([REMOTE], web({ [`${SHIPPED}/index.json`]: index("v0") }), cache, { snapshot: SHIPPED });
    expect((await withSnapshot.stored())?.version).toBe("v0");
    expect(cache.map.size).toBe(0);
    expect(await new ContentClient([REMOTE], web({}), memory(), { snapshot: SHIPPED }).stored()).toBeUndefined();
    expect(await new ContentClient([REMOTE], web({}), memory()).stored()).toBeUndefined();
  });

  test("with no mirrors stored() is the shipped content", async () => {
    const client = new ContentClient([], web({ [`${SHIPPED}/index.json`]: index("v0") }), memory({ index: index("v1") }), { snapshot: SHIPPED });
    expect((await client.stored())?.version).toBe("v0");
  });
});

describe("files read in this run", () => {
  const counted = (cache: ReturnType<typeof memory>) => {
    const reads: string[] = [];
    const get = cache.get;
    cache.get = async (key) => (reads.push(key), get(key));
    return reads;
  };

  test("a second call does not read the store again and returns an independent copy", async () => {
    const text = manifest("n", [], []);
    const hash = await sha256(text);
    const cache = memory({ [`nodes/${hash}`]: text });
    const reads = counted(cache);
    const client = new ContentClient([REMOTE], web({}), cache);
    const first = await client.node(hash);
    first.id = "changed";
    const second = await client.node(hash);
    expect(second.id).toBe("n");
    expect(reads.filter((k) => k === `nodes/${hash}`)).toHaveLength(1);
  });

  test("a downloaded file is kept too", async () => {
    const text = manifest("n", [], []);
    const hash = await sha256(text);
    const cache = memory();
    const reads = counted(cache);
    const client = new ContentClient([REMOTE], web({ [`${REMOTE}/nodes/${hash}.json`]: text }), cache);
    await client.node(hash);
    await client.node(hash);
    expect(reads.filter((k) => k === `nodes/${hash}`)).toHaveLength(1);
  });

  test("a file that could not be stored is served from memory but still counts as not stored", async () => {
    const text = JSON.stringify({ bank: { id: "b" }, questions: [] });
    const hash = await sha256(text);
    const cache = memory();
    cache.set = async () => { throw new Error("quota"); };
    const client = new ContentClient([REMOTE], web({ [`${REMOTE}/banks/${hash}.json`]: text }), cache);
    expect((await client.bank(hash)).bank).toMatchObject({ id: "b" });
    expect((await client.bank(hash)).bank).toMatchObject({ id: "b" });
    expect(await client.isCached("banks", hash)).toBe(false);
  });

  test("only the last 3 bank files stay in memory", async () => {
    const files: Record<string, string> = {};
    const hashes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const text = JSON.stringify({ bank: { id: `b${i}` }, questions: [] });
      hashes.push(await sha256(text));
      files[`banks/${hashes[i]}`] = text;
    }
    const cache = memory(files);
    const reads = counted(cache);
    const client = new ContentClient([REMOTE], web({}), cache);
    for (const hash of hashes) await client.bank(hash);
    await client.bank(hashes[3]!);
    await client.bank(hashes[1]!);
    expect(reads.filter((k) => k === `banks/${hashes[3]}`)).toHaveLength(1);
    expect(reads.filter((k) => k === `banks/${hashes[1]}`)).toHaveLength(1);
    await client.bank(hashes[0]!);
    expect(reads.filter((k) => k === `banks/${hashes[0]}`)).toHaveLength(2);
  });
});

describe("the shipped snapshot request", () => {
  test("stored() and index() started together ask for the snapshot once", async () => {
    const http = web({ [`${SHIPPED}/index.json`]: index("v0") });
    const client = new ContentClient([], http, memory(), { snapshot: SHIPPED });
    const [stored, current] = await Promise.all([client.stored(), client.index()]);
    expect(stored?.version).toBe("v0");
    expect(current.index.version).toBe("v0");
    expect(http.asked).toEqual([`${SHIPPED}/index.json`]);
  });

  test("a finished request is not reused: after a failure the next call asks again", async () => {
    const files: Record<string, string> = {};
    const http = web(files);
    const client = new ContentClient([], http, memory(), { snapshot: SHIPPED });
    await expect(client.index()).rejects.toThrow();
    files[`${SHIPPED}/index.json`] = index("v0");
    expect((await client.index()).index.version).toBe("v0");
    expect(http.asked).toHaveLength(2);
    await client.index();
    expect(http.asked).toHaveLength(3);
  });
});

describe("a file that could not be stored", () => {
  test("is written again the next time it is served from memory", async () => {
    const text = manifest("n", [], []);
    const hash = await sha256(text);
    const cache = memory();
    let failing = true;
    const set = cache.set;
    cache.set = async (key, value) => {
      if (failing) throw new Error("quota");
      return set(key, value);
    };
    const client = new ContentClient([REMOTE], web({ [`${REMOTE}/nodes/${hash}.json`]: text }), cache);
    expect((await client.node(hash)).id).toBe("n");
    expect(cache.map.has(`nodes/${hash}`)).toBe(false);
    failing = false;
    expect((await client.node(hash)).id).toBe("n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cache.map.get(`nodes/${hash}`)).toBe(text);
  });
});
