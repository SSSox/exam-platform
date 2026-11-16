import { describe, expect, test } from "vitest";
import { Question } from "@exam/schema";
import {
  answerModes, attemptEvent, bankStats, createSession, finish, goTo, grade, mastered, mergeLogs, modeFor, project, submit, summarize, uuidv7,
  type ProgressEvent, type SessionConfig,
} from "../src/index.ts";

const q = (data: unknown) => Question.parse(data);
const options = (...texts: string[]) => texts.map((text, i) => ({ id: "ABCDE"[i], text }));

const single = q({
  id: 1, topic_id: 1, type: "single_choice", difficulty_level: 1,
  question: "Самостоятельное построение оригинального образа характеризует воображение...",
  options: options("Воссоздающее", "Творческое", "Репродуктивное"), correct_answers: ["B"],
  free_input: { answers: [{ for: "B", accept: { ru: ["творческое"] } }] },
});
const multi = q({
  id: 2, topic_id: 1, type: "multiple_choice", difficulty_level: 2,
  question: "Какие качества относятся к волевым?",
  options: options("Решительность", "Константность", "Настойчивость", "Предметность", "Выдержка"), correct_answers: ["A", "C", "E"],
  free_input: { answers: [
    { for: "A", accept: { ru: ["решительность"] } },
    { for: "C", accept: { ru: ["настойчивость", "упорство"] } },
    { for: "E", accept: { ru: ["выдержка"] } },
  ] },
});
const statement = q({
  id: 3, topic_id: 2, type: "single_choice", difficulty_level: 3,
  question: "Какое заключение обоснованно?",
  options: options("Недоступность извлечения не доказывает утрату хранения", "Сбой извлечения исключает узнавание"), correct_answers: ["A"],
});
const numeric = q({ id: 4, topic_id: 2, type: "numeric", question: "Сколько мест?", answer: { value: 35, tolerance: 0.5 } });
const open = q({ id: 5, topic_id: 2, type: "open", question: "Сравните понятия.", model_answer: "…" });
const all = [single, multi, statement, numeric, open];
const exact = { scoring: "exact" as const };

describe("grading", () => {
  test("modes follow from the data a question carries", () => {
    expect(answerModes(single)).toEqual(["choice", "typed", "self_check"]);
    expect(answerModes(statement)).toEqual(["choice", "self_check"]);
    expect(answerModes(numeric)).toEqual(["typed"]);
    expect(answerModes(open)).toEqual(["self_check"]);
  });

  test("choice: exact set, or partial credit minus wrong picks", () => {
    expect(grade(multi, { mode: "choice", selected: ["E", "A", "C"] }, exact).correct).toBe(true);
    expect(grade(multi, { mode: "choice", selected: ["A", "C"] }, exact)).toMatchObject({ correct: false, score: 0 });
    expect(grade(multi, { mode: "choice", selected: ["A", "C", "B"] }, { scoring: "partial" }).score).toBeCloseTo(1 / 3);
  });

  test("typed: the same question without options", () => {
    expect(grade(single, { mode: "typed", texts: ["Творческим"] }, exact)).toMatchObject({ correct: true, matchKind: "form" });
    expect(grade(single, { mode: "typed", texts: ["воссоздающее"] }, exact).correct).toBe(false);
    // "репродуктивное" is a distractor here, so a bank-wide term list cannot unlock it either
    expect(grade(single, { mode: "typed", texts: ["репродуктивное"] }, { ...exact, bankTerms: ["творческое"] }).correct).toBe(false);
  });

  test("typed with several answers: any order, each answer used once", () => {
    expect(grade(multi, { mode: "typed", texts: ["выдержка", "упорство", "решительность"] }, exact).correct).toBe(true);
    expect(grade(multi, { mode: "typed", texts: ["выдержка", "выдержка", "решительность"] }, exact).correct).toBe(false);
    const partial = grade(multi, { mode: "typed", texts: ["выдержка", "константность", ""] }, { scoring: "partial" });
    expect(partial.score).toBeCloseTo(1 / 3);
    expect(partial.parts!.map((p) => p.ok)).toEqual([true, false, false]);
  });

  test("numeric accepts a comma and respects tolerance", () => {
    expect(grade(numeric, { mode: "typed", texts: ["35,4"] }, exact).correct).toBe(true);
    expect(grade(numeric, { mode: "typed", texts: ["36"] }, exact).correct).toBe(false);
    expect(grade(numeric, { mode: "typed", texts: [""] }, exact).correct).toBe(false);
  });

  test("numeric tolerance survives float representation", () => {
    const n = (value: number, tolerance: number) => q({ id: 9, topic_id: 2, type: "numeric", question: "?", answer: { value, tolerance } });
    const ok = (item: ReturnType<typeof q>, text: string) => grade(item, { mode: "typed", texts: [text] }, exact).correct;
    expect(["7.15", "7.05", "7.1"].map((t) => ok(n(7.1, 0.05), t))).toEqual([true, true, true]);
    expect(["7.16", "7.04"].map((t) => ok(n(7.1, 0.05), t))).toEqual([false, false]);
    expect(["2.4", "2.6", "2.5"].map((t) => ok(n(2.5, 0.1), t))).toEqual([true, true, true]);
    expect(ok(n(2.5, 0.1), "2.7")).toBe(false);
  });

  test("typed: the correct term plus a wrong option of this question is rejected", () => {
    const gas = q({
      id: 8, topic_id: 1, type: "single_choice", question: "Какой газ тяжелее: кислород или азот?",
      options: options("Кислород", "Азот"), correct_answers: ["A"],
      free_input: { answers: [{ for: "A", accept: { ru: ["кислород"] } }] },
    });
    expect(grade(gas, { mode: "typed", texts: ["кислород"] }, exact).correct).toBe(true);
    expect(grade(gas, { mode: "typed", texts: ["кислород азот"] }, exact).correct).toBe(false);
  });

  test("a mode the question does not support is an error, not a silent pass", () => {
    expect(() => grade(statement, { mode: "typed", texts: ["x"] }, exact)).toThrow();
  });
});

