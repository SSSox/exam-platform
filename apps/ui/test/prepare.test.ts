import { describe, expect, test } from "vitest";
import { Question } from "@exam/schema";
import { attemptEvent, createSession, finish, isDue, learn, project, submit, type ProgressEvent, type QuestionState } from "@exam/core";
import {
  KEYS, backupDue, buildSession, dueCount, examProfile, findQuestions, fitSetup, isFirefox, isProgressEvent, mistakeIds, parseSetups, plainText as stripped, scaleShares, searchable, sessionKey, setupOf,
  stepAsync, storeSetup, toggleChoice, givenLines, type Setup,
} from "../src/lib.ts";

const q = (data: unknown) => Question.parse(data);
const choice = (id: number, topic: number, extra: object = {}) => q({
  id, topic_id: topic, type: "single_choice", question: `Question ${id}`,
  options: [{ id: "A", text: "first" }, { id: "B", text: "second" }], correct_answers: ["A"], ...extra,
});
const open = (id: number) => q({ id, topic_id: 1, type: "open", question: `Open ${id}`, model_answer: "x" });
const state = (patch: Partial<QuestionState> = {}): QuestionState => ({ modes: {}, bookmarked: false, ...patch });
const plain = (id: string): Setup => ({ scope: "smart", answerMode: "choice", kind: "practice", topics: [], level: 0, count: 20, minutes: 20 });
const T0 = 1_700_000_000_000;

describe("buildSession", () => {
  const questions = [choice(1, 1), choice(2, 1), choice(3, 2, { difficulty_level: 2 }), choice(4, 2, { retired: true }), open(5)];
  const input = (setup: Partial<Setup>, more: object = {}) => ({
    bankId: "b", questions, states: new Map<number, QuestionState>(), stats: { mistakes: [], bookmarks: [] }, setup: { ...plain("b"), ...setup },
    unsupported: "skip" as const, now: T0, seed: 7, id: "s1", ...more,
  });

  test("smart: a planned order, retired questions left out", () => {
    const s = buildSession(input({}))!;
    expect(s.config).toMatchObject({ kind: "practice", keepOrder: true, relearn: true });
    // A question with no options keeps its only mode, as in createSession.
    expect(s.items.map((i) => i.question).sort()).toEqual([1, 2, 3, 5]);
    expect(s.items.find((i) => i.question === 5)!.mode).toBe("self_check");
  });

  test("smart with a typed mode and \"skip\" draws only questions that can be typed", () => {
    expect(buildSession(input({ answerMode: "typed" }))).toBeUndefined();
    expect(buildSession(input({ answerMode: "self_check" }))!.items).toHaveLength(4);
  });

  test("smart honours topics, level and count", () => {
    expect(buildSession(input({ topics: [2] }))!.items.map((i) => i.question)).toEqual([3]);
    expect(buildSession(input({ level: 2 }))!.items.map((i) => i.question)).toEqual([3]);
    expect(buildSession(input({ count: 2 }))!.items).toHaveLength(2);
  });

  test("all: every active question that fits, shuffled, not planned", () => {
    const s = buildSession(input({ scope: "all", count: 0 }))!;
    expect(s.config.keepOrder).toBe(false);
    expect(s.items).toHaveLength(4);
  });

  test("mistakes with none gives nothing; with some, only those", () => {
    expect(buildSession(input({ scope: "mistakes" }))).toBeUndefined();
    const s = buildSession(input({ scope: "mistakes" }, { stats: { mistakes: [2], bookmarks: [] } }))!;
    expect(s.items.map((i) => i.question)).toEqual([2]);
  });

  test("a topic that holds nothing gives nothing", () => {
    expect(buildSession(input({ topics: [99] }))).toBeUndefined();
  });

  test("exam: no smart pick, a time limit and a pass mark", () => {
    const s = buildSession(input({ kind: "exam", scope: "smart", minutes: 30, count: 0 }))!;
    expect(s.config).toMatchObject({ kind: "exam", timeLimitSec: 1800, passPercent: 50, keepOrder: false, relearn: false });
    expect(s.items).toHaveLength(4);
    expect(buildSession(input({ kind: "exam", minutes: 0 }))!.config.timeLimitSec).toBeUndefined();
  });

  test("only: one practice session on exactly those questions, in the nearest mode", () => {
    const s = buildSession(input({ kind: "exam", topics: [2], level: 3 }, { only: [5, 1] }))!;
    expect(s.config).toMatchObject({ kind: "practice", unsupported: "self_check", count: 2, relearn: true });
    expect(s.items.map((i) => [i.question, i.mode]).sort()).toEqual([[1, "choice"], [5, "self_check"]]);
    expect(buildSession(input({}, { only: [] }))).toBeUndefined();
  });
});

