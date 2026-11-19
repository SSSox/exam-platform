import { describe, expect, test } from "vitest";
import { Question } from "@exam/schema";
import { attemptEvent, createSession, examHistory, finish, goTo, project, submit, summarize, type AttemptEvent, type ProgressEvent, type SessionConfig } from "../src/index.ts";

const choice = (id: number) => Question.parse({
  id, topic_id: 1, type: "single_choice", question: `Q${id}`,
  options: [{ id: "A", text: "a" }, { id: "B", text: "b" }], correct_answers: ["A"],
});
const questions = [choice(1), choice(2), choice(3)];
const exact = { scoring: "exact" as const };
const base: SessionConfig = { kind: "practice", answerMode: "choice", unsupported: "self_check", shuffle: false, seed: 1 };

const answered = (config: SessionConfig, selected: string) => {
  let s = createSession("b", questions, config, 0, "s1");
  s = submit(s, questions[0]!, { mode: "choice", selected: [selected] }, 100, exact);
  return finish(s, 200);
};

describe("exam fields on attempt events", () => {
  test("an exam answer carries the marker and the size of the exam", () => {
    const s = answered({ ...base, kind: "exam" }, "A");
    expect(attemptEvent(s, s.items[0]!, questions[0]!, 300, "d", "ru", "e1")).toMatchObject({ exam: true, of: 3 });
  });

  test("a practice event has no new keys", () => {
    const s = answered(base, "A");
    const event = attemptEvent(s, s.items[0]!, questions[0]!, 300, "d", "ru", "e1");
    expect(Object.keys(event)).toEqual(["id", "type", "at", "device", "bank", "question", "rev", "mode", "correct", "score", "matchKind", "response", "locale", "session", "ms"]);
  });

  test("project() ignores them", () => {
    const s = answered({ ...base, kind: "exam" }, "A");
    const plain = attemptEvent(answered(base, "A"), answered(base, "A").items[0]!, questions[0]!, 300, "d", "ru", "e1");
    const marked = attemptEvent(s, s.items[0]!, questions[0]!, 300, "d", "ru", "e1");
    expect(project([marked], "b")).toEqual(project([plain], "b"));
  });
});

const ev = (id: string, session: string, at: number, correct: boolean, extra: Partial<AttemptEvent> = {}): AttemptEvent => ({
  id, type: "attempt", at, device: "d", bank: "b", question: 1, rev: "00000000", mode: "choice", correct, score: correct ? 1 : 0,
  matchKind: "exact", response: { mode: "choice", selected: ["A"] }, locale: "ru", session, ms: 1, exam: true, of: 4, ...extra,
});

describe("exam history", () => {
  test("practice attempts are not listed", () => {
    expect(examHistory([ev("a", "p", 1, true, { exam: undefined, of: undefined })], "b")).toEqual([]);
  });

  test("two exams give two entries, newest first, with unanswered questions counted by the size", () => {
    const log: ProgressEvent[] = [
      ev("a", "old", 10, true), ev("b", "old", 20, false), ev("c", "old", 30, true),
      ev("d", "new", 100, true), ev("e", "new", 110, true), ev("f", "other", 120, true, { bank: "x" }),
    ];
    expect(examHistory(log, "b")).toEqual([
      { session: "new", at: 110, correct: 2, of: 4, percent: 50 },
      { session: "old", at: 30, correct: 2, of: 4, percent: 50 },
    ]);
  });

  test("a disputed answer does not count as right", () => {
    const log: ProgressEvent[] = [ev("a", "s", 1, true), ev("b", "s", 2, true), { id: "x", type: "dispute", at: 3, device: "d", bank: "b", question: 1, attempt: "a" }];
    expect(examHistory(log, "b")[0]).toMatchObject({ correct: 1, percent: 25 });
  });

  test("the percent follows the points, as the result screen's summary does; the count stays the right answers", () => {
    // Four questions: one right, one half right (not "correct"), two unanswered.
    const log: ProgressEvent[] = [ev("a", "s", 1, true), ev("b", "s", 2, false, { score: 0.5 })];
    expect(examHistory(log, "b")[0]).toMatchObject({ correct: 1, of: 4, percent: 38 });
  });

  test("a score outside 0..1 from an imported log is held to the range, so the percent is never below 0 or above 100", () => {
    const log: ProgressEvent[] = [ev("a", "s", 1, false, { score: -5 }), ev("b", "s", 2, true, { score: 9 })];
    expect(examHistory(log, "b")[0]).toMatchObject({ correct: 1, percent: 25 });
    expect(examHistory([ev("a", "t", 1, false, { score: -50 })], "b")[0]!.percent).toBe(0);
  });

  test("the percent equals summarize() of the same session, with partial credit", () => {
    const multi = Question.parse({
      id: 1, topic_id: 1, type: "multiple_choice", question: "Q",
      options: [{ id: "A", text: "a" }, { id: "B", text: "b" }, { id: "C", text: "c" }], correct_answers: ["A", "B"],
    });
    const all = [multi, choice(2), choice(3), choice(4)];
    let s = createSession("b", all, { ...base, kind: "exam" }, 0, "s1");
    // One of two right options and nothing wrong is half a point under partial scoring; one more is right, two are left unanswered.
    s = submit(s, all[0]!, { mode: "choice", selected: ["A"] }, 10, { scoring: "partial" });
    s = submit(goTo(s, 1, 11), all[1]!, { mode: "choice", selected: ["A"] }, 12, { scoring: "partial" });
    s = finish(s, 20);
    expect(s.items[0]!.graded).toMatchObject({ correct: false, score: 0.5 });
    const events = s.items.flatMap((item, i) => (item.graded ? [attemptEvent(s, item, all[i]!, 100 + i, "d", "ru", `e${i}`)] : []));
    // 1.5 points of 4: 38, where counting right answers alone would say 25.
    expect(summarize(s).percent).toBe(38);
    expect(examHistory(events, "b")[0]).toMatchObject({ correct: 1, of: 4, percent: summarize(s).percent });
  });

  test("an exam without a valid size is skipped", () => {
    const log = [ev("a", "s1", 1, true, { of: undefined }), ev("b", "s2", 1, true, { of: 0 }), ev("c", "s3", 1, true, { of: 2.5 }), ev("d", "s4", 1, true, { of: Infinity }), ev("e", "s5", 1, true, { exam: false as unknown as true })];
    expect(examHistory(log, "b")).toEqual([]);
  });

  test("percent is rounded", () => {
    expect(examHistory([ev("a", "s", 1, true, { of: 3 })], "b")[0]!.percent).toBe(33);
  });
});
