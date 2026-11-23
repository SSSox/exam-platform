import { describe, expect, test } from "vitest";
import { Question } from "@exam/schema";
import {
  BOX_WAIT, DAY, HOUR, LEARNED_BOX, bankStats, createSession, finish, goTo, isDue, learn, pickAdaptive, project, shuffled, statusOf, strength, submit, summarize, weight,
  type Memory, type ProgressEvent, type Response, type Session, type SessionConfig,
} from "../src/index.ts";

const T0 = 1_700_000_000_000;
const q = (id: number, extra: Record<string, unknown> = {}) =>
  Question.parse({
    id, topic_id: 1, type: "single_choice", question: `Вопрос ${id}`,
    options: [{ id: "A", text: "Верно" }, { id: "B", text: "Неверно" }], correct_answers: ["A"], ...extra,
  });
const bank = Array.from({ length: 12 }, (_, i) => q(i + 1));
const right: Response = { mode: "choice", selected: ["A"] };
const wrong: Response = { mode: "choice", selected: ["B"] };

/** Replays attempts [at, mode, correct] on one question. */
const replay = (steps: [number, "choice" | "typed" | "self_check", boolean][]): Memory | undefined =>
  steps.reduce<Memory | undefined>((m, [at, mode, correct]) => learn(m, at, mode, correct), undefined);

describe("memory of one question", () => {
  test("a new question answered right goes to box 1 and comes due in 8 hours", () => {
    const m = replay([[T0, "choice", true]])!;
    expect(m).toMatchObject({ box: 1, lapses: 0, due: T0 + BOX_WAIT[1] });
    expect(statusOf(m)).toBe("learning");
  });

  test("a miss sends the question back to box 0 and counts a lapse for good", () => {
    const m = replay([[T0, "choice", true], [T0 + 9 * HOUR, "choice", false]])!;
    expect(m).toMatchObject({ box: 0, lapses: 1, lastCorrect: false });
    expect(statusOf(m)).toBe("weak");
  });

  test("one right answer after a miss does not clear it; two do", () => {
    const missed = replay([[T0, "choice", false]]);
    const once = learn(missed, T0 + 60_000, "choice", true);
    expect(statusOf(once)).toBe("weak");
    const twice = learn(once, T0 + 120_000, "choice", true);
    expect(statusOf(twice)).toBe("learning");
    expect(twice.box).toBe(1);
  });

  test("answering early is practice, not proof: the box stays until the question is due", () => {
    const m = replay([[T0, "choice", true], [T0 + HOUR, "choice", true], [T0 + 2 * HOUR, "choice", true]])!;
    expect(m).toMatchObject({ box: 1, reps: 3 });
    const due = learn(m, T0 + 9 * HOUR, "choice", true);
    expect(due.box).toBe(2);
  });

  test("choice stops at box 4, typing reaches box 5", () => {
    let m: Memory | undefined;
    let at = T0;
    for (let i = 0; i < 8; i++) {
      m = learn(m, at, "choice", true);
      at = m.due;
    }
    expect(m!.box).toBe(4);
    expect(learn(m, at, "typed", true).box).toBe(5);
  });

  test("learned questions are told apart by how they were learned", () => {
    const run = (mode: "choice" | "typed") => {
      let m: Memory | undefined;
      let at = T0;
      for (let i = 0; i < LEARNED_BOX; i++) {
        m = learn(m, at, mode, true);
        at = m.due;
      }
      return statusOf(m);
    };
    expect(run("choice")).toBe("choice");
    expect(run("typed")).toBe("typed");
  });

  test("a question left past its due date fades; a fresh one counts fully", () => {
    const m = replay([[T0, "choice", true], [T0 + 9 * HOUR, "choice", true], [T0 + 3 * DAY, "choice", true]])!;
    expect(m.box).toBe(3);
    expect(strength(m, m.due)).toBeCloseTo(0.75);
    expect(strength(m, m.due + BOX_WAIT[3])).toBeCloseTo(0.375);
    expect(strength(undefined, T0)).toBe(0);
    expect(isDue(m, m.due - 1)).toBe(false);
    expect(isDue(m, m.due)).toBe(true);
  });
});