describe("exam by levels", () => {
  // Levels 1..4 hold 20, 15, 10 and 6 questions; ids run level by level from 1.
  const sizes: [number, number][] = [[1, 20], [2, 15], [3, 10], [4, 6]];
  let next = 1;
  const questions = sizes.flatMap(([level, n]) => Array.from({ length: n }, () => choice(next++, 1, { difficulty_level: level })));
  const levelOf = new Map(questions.map((x) => [x.id, x.difficulty_level]));
  const shares = [{ level: 1, count: 16 }, { level: 2, count: 12 }, { level: 3, count: 8 }, { level: 4, count: 4 }];
  const exam = (setup: Partial<Setup>, qs = questions, seed = 7) => buildSession({
    bankId: "b", questions: qs, states: new Map(), stats: { mistakes: [], bookmarks: [] }, unsupported: "skip", now: T0, seed, id: "s",
    setup: { ...plain("b"), kind: "exam", scope: "all", count: 40, levels: shares, ...setup },
  })!;
  const perLevel = (s: { items: { question: number }[] }) => [1, 2, 3, 4].map((l) => s.items.filter((i) => levelOf.get(i.question) === l).length);

  test("scaleShares: exact, proportional, always adds up", () => {
    expect(scaleShares(shares, 40)).toEqual(shares);
    expect(scaleShares(shares, 10).map((s) => s.count)).toEqual([4, 3, 2, 1]);
    expect(scaleShares(shares, 3).reduce((a, s) => a + s.count, 0)).toBe(3);
    for (let n = 1; n < 60; n++) expect(scaleShares(shares, n).reduce((a, s) => a + s.count, 0)).toBe(n);
    expect(scaleShares(shares, 0)).toEqual([]);
  });

  test("takes each level's number of questions", () => {
    expect(perLevel(exam({}))).toEqual([16, 12, 8, 4]);
    expect(perLevel(exam({ count: 10 }))).toEqual([4, 3, 2, 1]);
  });

  test("tops up from the other levels when one is short", () => {
    const few = questions.filter((x) => x.difficulty_level !== 4 || x.id % 2);
    const s = exam({}, few);
    expect(s.items).toHaveLength(40);
    expect(new Set(s.items.map((i) => i.question)).size).toBe(40);
    expect(perLevel(s)[3]).toBe(3);
    expect(perLevel(exam({ count: 40 }, questions.filter((x) => x.difficulty_level === 1))).slice(1)).toEqual([0, 0, 0]);
  });

  test("the same seed gives the same questions in the same order", () => {
    const ids = (seed: number) => exam({}, questions, seed).items.map((i) => i.question);
    expect(ids(5)).toEqual(ids(5));
    expect(ids(5)).not.toEqual(ids(6));
    // Not grouped by level: the order is shuffled.
    expect(perLevel({ items: ids(5).slice(0, 16).map((question) => ({ question })) })).not.toEqual([16, 0, 0, 0]);
  });

  test("shares apply only to an exam with any difficulty", () => {
    const base = exam({ levels: undefined }).items.map((i) => i.question);
    expect(exam({ level: 2 }).items.every((i) => levelOf.get(i.question) === 2)).toBe(true);
    expect(buildSession({ ...{ bankId: "b", questions, states: new Map(), stats: { mistakes: [], bookmarks: [] }, unsupported: "skip" as const, now: T0, seed: 7, id: "s" }, setup: { ...plain("b"), scope: "all", count: 40, levels: shares } })!.config.kind).toBe("practice");
    // Without shares an exam keeps the old order.
    expect(exam({ levels: undefined }).items.map((i) => i.question)).toEqual(base);
    expect(base).toHaveLength(40);
  });

  test("profile: per_test is read, bank_share and junk are not", () => {
    const base = { duration_minutes: 90, test_question_count: 40 };
    const rec = (level: number, per_test: number) => ({ level, bank_required: 120, per_test });
    expect(examProfile({ ...base, official_levels: [rec(1, 16), rec(2, 12), rec(3, 8), rec(4, 4)] })).toEqual({ minutes: 90, count: 40, levels: shares });
    for (const official_levels of [[{ level: 1, bank_share: 0.4 }], [rec(1, 16), { level: 2, bank_share: 0.3 }], [rec(1, 1.5)], [rec(1, -1)], [rec(1.5, 3)], [rec(1, 0)], [], "x", {}, [null], [1], [{ level: "1", per_test: 2 }]]) {
      expect(examProfile({ ...base, official_levels })).toEqual({ minutes: 90, count: 40 });
    }
  });

  test("a level listed twice counts once with both numbers, so the exam keeps its full size", () => {
    const base = { duration_minutes: 90, test_question_count: 40 };
    const twice = examProfile({ ...base, official_levels: [{ level: 1, per_test: 16 }, { level: 2, per_test: 20 }, { level: 1, per_test: 4 }] });
    expect(twice?.levels).toEqual([{ level: 1, count: 20 }, { level: 2, count: 20 }]);
    // A stored setup with a repeated level is not taken as shares.
    const stored = { scope: "all", answerMode: "choice", kind: "exam", topics: [], level: 0, count: 5, minutes: 10, levels: [{ level: 1, count: 2 }, { level: 1, count: 3 }] };
    const read = parseSetups(JSON.stringify({ b: stored })).b;
    expect(read?.count).toBe(5);
    expect(read?.levels).toBeUndefined();
  });

  test("an old setup without shares still reads; bad shares are dropped, the rest stays", () => {
    const good = { ...plain("x") };
    const raw = JSON.stringify([["a", good], ["b", { ...good, levels: shares }], ["c", { ...good, levels: [{ level: "x" }] }], ["d", { ...good, levels: "no" }]]);
    const all = parseSetups(raw);
    expect(all.a).toEqual(good);
    expect(all.b).toEqual({ ...good, levels: shares });
    expect(all.c).toEqual(good);
    expect(all.d).toEqual(good);
    expect("levels" in all.c!).toBe(false);
  });

  test("fitSetup drops shares of levels the bank does not have", () => {
    const facts = { topicIds: [1], levels: [1, 2], mistakes: 0, bookmarks: 0, questions: 100 };
    expect(fitSetup({ ...plain("x"), levels: shares }, facts).levels).toEqual([{ level: 1, count: 16 }, { level: 2, count: 12 }]);
    expect("levels" in fitSetup({ ...plain("x"), levels: shares }, { ...facts, levels: [] })).toBe(false);
  });
});

