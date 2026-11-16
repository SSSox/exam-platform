import { describe, expect, test } from "vitest";
import { learn, type BankRef, type Entry, type NodeManifest, type NodeRef, type QuestionState, type Session, type SessionItem } from "@exam/core";
import { KEYS, STATIONS, bankProgress, changeTarget, homeOf, holdExam, isProgressEvent, lineOf, namesLine, pageAbove, pathNames, sharedKind, shown, shortTitle, stationsOf, wipe } from "../src/lib.ts";

/** Names are joined with a dot that stays on the line of the name before it. */
const dots = (...names: string[]) => names.join(" · ");
const state = (patch: Partial<QuestionState> = {}): QuestionState => ({ modes: {}, bookmarked: false, ...patch });
const title = { ru: "x" };
const node = (id: string, kind = "k"): NodeRef => ({ id, kind, title, hash: `h:${id}`, banks: 1 });
const bank = (id: string): BankRef => ({ id, subject: title, language: "ru", locales: ["ru"], questions: 10, typed: 0, hash: `b:${id}` });
const manifest = (id: string, children: string[], banks: string[] = []): NodeManifest => ({
  id, kind: "k", title, children: children.map((c) => node(c)), banks: banks.map(bank), order: [],
});

const T0 = 1_700_000_000_000;
/** A question answered right at three spaced sittings is learned; one answered once is only started. */
const learned = (): QuestionState => {
  let m = learn(undefined, T0, "choice", true);
  m = learn(m, m.due, "choice", true);
  m = learn(m, m.due, "choice", true);
  return state({ lastAt: m.lastAt, lastCorrect: true, memory: m });
};
const started = (): QuestionState => state({ lastAt: T0, lastCorrect: true, memory: learn(undefined, T0, "choice", true) });
const missed = (): QuestionState => state({ lastAt: T0, lastCorrect: false, memory: learn(undefined, T0, "choice", false) });

describe("bank progress", () => {
  test("counts learned questions, not questions merely answered once", () => {
    const states = new Map<number, QuestionState>([[1, learned()], [2, started()], [3, missed()], [4, state({ bookmarked: true })]]);
    const sitting = learned().memory!.lastAt;
    const p = bankProgress(states, 20, sitting);
    expect(p).toMatchObject({ done: 1, total: 20 });
    expect(p.lit).toBe(Math.round((STATIONS * (0.75 + 0.2)) / 20));
  });
  test("lights every station when the whole bank is learned, and fades when left past its date", () => {
    const states = new Map<number, QuestionState>();
    for (let i = 1; i <= 100; i++) states.set(i, learned());
    const due = learned().memory!.due;
    const level = learned().memory!.box;
    expect(level).toBe(3);
    expect(bankProgress(states, 100, due - 1).lit).toBe(Math.round(STATIONS * 0.75));
    expect(bankProgress(states, 100, due + 5 * 86_400_000).lit).toBeLessThan(Math.round(STATIONS * 0.75));
  });
  test("a withdrawn question no longer counts, however well it was learned", () => {
    const states = new Map<number, QuestionState>([[1, learned()], [2, learned()], [3, started()]]);
    const sitting = learned().memory!.lastAt;
    expect(bankProgress(states, 10, sitting)).toMatchObject({ done: 2, total: 10 });
    const without = bankProgress(states, 9, sitting, [2]);
    expect(without).toMatchObject({ done: 1, total: 9 });
    expect(without.lit).toBe(Math.round((STATIONS * (0.75 + 0.2)) / 9));
  });
  test("an empty bank has an empty line", () => {
    expect(bankProgress(new Map(), 0, T0)).toEqual({ done: 0, total: 0, lit: 0 });
  });
  test("lines take their colours in turn", () => {
    expect([0, 4, 5, 11].map(lineOf)).toEqual([0, 4, 0, 1]);
  });
});

describe("titles", () => {
  test("a level loses the name of its group", () => {
    expect(shortTitle("Language, A1", "Language")).toBe("A1");
    expect(shortTitle("Language, B1–B2", "Language")).toBe("B1–B2");
  });
  test("other titles stay as they are", () => {
    expect(shortTitle("Psychology", "Language")).toBe("Psychology");
    expect(shortTitle("Language, ", "Language")).toBe("Language, ");
    expect(shortTitle("Language A1", "Language")).toBe("Language A1");
    expect(shortTitle("A1", "")).toBe("A1");
  });
  test("names are joined and cut after four", () => {
    expect(namesLine(["A1", "A2", "B1–B2"])).toBe(dots("A1", "A2", "B1–B2"));
    expect(namesLine(["a", "b", "c", "d", "e"])).toBe(dots("a", "b", "c", "d", "…"));
    expect(namesLine([])).toBe("");
  });
  test("a folder's own title is not repeated under itself, a prompt or a bank title keeps the folder", () => {
    const chain = ["University", "Faculty", "Degree"];
    expect(pathNames(chain, true)).toBe(dots("University", "Faculty"));
    expect(pathNames(chain, false)).toBe(dots("University", "Faculty", "Degree"));
    expect(pathNames(["Only"], true)).toBe("");
    expect(pathNames([], false)).toBe("");
  });
});