describe("one evening of drilling", () => {
  const attempt = (n: number, at: number, question: number, correct: boolean): ProgressEvent => ({
    id: `e${n}`, type: "attempt", at, device: "d", bank: "b", question, rev: "r", mode: "choice", correct, score: correct ? 1 : 0, matchKind: "choice",
    response: { mode: "choice", selected: ["A"] }, locale: "ru", session: "s", ms: 1,
  });

  test("a miss is cleared the same evening, but the question is not called learned until days pass", () => {
    const log = [attempt(1, T0, 1, false), attempt(2, T0 + 4 * 60_000, 1, true), attempt(3, T0 + 9 * 60_000, 1, true)];
    const evening = bankStats(project(log, "b"), bank, T0 + HOUR);
    expect(evening.mistakes).toEqual([]);
    expect(evening.learned).toBe(0);
    expect(evening.status.get(1)).toBe("learning");
    expect(evening.mastery).toBeGreaterThan(0);

    const morning = [...log, attempt(4, T0 + 10 * HOUR, 1, true)];
    expect(bankStats(project(morning, "b"), bank, T0 + 10 * HOUR).status.get(1)).toBe("learning");
    const third = [...morning, attempt(5, T0 + 10 * HOUR + 2 * DAY, 1, true)];
    const later = bankStats(project(third, "b"), bank, T0 + 10 * HOUR + 2 * DAY);
    expect(later.status.get(1)).toBe("choice");
    expect(later.learned).toBe(1);
  });

  test("a disputed wrong answer does not reset a question", () => {
    const log: ProgressEvent[] = [
      attempt(1, T0, 1, true),
      attempt(2, T0 + 9 * HOUR, 1, true),
      attempt(3, T0 + 10 * HOUR, 1, false),
      { id: "d", type: "dispute", at: T0 + 11 * HOUR, device: "d", bank: "b", question: 1, attempt: "e3" },
    ];
    expect(project(log, "b").get(1)!.memory).toMatchObject({ box: 2, lapses: 0 });
  });

  test("the bank reaches 100% when every question is learned and nothing is overdue", () => {
    const log = bank.flatMap((item, i) => {
      const steps = [0, 9 * HOUR, 2 * DAY + 10 * HOUR, 7 * DAY + 11 * HOUR].map((dt) => T0 + dt);
      return steps.map((at, k) => attempt(i * 10 + k, at, item.id, true));
    });
    const stats = bankStats(project(log, "b"), bank, T0 + 8 * DAY);
    expect(stats.mastery).toBeCloseTo(1);
    expect(stats.learned).toBe(bank.length);
  });
});

describe("a log that came from outside", () => {
  test("an attempt in no known mode is left out instead of breaking the statistics", () => {
    const ok: ProgressEvent = { id: "a", type: "attempt", at: T0, device: "d", bank: "b", question: 1, rev: "r", mode: "typed", correct: true, score: 1, matchKind: "exact", response: { mode: "typed", texts: ["x"] }, locale: "ru", session: "s", ms: 1 };
    const bad = { ...ok, id: "b", at: T0 + 1, question: 2, mode: undefined } as unknown as ProgressEvent;
    const states = project([ok, bad], "b");
    expect([...states.keys()]).toEqual([1]);
    expect(() => bankStats(states, [q(1), q(2)], T0 + 2)).not.toThrow();
  });
});