describe("remembered setup", () => {
  const facts = { topicIds: [1, 2], levels: [1, 2], mistakes: 3, bookmarks: 1, questions: 40 };
  const saved = (patch: Partial<Setup>): Setup => ({ ...plain("x"), ...patch });

  test("the data key is cleared with the rest", () => {
    expect(KEYS.setup).toBe("setup");
    expect(KEYS.backup).toBe("backup");
  });

  test("nothing saved gives the default", () => {
    expect(fitSetup(undefined, facts)).toEqual({ scope: "smart", answerMode: "choice", kind: "practice", topics: [], level: 0, count: 20, minutes: 20 });
  });

  test("a valid setup stays as it is", () => {
    const s = saved({ scope: "mistakes", answerMode: "typed", topics: [2], level: 1, count: 10, minutes: 45 });
    expect(fitSetup(s, facts)).toEqual(s);
  });

  test("unknown topics and levels go", () => {
    expect(fitSetup(saved({ topics: [2, 9], level: 5 }), facts)).toMatchObject({ topics: [2], level: 0 });
  });

  test("a list with nothing in it falls back to smart, or to all for an exam", () => {
    const none = { ...facts, mistakes: 0, bookmarks: 0 };
    expect(fitSetup(saved({ scope: "mistakes" }), none).scope).toBe("smart");
    expect(fitSetup(saved({ scope: "bookmarks" }), none).scope).toBe("smart");
    expect(fitSetup(saved({ scope: "bookmarks", kind: "exam" }), none).scope).toBe("all");
    expect(fitSetup(saved({ scope: "mistakes", kind: "exam" }), facts).scope).toBe("mistakes");
  });

  test("an exam cannot be smart", () => {
    expect(fitSetup(saved({ kind: "exam", scope: "smart" }), facts).scope).toBe("all");
  });

  test("numbers are clamped and whole", () => {
    expect(fitSetup(saved({ count: 500 }), facts).count).toBe(40);
    expect(fitSetup(saved({ count: -3, minutes: -1 }), facts)).toMatchObject({ count: 0, minutes: 0 });
    expect(fitSetup(saved({ count: 7.6, minutes: 12.4 }), facts)).toMatchObject({ count: 8, minutes: 12 });
    expect(fitSetup(saved({ count: Number.NaN, minutes: Infinity }), facts)).toMatchObject({ count: 0, minutes: 0 });
  });

  test("parseSetups never throws and drops what is not well-formed", () => {
    for (const raw of [null, undefined, "", "{", "5", "null", '"x"', "[1,2]"]) expect(parseSetups(raw)).toEqual({});
    const good = saved({ topics: [1] });
    const raw = JSON.stringify([["a", good], ["b", { ...good, scope: "nope" }], ["c", { ...good, topics: ["x"] }], ["d", { ...good, count: "5" }], [1, good], "junk"]);
    expect(parseSetups(raw)).toEqual({ a: good });
    expect(parseSetups(JSON.stringify({ a: good, b: null }))).toEqual({ a: good });
    expect(Object.keys(parseSetups(JSON.stringify([["__proto__", good]])))).toEqual(["__proto__"]);
  });

  test("storeSetup puts the bank last and keeps the most recent banks", () => {
    let raw = storeSetup(null, "a", saved({ count: 1 }));
    raw = storeSetup(raw, "b", saved({ count: 2 }));
    raw = storeSetup(raw, "a", saved({ count: 3 }));
    expect(Object.keys(parseSetups(raw))).toEqual(["b", "a"]);
    expect(parseSetups(raw).a!.count).toBe(3);
    for (let i = 0; i < 5; i++) raw = storeSetup(raw, `x${i}`, saved({}), 3);
    expect(Object.keys(parseSetups(raw))).toEqual(["x2", "x3", "x4"]);
  });

  test("storeSetup repairs a broken value and keeps the order of bank ids that look like numbers", () => {
    expect(Object.keys(parseSetups(storeSetup("{", "a", saved({}))))).toEqual(["a"]);
    let raw = storeSetup(null, "10", saved({}));
    raw = storeSetup(raw, "2", saved({}));
    raw = storeSetup(raw, "30", saved({}), 2);
    expect(JSON.parse(raw).map((p: unknown[]) => p[0])).toEqual(["2", "30"]);
  });
});

