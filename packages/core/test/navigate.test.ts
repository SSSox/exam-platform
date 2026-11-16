import { describe, expect, test } from "vitest";
import type { BankRef, NodeManifest, NodeRef } from "../src/content.ts";
import { descend, entriesOf, isFork, placeOf, restore, rootEntries, walk } from "../src/navigate.ts";

const title = { ru: "x" };
const node = (id: string, banks = 1): NodeRef => ({ id, kind: "k", title, hash: `h:${id}`, banks });
const bank = (id: string): BankRef => ({ id, subject: title, language: "ru", locales: ["ru"], questions: 10, typed: 0, hash: `b:${id}` });
const manifest = (id: string, children: string[], banks: string[], order: string[] = [], kind = "k"): NodeManifest => ({
  id, kind, title, children: children.map((c) => node(c)), banks: banks.map(bank), order,
});

/** uni → faculty → degree → (year-1 | year-2); year-1 has a subject and a subject group of three banks. */
const tree: Record<string, NodeManifest> = {
  u: manifest("u", ["u/f"], []),
  "u/f": manifest("u/f", ["u/f/d"], []),
  "u/f/d": manifest("u/f/d", ["u/f/d/y1", "u/f/d/y2"], []),
  "u/f/d/y1": manifest("u/f/d/y1", ["u/f/d/y1/kk"], ["psy"], ["u/f/d/y1/kk", "psy"]),
  "u/f/d/y1/kk": manifest("u/f/d/y1/kk", [], ["kk-a1", "kk-a2", "kk-b"]),
  "u/f/d/y2": manifest("u/f/d/y2", [], ["hist"]),
};
const load = async (ref: NodeRef) => tree[ref.id]!;

describe("entries", () => {
  test("follow the given order, mixing folders and banks", () => {
    const list = entriesOf(tree["u/f/d/y1"]!);
    expect(list.map((e) => `${e.type}:${e.ref.id}`)).toEqual(["node:u/f/d/y1/kk", "bank:psy"]);
  });
  test("without an order, folders come first and nothing is lost or repeated", () => {
    const list = entriesOf({ children: [node("a")], banks: [bank("b")], order: ["b", "b", "gone"] });
    expect(list.map((e) => e.ref.id)).toEqual(["b", "a"]);
  });
  test("a fork needs two or more entries", () => {
    expect(isFork(tree["u"]!)).toBe(false);
    expect(isFork(tree["u/f/d"]!)).toBe(true);
    expect(isFork(tree["u/f/d/y1"]!)).toBe(true);
  });
});

describe("descending through single folders", () => {
  test("a single university, faculty and degree lead straight to the first real choice", async () => {
    const { target, passed } = await descend(rootEntries([node("u")]), "", load);
    expect(target).toEqual({ type: "node", id: "u/f/d" });
    expect(passed.map((n) => n.id)).toEqual(["u", "u/f", "u/f/d"]);
  });
  test("two universities stay on the root list", async () => {
    const { target, passed } = await descend(rootEntries([node("u"), node("v")]), "", load);
    expect(target).toEqual({ type: "node", id: "" });
    expect(passed).toEqual([]);
  });
  test("a folder with one bank opens that bank", async () => {
    const { target } = await descend(entriesOf(tree["u/f/d/y2"]!), "u/f/d/y2", load);
    expect(target).toEqual({ type: "bank", node: "u/f/d/y2", id: "hist" });
  });
  test("a folder that is already a choice does not move", async () => {
    const { target, passed } = await descend(entriesOf(tree["u/f/d/y1"]!), "u/f/d/y1", load);
    expect(target).toEqual({ type: "node", id: "u/f/d/y1" });
    expect(passed).toEqual([]);
  });
  test("an empty root or folder stays where it is", async () => {
    expect((await descend([], "", load)).target).toEqual({ type: "node", id: "" });
  });
});

describe("remembered place", () => {
  const roots = [node("u")];
  test("is the first folder that holds subjects", () => {
    expect(placeOf([tree["u"]!, tree["u/f"]!, tree["u/f/d"]!, tree["u/f/d/y1"]!, tree["u/f/d/y1/kk"]!])).toBe("u/f/d/y1");
  });
  test("is the folder of the kind content marks as a place, even above the first bank", () => {
    const kinds = { semester: { title, place: true } };
    const groups = manifest("s", ["s/g"], [], ["s/g"], "semester");
    const group = manifest("s/g", [], ["a", "b"]);
    expect(placeOf([groups, group], kinds)).toBe("s");
    expect(placeOf([groups, group])).toBe("s/g");
  });
  test("is nothing while the chain has not reached a bank", () => {
    expect(placeOf([tree["u"]!, tree["u/f"]!])).toBeUndefined();
    expect(placeOf([])).toBeUndefined();
  });
  test("walk stops at the deepest folder that exists", async () => {
    expect((await walk(roots, "u/f/d/y9/old", load)).map((n) => n.id)).toEqual(["u", "u/f", "u/f/d"]);
    expect(await walk(roots, "elsewhere", load)).toEqual([]);
  });
  test("restore returns a saved place that is still there", async () => {
    expect((await restore(roots, "u/f/d/y1", load))?.id).toBe("u/f/d/y1");
  });
  test("restore drops a place that was removed or never saved", async () => {
    expect(await restore(roots, "u/f/d/y9", load)).toBeUndefined();
    expect(await restore(roots, "u/f/d/y1/", load)).toBeUndefined();
    expect(await restore(roots, undefined, load)).toBeUndefined();
  });
});