/** u → f → d → (s1 | s2); s1 holds one subject, s2 a group and a subject. */
const chainFor = (...ids: string[]) => ids.map((id) => tree[id]!);
const tree: Record<string, NodeManifest> = {
  u: manifest("u", ["f"]),
  f: manifest("f", ["d"]),
  d: manifest("d", ["s1", "s2"]),
  s1: manifest("s1", [], ["one"]),
  s2: manifest("s2", ["g"], ["two"]),
  g: manifest("g", [], ["a1", "a2"]),
};

describe("stations of a chain", () => {
  test("a folder is a fork when it was picked among several", () => {
    const stations = stationsOf([node("u")], chainFor("u", "f", "d", "s2"));
    expect(stations.map((s) => s.fork)).toEqual([false, false, false, true]);
    expect(stations.map((s) => s.parent)).toEqual(["", "u", "f", "d"]);
  });
  test("with several roots the first folder is a fork whose neighbours are on the root list", () => {
    const stations = stationsOf([node("u"), node("v")], chainFor("u"));
    expect(stations[0]).toMatchObject({ fork: true, parent: "" });
  });
  test("the change link leads to the nearest choice, and does not exist without one", () => {
    expect(changeTarget(stationsOf([node("u")], chainFor("u", "f", "d", "s2")))).toBe("d");
    expect(changeTarget(stationsOf([node("u")], chainFor("u", "f", "d", "s2", "g")))).toBe("s2");
    expect(changeTarget(stationsOf([node("u")], chainFor("u", "f", "d")))).toBeUndefined();
    expect(changeTarget(stationsOf([node("u"), node("v")], chainFor("u", "f")))).toBe("");
  });
});

describe("page above a bank", () => {
  test("is the nearest folder with more than one entry", () => {
    expect(pageAbove(chainFor("u", "f", "d", "s2", "g"))).toBe("g");
    expect(pageAbove(chainFor("u", "f", "d", "s1"))).toBe("d");
  });
  test("is the root list when nothing on the way is a choice", () => {
    expect(pageAbove(chainFor("u", "f"))).toBe("");
  });
});

describe("where the way in leads", () => {
  const year = manifest("y", ["s1", "s2"]);
  test("a place that holds several entries is the home itself", () => {
    expect(homeOf([manifest("r", ["y"]), year], "y")).toEqual({ type: "node", id: "y" });
  });
  test("single folders are followed down the chain to the first choice", () => {
    const chain = [manifest("r", ["y"]), manifest("y", ["s"]), manifest("s", ["a", "b"])];
    expect(homeOf(chain, "r")).toEqual({ type: "node", id: "s" });
  });
  test("a folder that holds one bank leads to that bank", () => {
    expect(homeOf([manifest("r", ["s"]), manifest("s", [], ["b"])], "r")).toEqual({ type: "bank", node: "s", id: "b" });
  });
  test("a place missing from the chain, or a single folder not on it, stays where it is", () => {
    expect(homeOf([manifest("r", ["y"])], "z")).toEqual({ type: "node", id: "z" });
    expect(homeOf([manifest("r", ["y"])], "r")).toEqual({ type: "node", id: "r" });
  });
});

describe("shared kind", () => {
  const nodes = (...kinds: string[]): Entry[] => kinds.map((k, i) => ({ type: "node", ref: node(`n${i}`, k) }));
  test("is the kind of folders that are all alike", () => {
    expect(sharedKind(nodes("semester", "semester"))).toBe("semester");
  });
  test("is nothing for mixed folders, banks or an empty list", () => {
    expect(sharedKind(nodes("semester", "year"))).toBeUndefined();
    expect(sharedKind([...nodes("semester"), { type: "bank", ref: bank("b") }])).toBeUndefined();
    expect(sharedKind([])).toBeUndefined();
  });
});