describe("examProfile", () => {
  test("reads minutes and count when both are positive whole numbers", () => {
    expect(examProfile({ duration_minutes: 60, test_question_count: 50, other: 1 })).toEqual({ minutes: 60, count: 50 });
  });
  test("anything else gives nothing", () => {
    for (const exam of [undefined, null, "x", [], {}, { duration_minutes: null, test_question_count: 50 }, { duration_minutes: "60", test_question_count: 50 },
      { duration_minutes: 60 }, { duration_minutes: 0, test_question_count: 5 }, { duration_minutes: 60, test_question_count: -1 }, { duration_minutes: 1.5, test_question_count: 5 },
      { duration_minutes: Infinity, test_question_count: 5 }]) expect(examProfile(exam)).toBeUndefined();
  });
});

describe("dueCount", () => {
  const seen = (at: number): QuestionState => state({ lastAt: at, memory: learn(undefined, at, "choice", true) });
  test("counts the seen questions whose time has come", () => {
    const fresh = seen(T0);
    const later = fresh.memory!.due + 1;
    const states = new Map([[1, fresh], [2, state()], [3, seen(later)]]);
    expect(isDue(fresh.memory, later)).toBe(true);
    expect(dueCount(states, later)).toBe(1);
    expect(dueCount(states, T0)).toBe(0);
  });
  test("withdrawn questions are left out", () => {
    const a = seen(T0);
    const states = new Map([[1, a], [2, seen(T0)]]);
    const now = a.memory!.due + 1;
    expect(dueCount(states, now)).toBe(2);
    expect(dueCount(states, now, [2])).toBe(1);
  });
  test("a state with a memory but no time is not counted", () => {
    expect(dueCount(new Map([[1, state({ memory: learn(undefined, T0, "choice", true) })]]), T0 + 1e12)).toBe(0);
  });
});

