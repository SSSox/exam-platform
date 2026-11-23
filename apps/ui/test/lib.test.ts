import { describe, expect, test } from "vitest";
import { examHistory, learn, type BankRef, type ContentIndex, type Entry, type NodeManifest, type NodeRef, type ProgressEvent, type QuestionState, type Session, type SessionItem } from "@exam/core";
import { KEYS, STATIONS, addMissing, putEvents, shortDate, awaitsRepeat, bankProgress, changeTarget, homeOf, holdExam, showContent, isProgressEvent, lineOf, namesLine, pageAbove, pathNames, putBackAt, sharedKind, shiftFrom, shown, shortTitle, stationsOf, wipe } from "../src/lib.ts";

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

  test("a time a date cannot hold is refused, the ends of the range are kept", () => {
    expect(isProgressEvent({ ...attempt, at: 8.64e15 + 1 })).toBe(false);
    expect(isProgressEvent({ ...attempt, at: 1e300 })).toBe(false);
    expect(isProgressEvent({ ...attempt, at: -1 })).toBe(false);
    expect(isProgressEvent({ ...attempt, at: "1" })).toBe(false);
    expect(isProgressEvent({ ...attempt, at: 8.64e15 })).toBe(true);
    expect(isProgressEvent({ ...attempt, at: 0 })).toBe(true);
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

  test("practice finished from a question gone back to still counts the ones skipped before the last answer", () => {
    // 1 right, 2 skipped, 3 right; the student went back to 1 and finished there
    const s = session("practice", [item(1, right), item(2), item(3, right), item(4)], 0);
    expect(ids(shown(s))).toEqual(["1", "2", "3"]);
  });
});

describe("going back in practice", () => {
  const right = { correct: true, score: 1 } as SessionItem["graded"];
  const wrong = { correct: false, score: 0 } as SessionItem["graded"];
  const item = (question: number, graded?: SessionItem["graded"], again?: number): SessionItem => ({ question, mode: "choice", graded, again });
  const practice = (items: SessionItem[]) => ({ config: { kind: "practice" } as Session["config"], items });

  test("a missed question keeps its answer hidden while its repeat is still ahead", () => {
    const s = practice([item(1, wrong), item(2, right), item(3), item(1, undefined, 1)]);
    expect(awaitsRepeat(s, 0)).toBe(true);
    expect(awaitsRepeat(s, 1)).toBe(false);
    expect(awaitsRepeat(s, 2)).toBe(false);
  });

  test("a right repeat with one more still queued keeps both earlier answers hidden; answering it opens them", () => {
    const queued = practice([item(1, wrong), item(2, right), item(1, right, 1), item(3), item(1, undefined, 2)]);
    expect([0, 2].map((k) => awaitsRepeat(queued, k))).toEqual([true, true]);
    const answered = practice(queued.items.with(4, item(1, right, 2)));
    expect([0, 2, 4].map((k) => awaitsRepeat(answered, k))).toEqual([false, false, false]);
  });

  test("an exam never hides an answer", () => {
    const s = { config: { kind: "exam" } as Session["config"], items: [item(1, wrong), item(1)] };
    expect(awaitsRepeat(s, 0)).toBe(false);
  });

  test("what the screen keeps by position follows its question when a repeat is put back before it", () => {
    const before = { items: [item(1), item(2), item(3), item(4)], index: 0 };
    const after = { items: [{ ...before.items[0]!, graded: wrong }, before.items[1]!, item(1, undefined, 1), before.items[2]!, before.items[3]!] };
    expect(putBackAt(before, after)).toBe(2);
    expect(putBackAt(before, { items: after.items.toSpliced(2, 1) })).toBe(-1);
    expect(shiftFrom({ 1: "b", 2: "c", 3: "d" }, 2)).toEqual({ 1: "b", 3: "c", 4: "d" });
    expect(shiftFrom({ 1: "b" }, -1)).toEqual({ 1: "b" });
  });
});