describe("isProgressEvent", () => {
  const attempt = { id: "a", type: "attempt", at: 1, bank: "b", question: 3, correct: true, mode: "typed" };

  test("takes the three kinds of event", () => {
    expect(isProgressEvent(attempt)).toBe(true);
    expect(isProgressEvent({ id: "d", type: "dispute", at: 2, bank: "b", question: 3, attempt: "a" })).toBe(true);
    expect(isProgressEvent({ id: "m", type: "bookmark", at: 3, bank: "b", question: 3, value: false })).toBe(true);
  });

  test("turns away what the log cannot hold", () => {
    expect(isProgressEvent(null)).toBe(false);
    expect(isProgressEvent({ ...attempt, mode: "voice" })).toBe(false);
    expect(isProgressEvent({ ...attempt, type: "other" })).toBe(false);
    expect(isProgressEvent({ ...attempt, question: "3" })).toBe(false);
    expect(isProgressEvent({ ...attempt, question: 3.5 })).toBe(false);
  });

  test("a time or question that is not a finite number is refused: 1e999 parses to Infinity", () => {
    const parsed = JSON.parse('{"id":"a","type":"attempt","at":1e999,"bank":"b","question":3,"correct":true,"mode":"typed"}');
    expect(parsed.at).toBe(Infinity);
    expect(isProgressEvent(parsed)).toBe(false);
    expect(isProgressEvent({ ...attempt, at: NaN })).toBe(false);
    expect(isProgressEvent({ ...attempt, question: Infinity })).toBe(false);
  });
});

describe("holdExam", () => {
  test("nothing is held when the exam has no answers or is over; a stale address is dropped", () => {
    expect(holdExam(false, "bank", "#/bank?id=a", "#/n/x")).toEqual({ heading: undefined, stay: false });
    expect(holdExam(false, "session", undefined, "#/session")).toEqual({ heading: undefined, stay: false });
  });

  test("leaving an exam with answers stays on it and remembers where the learner was heading", () => {
    expect(holdExam(true, "bank", undefined, "#/bank?node=n&id=a")).toEqual({ heading: "#/bank?node=n&id=a", stay: true });
  });

  test("Back pressed again keeps the first address and still stays, so no number of presses reaches the end of the history", () => {
    const first = holdExam(true, "bank", undefined, "#/bank?node=n&id=a");
    const again = holdExam(true, "", first.heading, "#/");
    expect(again).toEqual({ heading: "#/bank?node=n&id=a", stay: true });
  });

  test("on the exam itself the remembered address is kept and nothing is pushed", () => {
    expect(holdExam(true, "session", "#/n/x", "#/session")).toEqual({ heading: "#/n/x", stay: false });
  });
});

describe("wiping the device", () => {
  const table = (rows: string[]) => ({ rows, clear: async () => void rows.splice(0) });
  const storage = (entries: Record<string, string>) => {
    const map = new Map(Object.entries(entries));
    return { map, removeItem: (key: string) => void map.delete(key) };
  };

  test("empties every table and removes the app's own keys", async () => {
    const log = table(["attempt-1", "bookmark-2"]);
    const banks = table(["index", "banks/abc"]);
    const local = storage({ [KEYS.settings]: "{}", [KEYS.place]: "uni/sem-1", [KEYS.device]: "id" });
    await wipe([log, banks], local);
    expect(log.rows).toEqual([]);
    expect(banks.rows).toEqual([]);
    expect([...local.map.keys()]).toEqual([]);
  });

  test("leaves keys of another site on the same origin alone", async () => {
    const local = storage({ [KEYS.place]: "uni/sem-1", "other-site": "kept" });
    await wipe([], local);
    expect(Object.fromEntries(local.map)).toEqual({ "other-site": "kept" });
  });

  test("a table that cannot be cleared fails the wipe, so the app does not restart as if it had worked", async () => {
    const broken = { clear: () => Promise.reject(new Error("blocked")) };
    await expect(wipe([broken], storage({}))).rejects.toThrow("blocked");
  });
});

describe("what the result counts as shown", () => {
  const right = { correct: true, score: 1 } as SessionItem["graded"];
  const wrong = { correct: false, score: 0 } as SessionItem["graded"];
  const item = (question: number, graded?: SessionItem["graded"], again?: number): SessionItem => ({ question, mode: "choice", graded, again });
  const session = (kind: "practice" | "exam", items: SessionItem[], index: number) => ({ config: { kind } as Session["config"], items, index });
  const ids = (items: SessionItem[]) => items.map((i) => `${i.question}${i.again ? "'" : ""}`);

  test("practice left early counts the questions answered or skipped, not the open one or the ones never shown", () => {
    // 1 right, 2 skipped, 3 open when the student finished, 4 and 5 never shown
    const s = session("practice", [item(1, right), item(2), item(3), item(4), item(5)], 2);
    expect(ids(shown(s))).toEqual(["1", "2"]);
  });

  test("a repeat queued after a miss but not reached is not counted", () => {
    // 1 missed and queued again after 3; the student finished on 3
    const s = session("practice", [item(1, wrong), item(2, right), item(3), item(1, undefined, 1)], 2);
    expect(ids(shown(s))).toEqual(["1", "2"]);
  });

  test("practice finished before the first answer shows nothing", () => {
    expect(shown(session("practice", [item(1), item(2)], 0))).toEqual([]);
  });

  test("an exam counts every question, unanswered ones included", () => {
    const s = session("exam", [item(1, right), item(2), item(3)], 0);
    expect(ids(shown(s))).toEqual(["1", "2", "3"]);
  });
});