describe("findQuestions", () => {
  const plainText = (v: unknown) => (typeof v === "string" ? v : v ? Object.values(v as Record<string, string>)[0]! : "");
  const kz = [
    q({ id: 1, topic_id: 1, type: "single_choice", question: "Әлемдегі ең терең көл қайсы?", options: [{ id: "A", text: "Байкал" }, { id: "B", text: "Балқаш" }], correct_answers: ["A"] }),
    q({ id: 2, topic_id: 2, type: "single_choice", question: "ҒҚҢӨҰҮҺІ әріптері", options: [{ id: "A", text: "қазақ" }, { id: "B", text: "орыс" }], correct_answers: ["A"] }),
    q({ id: 3, topic_id: 2, type: "single_choice", question: "Столица Казахстана", options: [{ id: "A", text: "Астана" }, { id: "B", text: "Алматы" }], correct_answers: ["A"] }),
    q({ id: 12, topic_id: 3, type: "open", question: "Сравните понятия", model_answer: "ответ Байкал" }),
    q({ id: 7, topic_id: 3, type: "single_choice", question: "Retired Байкал", options: [{ id: "A", text: "a" }, { id: "B", text: "b" }], correct_answers: ["A"], retired: true }),
  ];
  const ids = (query: string, limit?: number) => findQuestions(kz, query, plainText, limit).map((r) => r.id);

  test("short queries find nothing", () => {
    expect(ids("")).toEqual([]);
    expect(ids("а")).toEqual([]);
    expect(ids("  ")).toEqual([]);
  });
  test("a number is searched from one digit, text from two characters", () => {
    expect(searchable("5")).toBe(true);
    expect(searchable(" 12 ")).toBe(true);
    expect(searchable("а")).toBe(false);
    expect(searchable("a5")).toBe(true);
    expect(searchable("5 ")).toBe(true);
    expect(searchable("")).toBe(false);
  });
  test("a result shows the text without markdown and TeX marks, and the search sees it too", () => {
    const marked = [choice(1, 1, { question: "Найдите **значение** $x^2$ в [таблице](t.png)" })];
    expect(findQuestions(marked, "значение", plainText)[0]!.snippet).toBe("Найдите значение x^2 в таблице");
    expect(findQuestions(marked, "x^2 в таблице", plainText).map((r) => r.id)).toEqual([1]);
    expect(findQuestions(marked, "**", plainText)).toEqual([]);
  });
  test("case-insensitive, Cyrillic and Kazakh letters", () => {
    expect(ids("СТОЛИЦА")).toEqual([3]);
    expect(ids("әлемдегі")).toEqual([1]);
    expect(ids("ӘЛЕМДЕГІ")).toEqual([1]);
    expect(ids("ғқңөұүһі")).toEqual([2]);
    expect(ids("ҒҚҢӨҰҮҺІ")).toEqual([2]);
  });
  test("every word must occur, in the question or in options", () => {
    expect(ids("терең байкал")).toEqual([1]);
    expect(ids("терең астана")).toEqual([]);
    expect(ids("байкал балқаш")).toEqual([1]);
  });
  test("an option alone is enough; an open question has only its text", () => {
    expect(ids("алматы")).toEqual([3]);
    expect(ids("ответ")).toEqual([]);
  });
  test("a number finds the question with that id first, and retired are skipped", () => {
    expect(ids("12")).toEqual([12]);
    const withNumber = [choice(5, 1), q({ id: 9, topic_id: 1, type: "single_choice", question: "Chapter 5 text", options: [{ id: "A", text: "a" }, { id: "B", text: "b" }], correct_answers: ["A"] })];
    // One digit is a question number only: as a word it would match every text that mentions it.
    expect(findQuestions(withNumber, "5", plainText).map((r) => r.id)).toEqual([5]);
    expect(findQuestions(withNumber, "7", plainText)).toEqual([]);
    const many = [...withNumber, choice(55, 1, { question: "see 55 here" })];
    expect(findQuestions(many, "55", plainText).map((r) => r.id)).toEqual([55]);
    expect(ids("7")).toEqual([]);
    expect(ids("retired")).toEqual([]);
  });
  test("the id match comes before text matches", () => {
    const list = [choice(1, 1, { question: "mentions 20 items" }), choice(20, 1)];
    expect(findQuestions(list, "20", plainText).map((r) => r.id)).toEqual([20, 1]);
  });
  test("limit and topic", () => {
    expect(ids("ә", 1)).toEqual([]);
    const list = Array.from({ length: 5 }, (_, i) => choice(i + 1, 4, { question: "common words" }));
    expect(findQuestions(list, "common", plainText, 3)).toHaveLength(3);
    expect(findQuestions(list, "common", plainText)[0]!.topic).toBe(4);
  });
  test("the snippet is the whole short text, or about 120 characters around the match with dots", () => {
    expect(findQuestions(kz, "столица", plainText)[0]!.snippet).toBe("Столица Казахстана");
    const long = `${"начало ".repeat(40)}нужное слово${" конец".repeat(40)}`;
    const [hit] = findQuestions([choice(1, 1, { question: long })], "нужное", plainText);
    expect(hit!.snippet.startsWith("…")).toBe(true);
    expect(hit!.snippet.endsWith("…")).toBe(true);
    expect(hit!.snippet).toContain("нужное слово");
    expect(hit!.snippet.length).toBeLessThanOrEqual(122);
    const [head] = findQuestions([choice(1, 1, { question: `нужное ${"а".repeat(300)}` })], "нужное", plainText);
    expect(head!.snippet.startsWith("…")).toBe(false);
    expect(head!.snippet.endsWith("…")).toBe(true);
  });
  test("a match only in an option shows the start of the question", () => {
    const long = "а".repeat(300);
    const [hit] = findQuestions([choice(1, 1, { question: long, options: [{ id: "A", text: "редкое" }, { id: "B", text: "b" }] })], "редкое", plainText);
    expect(hit!.snippet).toBe(`${"а".repeat(120)}…`);
  });
});