describe("showContent", () => {
  const idx = (version: string) => ({ format: "exambank/2", version, kinds: {}, roots: [] }) as ContentIndex;
  const empty = { offline: false };

  test("the stored index is shown at once and does not say offline", () => {
    const a = idx("a");
    expect(showContent(empty, { stored: a })).toEqual({ index: a, offline: false });
  });

  test("a stored index that comes after the network answer, or nothing stored, changes nothing", () => {
    const now = { index: idx("new"), offline: false };
    expect(showContent(now, { stored: idx("old") })).toBe(now);
    expect(showContent(empty, { stored: undefined })).toBe(empty);
  });

  test("a stored index that comes after a failure is shown as offline and clears the error", () => {
    const a = idx("a");
    expect(showContent({ offline: false, error: new Error("x") }, { stored: a })).toEqual({ index: a, offline: true });
  });

  test("a fresh index of the same version keeps the same object", () => {
    const a = idx("a");
    const now = { index: a, offline: false };
    expect(showContent(now, { fresh: idx("a"), offline: false })).toBe(now);
    expect(showContent(now, { fresh: idx("a"), offline: true }).index).toBe(a);
    expect(showContent(now, { fresh: idx("a"), offline: true }).offline).toBe(true);
  });

  test("a fresh index of another version replaces the shown one at once", () => {
    const b = idx("b");
    expect(showContent({ index: idx("a"), offline: true }, { fresh: b, offline: false })).toEqual({ index: b, offline: false });
    expect(showContent(empty, { fresh: b, offline: false }).index).toBe(b);
  });

  test("a fresh index clears an error", () => {
    const a = idx("a");
    expect(showContent({ index: a, offline: false, error: 1 }, { fresh: a, offline: false })).toEqual({ index: a, offline: false });
  });

  test("a failure keeps the shown index and says offline; without one it is an error", () => {
    const a = idx("a");
    expect(showContent({ index: a, offline: false }, { failed: new Error("x") })).toEqual({ index: a, offline: true });
    const error = new Error("x");
    expect(showContent(empty, { failed: error })).toEqual({ offline: false, error });
  });
});

describe("addMissing", () => {
  const event = (id: string, at: number) => ({ id, type: "bookmark", at, device: "d", bank: "b", question: 1, value: true }) as ProgressEvent;
  const table = (stored: ProgressEvent[]) => {
    const rows = new Map(stored.map((e) => [e.id, e]));
    return {
      rows,
      bulkGet: async (keys: string[]) => keys.map((k) => rows.get(k)),
      bulkAdd: async (items: ProgressEvent[]) => {
        for (const e of items) {
          if (rows.has(e.id)) throw new Error("ConstraintError");
          rows.set(e.id, e);
        }
      },
    };
  };

  test("a stored record is never overwritten; only new ids are added, the stored ones are returned", async () => {
    const kept = event("a", 1);
    const t = table([kept]);
    const { added, existing } = await addMissing(t, [event("a", 99), event("b", 2)]);
    expect(added.map((e) => e.id)).toEqual(["b"]);
    expect(existing).toEqual([kept]);
    expect(t.rows.get("a")).toBe(kept);
    expect([...t.rows.keys()]).toEqual(["a", "b"]);
  });

  test("an answer that is in memory but not yet in the table is written", async () => {
    const t = table([]);
    const unwritten = event("u", 3);
    expect(await addMissing(t, [unwritten])).toEqual({ added: [unwritten], existing: [] });
    expect(t.rows.get("u")).toBe(unwritten);
  });

  test("an id repeated in one batch is added once, the first one wins", async () => {
    const t = table([]);
    const first = event("a", 1);
    await addMissing(t, [first, event("a", 2)]);
    expect(t.rows.get("a")).toBe(first);
  });
});