const config: SessionConfig = { kind: "practice", answerMode: "typed", unsupported: "self_check", shuffle: false, seed: 1 };

describe("sessions", () => {
  test("hard mode falls back to self-check or skips, as configured", () => {
    expect(modeFor(statement, config)).toBe("self_check");
    expect(modeFor(statement, { ...config, unsupported: "skip" })).toBeUndefined();
    expect(modeFor(open, { ...config, answerMode: "choice" })).toBe("self_check");
    const s = createSession("b", all, { ...config, unsupported: "skip" }, 0, "s1");
    expect(s.items.map((i) => [i.question, i.mode])).toEqual([[1, "typed"], [2, "typed"], [4, "typed"]]);
  });

  test("filters, count and a reproducible shuffle", () => {
    expect(createSession("b", all, { ...config, topics: [2], levels: [3] }, 0, "s").items.map((i) => i.question)).toEqual([3]);
    const a = createSession("b", all, { ...config, shuffle: true, seed: 7, count: 3 }, 0, "s");
    const b = createSession("b", all, { ...config, shuffle: true, seed: 7, count: 3 }, 0, "s");
    expect(a.items).toEqual(b.items);
    expect(a.items).toHaveLength(3);
  });

  test("answering, summary and pass threshold", () => {
    let s = createSession("b", [single, multi], { ...config, answerMode: "choice", kind: "exam", passPercent: 50 }, 1000, "s");
    s = submit(s, single, { mode: "choice", selected: ["B"] }, 4000, exact);
    s = goTo(s, 1, 4000);
    s = submit(s, multi, { mode: "choice", selected: ["A"] }, 9000, exact);
    expect(() => submit(s, single, { mode: "choice", selected: ["B"] }, 9000, exact)).toThrow();
    s = finish(s, 9000);
    expect(s.items.map((i) => i.ms)).toEqual([3000, 5000]);
    expect(summarize(s)).toEqual({ total: 2, answered: 2, correct: 1, percent: 50, passed: true });
    expect(() => submit(s, multi, { mode: "choice", selected: ["A"] }, 9000, exact)).toThrow();
  });
});

test("leaving practice early scores the answered questions; an exam counts the blanks", () => {
  const run = (kind: "practice" | "exam") => {
    const s = createSession("b", [single, multi, statement], { ...config, answerMode: "choice", kind }, 0, "s");
    return summarize(finish(submit(s, single, { mode: "choice", selected: ["B"] }, 1, exact), 2));
  };
  expect(run("practice")).toMatchObject({ total: 3, answered: 1, percent: 100 });
  expect(run("exam")).toMatchObject({ total: 3, answered: 1, percent: 33 });
});