describe("plainText", () => {
  test("marks the renderer would read are removed", () => {
    expect(stripped("$x^2$")).toBe("x^2");
    expect(stripped("$$\\frac{a}{b}$$ и $a_1 + b_2$")).toBe("\\frac{a}{b} и a_1 + b_2");
    expect(stripped("**жирный** и __тоже__")).toBe("жирный и тоже");
    expect(stripped("*курсив* и _тоже_")).toBe("курсив и тоже");
    expect(stripped("~~вычеркнуто~~")).toBe("вычеркнуто");
    expect(stripped("[a](b) и ![рисунок](p.png) и [c](d \"title\")")).toBe("a и рисунок и c");
    expect(stripped("# Заголовок\n### Ещё")).toBe("Заголовок\nЕщё");
    expect(stripped("вызов `f(**x)` и ```py\nprint(1)\n```")).toBe("вызов f(**x) и print(1)");
  });
  test("ordinary text is left alone", () => {
    for (const text of ["snake_case и file_name_here", "a_b_c", "_", "*", "5 * 3", "2*3*4", "цена $5", "$5 и $6", "а $5, б $ 6", "a * b * c", "100%", "C# и #хэштег", "__init__.py", "x_1 и y_2"]) {
      expect(stripped(text), text).toBe(text === "__init__.py" ? "init.py" : text);
    }
  });
  test("marks inside code and formulas are not read as markdown", () => {
    expect(stripped("`a_b_c` $x_1*y*z$ `**`")).toBe("a_b_c x_1*y*z **");
  });
});

describe("mistakes of a result", () => {
  const item = (question: number, graded?: boolean, again?: number) => ({ question, mode: "choice" as const, ...(again ? { again } : {}), ...(graded == null ? {} : { graded: { correct: graded, score: graded ? 1 : 0 } }) });
  const session = (kind: "exam" | "practice", items: ReturnType<typeof item>[], index: number) => ({
    id: "s", bank: "b", index, startedAt: 0, shownAt: 0, items, config: { kind, answerMode: "choice", unsupported: "skip", shuffle: false, seed: 1 },
  }) as unknown as Parameters<typeof mistakeIds>[0];
  test("an exam counts the wrong answers and the unanswered questions", () => {
    expect(mistakeIds(session("exam", [item(1, true), item(2, false), item(3), item(4, false)], 3))).toEqual([2, 3, 4]);
  });
  test("practice counts only what was answered wrong; repeats are not first showings", () => {
    expect(mistakeIds(session("practice", [item(1, false), item(2), item(3, true), item(4), item(1, false, 1)], 3))).toEqual([1]);
  });
});

describe("setupOf", () => {
  const good = { scope: "all", answerMode: "choice", kind: "practice", topics: [], level: 0, count: 5, minutes: 10 };
  test("finds a stored bank", () => {
    expect(setupOf(JSON.stringify([["a", good]]), "a")).toEqual(good);
  });
  test("a bank id that names an inherited property finds nothing", () => {
    const raw = JSON.stringify([["a", good]]);
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) expect(setupOf(raw, id), id).toBeUndefined();
    expect(setupOf(null, "constructor")).toBeUndefined();
  });
  test("a bank stored under such an id is still its own", () => {
    expect(setupOf(JSON.stringify([["constructor", good]]), "constructor")).toEqual(good);
  });
});