describe("putEvents", () => {
  const answer = (id: string, correct: boolean) => ({ id, type: "attempt", at: 1, device: "d", bank: "b", question: 1, rev: "r", mode: "typed", correct, score: correct ? 1 : 0, matchKind: "exact", response: { mode: "typed", texts: [correct ? "x" : "y"] }, locale: "ru", session: "s", ms: 5 }) as ProgressEvent;
  /** A database that hands back copies, as IndexedDB does, and can be made to fail. */
  const database = (stored: ProgressEvent[] = []) => {
    const rows = new Map(stored.map((e) => [e.id, structuredClone(e)]));
    const db = {
      rows,
      down: false,
      save: (events: ProgressEvent[]) => {
        if (db.down) return Promise.reject(new Error("QuotaExceededError"));
        return addMissing({
          bulkGet: async (keys) => keys.map((k) => (rows.has(k) ? structuredClone(rows.get(k)!) : undefined)),
          bulkAdd: async (items) => void items.forEach((e) => rows.set(e.id, structuredClone(e))),
        }, events);
      },
    };
    return db;
  };
  const memory = (events: ProgressEvent[] = []) => {
    const m = { events, get: () => m.events, set: (next: ProgressEvent[]) => void (m.events = next) };
    return m;
  };

  test("an answer whose first write failed keeps its id against an edited file, and the retry lets it go only once stored", async () => {
    const db = database();
    const log = memory();
    const real = answer("a", false);
    db.down = true;
    expect(await putEvents(log, [real], db.save)).toMatchObject({ saved: false, holds: false });
    db.down = false;
    // The edited file arrives before the retry: what is written under the id is the answer, not the file's copy.
    const forged = answer("a", true);
    await putEvents(log, [forged], db.save);
    expect(db.rows.get("a")).toEqual(real);
    expect(log.events).toEqual([real]);
    expect(await putEvents(log, [real], db.save)).toEqual({ count: 0, saved: true, holds: true });
  });

  test("a pending answer is not let go when the database holds another event under its id", async () => {
    const db = database([answer("a", true)]);
    const real = answer("a", false);
    const log = memory([real]);
    expect(await putEvents(log, [real], db.save)).toMatchObject({ saved: true, holds: false });
  });

  test("an import gives way to a stored row the log in memory does not have yet, and counts only the rows it added", async () => {
    const stored = answer("a", false);
    const db = database([stored]);
    const log = memory();
    const result = await putEvents(log, [answer("a", true), answer("b", true)], db.save);
    expect(result).toEqual({ count: 1, saved: true, holds: false });
    expect(db.rows.get("a")).toEqual(stored);
    expect(log.events.find((e) => e.id === "a")).toEqual(stored);
    expect(log.events.map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("without a database the events stay in memory and count as new", async () => {
    const db = database();
    db.down = true;
    const log = memory();
    expect(await putEvents(log, [answer("a", true)], db.save)).toEqual({ count: 1, saved: false, holds: false });
    expect(log.events).toHaveLength(1);
  });
});

describe("shortDate", () => {
  const now = new Date(2026, 5, 1, 12).getTime();

  test("a mock exam already stored with a time a date cannot hold shows a dash instead of throwing", () => {
    const at = 8.64e15 + 1;
    const log = [{ id: "a", type: "attempt", at, device: "d", bank: "b", question: 1, rev: "r", mode: "choice", correct: true, score: 1, matchKind: "exact", response: { mode: "choice", selected: ["a"] }, locale: "ru", session: "s", ms: 1, exam: true, of: 1 }] as ProgressEvent[];
    const [h] = examHistory(log, "b");
    expect(h!.at).toBe(at);
    expect(() => new Intl.DateTimeFormat("ru", { day: "numeric" }).format(at)).toThrow(RangeError);
    expect(shortDate(h!.at, now, "ru")).toBe("—");
    expect(shortDate(-1, now, "en")).toBe("—");
    expect(shortDate(NaN, now, "en")).toBe("—");
  });

  test("the year is shown only when it is not this one", () => {
    expect(shortDate(new Date(2026, 2, 5, 12).getTime(), now, "en")).toBe("Mar 5");
    expect(shortDate(new Date(2024, 2, 5, 12).getTime(), now, "en")).toBe("Mar 5, 2024");
  });
});