describe("progress log", () => {
  const attempt = (id: string, at: number, question: number, mode: "choice" | "typed", correct: boolean): ProgressEvent => ({
    id, type: "attempt", at, device: "d", bank: "b", question, rev: "r", mode, correct, score: correct ? 1 : 0, matchKind: "exact",
    response: { mode: "self_check", knew: correct }, locale: "ru", session: "s", ms: 1,
  });

  test("uuidv7 ids sort by time", () => {
    const ids = [uuidv7(1_700_000_000_000), uuidv7(1_700_000_000_001), uuidv7(1_800_000_000_000)];
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("two devices merge without loss or duplicates, in any order", () => {
    const phone = [attempt("a", 1, 1, "choice", true), attempt("c", 3, 1, "choice", false)];
    const laptop = [attempt("b", 2, 1, "choice", true), attempt("a", 1, 1, "choice", true)];
    const merged = mergeLogs(phone, laptop);
    expect(merged.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(mergeLogs(laptop, phone)).toEqual(merged);
    expect(project(merged, "b").get(1)!.modes.choice).toMatchObject({ attempts: 3, correct: 2, streak: 0, lastCorrect: false });
  });

  test("mastery is tracked per answer mode", () => {
    const log = [attempt("a", 1, 1, "choice", true), attempt("b", 2, 1, "choice", true), attempt("c", 3, 2, "typed", true), attempt("d", 4, 3, "choice", true)];
    const states = project(log, "b");
    expect(mastered(states.get(1), "choice")).toBe(true);
    expect(mastered(states.get(1), "typed")).toBe(false);
    expect(mastered(states.get(3), "choice")).toBe(false);
    const stats = bankStats(states, all);
    expect(stats.mastered).toEqual({ choice: 1, typed: 1, self_check: 0 });
    expect(stats.byLevelAndMode.get("1:choice")).toEqual({ attempts: 2, correct: 2 });
    expect(stats).toMatchObject({ questions: 5, seen: 3, mistakes: [] });
  });

  test("a disputed attempt counts neither as right nor as wrong; bookmarks toggle", () => {
    const log: ProgressEvent[] = [
      attempt("a", 1, 1, "typed", true),
      attempt("b", 2, 1, "typed", false),
      { id: "c", type: "dispute", at: 3, device: "d", bank: "b", question: 1, attempt: "b" },
      { id: "d", type: "bookmark", at: 4, device: "d", bank: "b", question: 2, value: true },
      { id: "e", type: "bookmark", at: 5, device: "d", bank: "b", question: 3, value: true },
      { id: "f", type: "bookmark", at: 6, device: "d", bank: "b", question: 3, value: false },
    ];
    const states = project(log, "b");
    expect(states.get(1)!.modes.typed).toMatchObject({ attempts: 1, correct: 1, disputed: 1, streak: 1 });
    const stats = bankStats(states, all);
    expect(stats.mistakes).toEqual([]);
    expect(stats.bookmarks).toEqual([2]);
  });

  test("another bank's events change nothing, and a dispute only reaches the attempt of its own bank", () => {
    const own = [attempt("a", 1, 1, "typed", false), { id: "d", type: "dispute", at: 2, device: "d", bank: "b", question: 1, attempt: "a" } satisfies ProgressEvent];
    const other = [{ ...attempt("a2", 5, 1, "typed", true), bank: "other" }, { ...attempt("x", 6, 2, "typed", false), bank: "other" }];
    expect(project([...other, ...own], "b")).toEqual(project(own, "b"));
    expect(project([...other, ...own], "b").get(1)!.modes.typed).toMatchObject({ attempts: 0, disputed: 1 });
    expect([...project([...other, ...own], "other").keys()]).toEqual([1, 2]);
  });

  test("a finished session becomes attempt events that keep the typed text", () => {
    let s = createSession("b", [single], config, 0, "s1");
    expect(() => attemptEvent(s, s.items[0]!, single, 900, "dev", "ru")).toThrow();
    s = finish(submit(s, single, { mode: "typed", texts: ["творческое"] }, 500, exact), 900);
    const event = attemptEvent(s, s.items[0]!, single, 900, "dev", "ru", "id0");
    expect(event).toMatchObject({ id: "id0", at: 900, question: 1, mode: "typed", correct: true, matchKind: "exact", ms: 500, response: { texts: ["творческое"] } });
    expect(event.rev).toMatch(/^[0-9a-f]{8}$/);
  });
});