describe("what to ask next", () => {
  const states = (entries: [number, Memory][]) => new Map(entries.map(([id, memory]) => [id, { modes: {}, bookmarked: false, memory }]));
  const mem = (patch: Partial<Memory>): Memory => ({ box: 1, step: 0, due: T0, lapses: 0, reps: 1, recall: false, lastAt: T0, lastCorrect: true, ...patch });

  test("a missed question outweighs a due one, a due one outweighs a new one, a learned one comes last", () => {
    const now = T0 + DAY;
    const weak = weight(mem({ box: 0, lapses: 1 }), now);
    const due = weight(mem({ box: 2, due: now - HOUR }), now);
    const fresh = weight(undefined, now);
    const learned = weight(mem({ box: 4, due: now + 5 * DAY }), now);
    expect(weak).toBeGreaterThan(due);
    expect(due).toBeGreaterThan(fresh);
    expect(fresh).toBeGreaterThan(learned);
  });

  test("questions missed more often weigh more, with a ceiling", () => {
    const now = T0;
    expect(weight(mem({ box: 0, lapses: 4 }), now)).toBeGreaterThan(weight(mem({ box: 0, lapses: 1 }), now));
    expect(weight(mem({ box: 4, lapses: 5, due: now + DAY }), now)).toBeGreaterThan(weight(mem({ box: 4, lapses: 0, due: now + DAY }), now));
    expect(weight(mem({ box: 0, lapses: 50 }), now)).toBe(weight(mem({ box: 0, lapses: 6 }), now));
  });

  test("the pick is repeatable, has no duplicates and honours the count", () => {
    const log = new Map<number, ReturnType<typeof states> extends Map<number, infer S> ? S : never>();
    const a = pickAdaptive(bank, log, T0, 5, 42);
    expect(a).toEqual(pickAdaptive(bank, log, T0, 5, 42));
    expect(new Set(a).size).toBe(5);
    expect(pickAdaptive(bank, log, T0, undefined, 1)).toHaveLength(bank.length);
    expect(pickAdaptive([...bank, q(99, { retired: true })], log, T0, undefined, 1)).not.toContain(99);
  });

  test("across many seeds, missed and overdue questions are drawn far more often than learned ones", () => {
    const now = T0 + 20 * DAY;
    const st = states([
      [1, mem({ box: 0, lapses: 3 })],
      [2, mem({ box: 2, due: now - DAY })],
      ...[3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((id) => [id, mem({ box: 5, due: now + 20 * DAY })] as [number, Memory]),
    ]);
    const first = new Map<number, number>();
    for (let seed = 1; seed <= 300; seed++) {
      const [id] = pickAdaptive(bank, st, now, 3, seed);
      first.set(id!, (first.get(id!) ?? 0) + 1);
    }
    expect((first.get(1) ?? 0) + (first.get(2) ?? 0)).toBeGreaterThan(200);
  });

  test("a missed question is never left out of the sitting, however many new ones compete", () => {
    const many = Array.from({ length: 300 }, (_, i) => q(i + 1));
    const st = states([[150, mem({ box: 0, lapses: 1 })]]);
    for (let seed = 1; seed <= 200; seed++) expect(pickAdaptive(many, st, T0, 20, seed)).toContain(150);
  });

  test("missed questions take at most a set share of the sitting and the rest is still filled", () => {
    const many = Array.from({ length: 100 }, (_, i) => q(i + 1));
    const st = states(many.slice(0, 40).map((x) => [x.id, mem({ box: 0, lapses: 1 })] as [number, Memory]));
    const a = pickAdaptive(many, st, T0, 10, 7);
    expect(a).toHaveLength(10);
    expect(new Set(a).size).toBe(10);
    expect(a.filter((id) => id <= 40).length).toBeGreaterThanOrEqual(6);
    expect(pickAdaptive(many, st, T0, 10, 7)).toEqual(a);
  });
});

describe("a missed question comes back inside the sitting", () => {
  const config: SessionConfig = { kind: "practice", answerMode: "choice", unsupported: "self_check", shuffle: false, seed: 1, relearn: true };
  const options = { scoring: "exact" as const };
  const answer = (s: Session, good: boolean) => submit(s, bank.find((x) => x.id === s.items[s.index]!.question)!, good ? right : wrong, T0, options);
  const next = (s: Session): Session => ({ ...s, index: s.index + 1 });

  test("after a miss the question is put back three questions later, never in a row", () => {
    let s = createSession("b", bank.slice(0, 6), config, T0, "s");
    s = answer(s, false);
    expect(s.items.map((i) => i.question)).toEqual([1, 2, 3, 4, 1, 5, 6]);
    expect(s.items[4]).toMatchObject({ question: 1, again: 1 });
  });

  test("a right repeat puts it back once more, farther away; the second right answer ends it", () => {
    let s = createSession("b", bank.slice(0, 12), config, T0, "s");
    s = answer(s, false);
    s = { ...s, index: 4 };
    s = answer(s, true);
    expect(s.items.filter((i) => i.question === 1)).toHaveLength(3);
    expect(s.items[11]).toMatchObject({ question: 1, again: 2 });
    s = answer({ ...s, index: 11 }, true);
    expect(s.items.filter((i) => i.question === 1)).toHaveLength(3);
  });

  test("no two neighbours are the same question while a sitting is worked through", () => {
    let s = createSession("b", bank.slice(0, 8), config, T0, "s");
    for (let k = 0; k < 40 && s.index < s.items.length; k++) {
      s = answer(s, k % 3 === 0);
      if (s.index < s.items.length - 1) s = next(s);
      else break;
    }
    s.items.slice(1).forEach((item, i) => expect(item.question).not.toBe(s.items[i]!.question));
  });

  test("a miss on the last question, or in a one-question sitting, is not repeated", () => {
    let s = createSession("b", bank.slice(0, 3), config, T0, "s");
    s = answer({ ...s, index: 2 }, false);
    expect(s.items).toHaveLength(3);
    const single = answer(createSession("b", bank.slice(0, 1), config, T0, "s"), false);
    expect(single.items).toHaveLength(1);
  });

  test("a miss on a question gone back to is put back after the ones already answered, not among them", () => {
    let s = createSession("b", bank.slice(0, 10), config, T0, "s");
    s = answer({ ...s, index: 5 }, true); // 1..5 skipped, 6 answered
    const sixth = s.items[5];
    s = answer({ ...s, index: 1 }, false); // back to 2, missed
    expect(s.items.map((i) => i.question)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 2, 10]);
    expect(s.items[5]).toBe(sixth);
  });

  test("the furthest question reached keeps its mark when a repeat is put back before it", () => {
    let s = createSession("b", bank.slice(0, 10), config, T0, "s");
    for (const k of [1, 2, 3, 4, 5, 6, 1]) s = goTo(s, k, T0);
    expect(s.reached).toBe(6);
    s = answer(s, false); // back on 2 and missed: the repeat goes in before 7
    expect(s.items.map((i) => i.question)).toEqual([1, 2, 3, 4, 5, 2, 6, 7, 8, 9, 10]);
    expect(s.items[s.reached!]!.question).toBe(7);
    expect(s.unseen).toEqual([5]); // the repeat sits where the learner already went past
    s = goTo(s, 5, T0);
    expect(s.unseen).toEqual([]);
  });

  test("a question is put back at most a few times in one sitting", () => {
    let s = createSession("b", bank.slice(0, 12), config, T0, "s");
    for (let k = 0; k < 10; k++) {
      const at = s.items.findIndex((i, n) => i.question === 1 && !i.graded && n >= s.index);
      if (at < 0) break;
      s = answer({ ...s, index: at }, false);
    }
    expect(s.items.filter((i) => i.question === 1).length).toBeLessThanOrEqual(5);
  });

  test("the score counts each question once, at its first attempt", () => {
    let s = createSession("b", bank.slice(0, 6), config, T0, "s");
    s = answer(s, false);
    s = answer({ ...s, index: 1 }, true);
    s = answer({ ...s, index: 4 }, true);
    expect(summarize(finish(s, T0))).toMatchObject({ total: 6, answered: 2, correct: 1, percent: 50 });
  });

  test("an exam never puts questions back, and with the same seed it keeps today's order", () => {
    const exam: SessionConfig = { ...config, kind: "exam", shuffle: true, seed: 7 };
    let s = createSession("b", bank, exam, T0, "s");
    s = answer(s, false);
    expect(s.items).toHaveLength(bank.length);
    expect(s.items.map((i) => i.question)).toEqual(shuffled(bank, 7).map((x) => x.id));
  });

  test("a planned sitting keeps the order of its ids", () => {
    const s = createSession("b", bank, { ...config, ids: [5, 2, 9], keepOrder: true, shuffle: true }, T0, "s");
    expect(s.items.map((i) => i.question)).toEqual([5, 2, 9]);
  });
});