describe("stepAsync", () => {
  test("new data replaces the old and clears an error", () => {
    expect(stepAsync({ data: 1, error: "x" }, { data: 2 })).toEqual({ data: 2 });
  });
  test("a failure keeps the data that was shown", () => {
    expect(stepAsync({ data: 1 }, { error: "x" })).toEqual({ data: 1, error: "x" });
  });
  test("a new load clears the error but keeps the data; without an error it changes nothing", () => {
    expect(stepAsync({ data: 1, error: "x" }, { start: true })).toEqual({ data: 1 });
    const same = { data: 1 };
    expect(stepAsync(same, { start: true })).toBe(same);
  });
});

describe("isFirefox", () => {
  test("by the Firefox token of the user agent", () => {
    expect(isFirefox("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0")).toBe(true);
    expect(isFirefox("Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0")).toBe(true);
    expect(isFirefox("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")).toBe(false);
    expect(isFirefox("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148")).toBe(false);
  });
});

describe("backupDue", () => {
  const DAY = 86_400_000;
  const base = { shell: false, events: 50, lastBackup: undefined as number | undefined, now: T0 };
  test("never exported counts as due, in the web page with enough events", () => {
    expect(backupDue(base)).toBe(true);
  });
  test("not in the apps, not with few events", () => {
    expect(backupDue({ ...base, shell: true })).toBe(false);
    expect(backupDue({ ...base, events: 49 })).toBe(false);
  });
  test("14 days from the last export", () => {
    expect(backupDue({ ...base, lastBackup: T0 - 13 * DAY })).toBe(false);
    expect(backupDue({ ...base, lastBackup: T0 - 14 * DAY })).toBe(true);
  });
  test("a time in the future counts as due", () => {
    expect(backupDue({ ...base, lastBackup: T0 + DAY })).toBe(true);
    expect(backupDue({ ...base, lastBackup: Number.NaN })).toBe(true);
  });
});

describe("sessionKey", () => {
  const key = (patch: object = {}) => ({ code: "Digit1", key: "1", ctrlKey: false, metaKey: false, altKey: false, target: null, dialogOpen: false, ...patch });
  test("digits pick by the physical key, top row and numpad", () => {
    expect(sessionKey(key(), 4)).toEqual({ pick: 0 });
    expect(sessionKey(key({ code: "Digit4" }), 4)).toEqual({ pick: 3 });
    expect(sessionKey(key({ code: "Numpad3" }), 4)).toEqual({ pick: 2 });
    expect(sessionKey(key({ code: "Digit5" }), 4)).toBeUndefined();
    expect(sessionKey(key({ code: "Digit0", key: "0" }), 4)).toBeUndefined();
  });
  test("on the Kazakh layout the key types a letter but the code still picks", () => {
    expect(sessionKey(key({ code: "Digit2", key: "ә" }), 3)).toEqual({ pick: 1 });
  });
  test("the numpad picks only while it types digits (NumLock on)", () => {
    expect(sessionKey(key({ code: "Numpad2", key: "2" }), 4)).toEqual({ pick: 1 });
    for (const [code, name] of [["Numpad1", "End"], ["Numpad2", "ArrowDown"], ["Numpad3", "PageDown"], ["Numpad4", "ArrowLeft"], ["Numpad5", "Clear"], ["Numpad7", "Home"], ["Numpad9", "PageUp"]]) {
      expect(sessionKey(key({ code, key: name }), 9), code).toBeUndefined();
    }
    // The top row is still by the code, whatever it types.
    expect(sessionKey(key({ code: "Digit1", key: "ә" }), 4)).toEqual({ pick: 0 });
  });
  test("a key pressed to an input method belongs to it", () => {
    expect(sessionKey(key({ isComposing: true }), 4)).toBeUndefined();
    expect(sessionKey(key({ key: "Process" }), 4)).toBeUndefined();
    expect(sessionKey(key({ code: "Enter", key: "Enter", isComposing: true }), 4)).toBeUndefined();
    expect(sessionKey(key({ code: "Enter", key: "Process" }), 4)).toBeUndefined();
    expect(sessionKey(key({ isComposing: false }), 4)).toEqual({ pick: 0 });
  });
  test("Enter is the primary action", () => {
    expect(sessionKey(key({ code: "Enter", key: "Enter" }), 3)).toBe("primary");
    expect(sessionKey(key({ code: "NumpadEnter", key: "Enter" }), 3)).toBe("primary");
    expect(sessionKey(key({ code: "Enter", key: "Enter", target: { tagName: "DIV" } }), 3)).toBe("primary");
  });
  test("Enter on a button or link is left to the browser", () => {
    expect(sessionKey(key({ code: "Enter", key: "Enter", target: { tagName: "BUTTON" } }), 3)).toBeUndefined();
    expect(sessionKey(key({ code: "Enter", key: "Enter", target: { tagName: "A" } }), 3)).toBeUndefined();
    expect(sessionKey(key({ code: "Digit1", target: { tagName: "BUTTON" } }), 3)).toEqual({ pick: 0 });
  });
  test("a modifier or an open dialog turns it off", () => {
    for (const patch of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { dialogOpen: true }]) {
      expect(sessionKey(key(patch), 3)).toBeUndefined();
      expect(sessionKey(key({ ...patch, code: "Enter", key: "Enter" }), 3)).toBeUndefined();
    }
  });
  test("text fields keep their keys", () => {
    for (const target of [{ tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }, { tagName: "INPUT", type: "text" }, { tagName: "input", type: "number" }, { tagName: "INPUT" }]) {
      expect(sessionKey(key({ target }), 3)).toBeUndefined();
      expect(sessionKey(key({ code: "Enter", key: "Enter", target }), 3)).toBeUndefined();
    }
  });
  test("radio and checkbox inputs do not", () => {
    expect(sessionKey(key({ target: { tagName: "INPUT", type: "radio" } }), 3)).toEqual({ pick: 0 });
    expect(sessionKey(key({ code: "Enter", key: "Enter", target: { tagName: "INPUT", type: "checkbox" } }), 3)).toBe("primary");
  });
});

describe("exam marker in the log", () => {
  test("an imported exam event is accepted and project() ignores the extra fields", () => {
    const questions = [choice(1, 1), choice(2, 1)];
    let s = createSession("b", questions, { kind: "exam", answerMode: "choice", unsupported: "skip", shuffle: false, seed: 1 }, 0, "s1");
    s = finish(submit(s, questions[0]!, { mode: "choice", selected: ["A"] }, 10, { scoring: "exact" }), 20);
    const event = attemptEvent(s, s.items[0]!, questions[0]!, 30, "d", "ru", "e1");
    expect(event).toMatchObject({ exam: true, of: 2 });
    const roundTrip: unknown = JSON.parse(JSON.stringify(event));
    expect(isProgressEvent(roundTrip)).toBe(true);
    const { exam: _exam, of: _of, ...practice } = event;
    expect(project([event as ProgressEvent], "b")).toEqual(project([practice as ProgressEvent], "b"));
  });
});

describe("toggleChoice", () => {
  test("a single choice is replaced, a multiple choice flips", () => {
    expect(toggleChoice(["A"], "B", true)).toEqual(["B"]);
    expect(toggleChoice(["A"], "B", false)).toEqual(["A", "B"]);
    expect(toggleChoice(["A", "B"], "A", false)).toEqual(["B"]);
  });
});

describe("givenLines", () => {
  const plainText = (v: unknown) => (typeof v === "string" ? v : "");
  const two = choice(1, 1);
  test("choice: the texts of the picked options in the order shown in the bank", () => {
    expect(givenLines({ mode: "choice", selected: ["B"] }, two, plainText)).toEqual(["second"]);
    expect(givenLines({ mode: "choice", selected: ["B", "A"] }, two, plainText)).toEqual(["first", "second"]);
  });
  test("typed: trimmed non-empty texts", () => {
    expect(givenLines({ mode: "typed", texts: [" Астана ", "  "] }, two, plainText)).toEqual(["Астана"]);
  });
  test("no answer, a self-check and an unknown option give nothing", () => {
    expect(givenLines(undefined, two, plainText)).toEqual([]);
    expect(givenLines({ mode: "self_check", knew: true }, two, plainText)).toEqual([]);
    expect(givenLines({ mode: "choice", selected: ["Z"] }, two, plainText)).toEqual([]);
    expect(givenLines({ mode: "choice", selected: ["A"] }, open(5), plainText)).toEqual([]);
  });
});
