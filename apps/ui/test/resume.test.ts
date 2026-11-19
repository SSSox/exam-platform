import { describe, expect, test } from "vitest";
import katex from "katex";
import type { Session, SessionItem } from "@exam/core";
import {
  KEYS, draftResponse, fitsBundle, keptOnStart, parseSavedExam, pinnedBanks, safeStyle, settleDrafts, unansweredCount, wipe, type SavedExam,
} from "../src/lib.ts";

const T0 = 1_700_000_000_000;
const exam = (patch: Partial<Session> = {}): Session => ({
  id: "s1", bank: "b1", index: 0, startedAt: T0, shownAt: T0,
  config: { kind: "exam", answerMode: "choice", unsupported: "self_check", shuffle: true, seed: 1, timeLimitSec: 600 },
  items: [{ question: 1, mode: "choice" }, { question: 2, mode: "typed" }, { question: 3, mode: "choice" }],
  ...patch,
});
const saved = (patch: Partial<SavedExam> = {}): SavedExam => ({ v: 1, session: exam(), drafts: { 0: { selected: ["a"] }, 1: { texts: ["x"] } }, back: "#/bank?node=n&id=b1", line: 2, hash: "abc123", ...patch });

describe("a saved exam", () => {
  test("a value that was saved comes back as it was", () => {
    expect(parseSavedExam(JSON.stringify(saved()))).toEqual(saved());
  });
  test("a value without drafts or a line colour is fine", () => {
    const { line: _line, ...bare } = saved({ drafts: {} });
    expect(parseSavedExam(JSON.stringify(bare))).toEqual(bare);
  });
  test("nothing, broken JSON and foreign values are turned away without an exception", () => {
    for (const raw of [null, undefined, "", "{", "null", "42", "[]", '"exam"', "{}", JSON.stringify({ hello: "world" })]) expect(parseSavedExam(raw)).toBeUndefined();
  });
  test("a value of another version or with a broken part is turned away", () => {
    for (const bad of [
      { ...saved(), v: 2 }, { ...saved(), hash: "" }, { ...saved(), hash: 5 }, { ...saved(), back: null }, { ...saved(), line: "1" },
      { ...saved(), drafts: [] }, { ...saved(), drafts: { 0: { selected: [1] } } }, { ...saved(), drafts: { 9: { selected: ["a"] } } }, { ...saved(), drafts: { x: {} } },
      { ...saved(), session: null }, { ...saved(), session: exam({ index: 3 }) }, { ...saved(), session: exam({ items: [] }) },
      { ...saved(), session: exam({ items: [{ question: "1", mode: "choice" }] as unknown as SessionItem[] }) },
      { ...saved(), session: exam({ items: [{ question: 1, mode: "voice" }] as unknown as SessionItem[] }) },
      { ...saved(), session: exam({ startedAt: Infinity }) },
    ]) expect(parseSavedExam(JSON.stringify(bad))).toBeUndefined();
  });
  test("the answers of an ended exam wait in it as log events; anything else in their place is turned away", () => {
    const pending = [{ id: "e1", type: "attempt" as const, at: T0, bank: "b1", question: 1, correct: true, mode: "choice" as const }];
    expect(parseSavedExam(JSON.stringify({ ...saved(), pending }))?.pending).toEqual(pending);
    expect(parseSavedExam(JSON.stringify({ ...saved(), pending: [] }))?.pending).toEqual([]);
    for (const bad of ["x", [{ id: "e1" }], [null], { 0: pending[0] }]) expect(parseSavedExam(JSON.stringify({ ...saved(), pending: bad }))).toBeUndefined();
  });
  test("a finished exam is not restored", () => {
    expect(parseSavedExam(JSON.stringify(saved({ session: exam({ finishedAt: T0 + 5 }) })))).toBeUndefined();
  });
  test("practice is not restored", () => {
    const practice = exam({ config: { kind: "practice", answerMode: "choice", unsupported: "self_check", shuffle: true, seed: 1 } });
    expect(parseSavedExam(JSON.stringify(saved({ session: practice })))).toBeUndefined();
  });
  test("the key is one of the app's own, so the data wipe removes it", async () => {
    expect(Object.values(KEYS)).toContain(KEYS.exam);
    const map = new Map([[KEYS.exam, "{}"], ["other-site", "kept"]]);
    await wipe([], { removeItem: (k: string) => void map.delete(k) });
    expect([...map.keys()]).toEqual(["other-site"]);
  });
  test("the bank file of a saved exam is pinned, nothing else is", () => {
    expect(pinnedBanks(JSON.stringify(saved()))).toEqual(["banks/abc123"]);
    expect(pinnedBanks("{")).toEqual([]);
    expect(pinnedBanks(null)).toEqual([]);
  });
  test("it fits the bank only when the bank holds the session's own questions", () => {
    const bundle = (id: string, questions: number[]) => ({ bank: { id }, questions: questions.map((q) => ({ id: q })) }) as Parameters<typeof fitsBundle>[1];
    expect(fitsBundle(exam(), bundle("b1", [1, 2, 3, 4]))).toBe(true);
    expect(fitsBundle(exam(), bundle("b1", [1, 2]))).toBe(false);
    expect(fitsBundle(exam(), bundle("other", [1, 2, 3]))).toBe(false);
  });
});

describe("what starting a session does with the kept exam", () => {
  const pending = [{ id: "e1", type: "attempt" as const, at: T0, bank: "b1", question: 1, correct: true, mode: "choice" as const }] as unknown as SavedExam["pending"];
  const practice = { id: "p1", config: { kind: "practice" } } as Pick<Session, "id" | "config">;
  const another = { id: "s2", config: { kind: "exam" } } as Pick<Session, "id" | "config">;
  test("nothing kept, or nothing started (leaving), touches nothing", () => {
    expect(keptOnStart(undefined, practice)).toBe("none");
    expect(keptOnStart(saved({ pending }), undefined)).toBe("none");
  });
  test("a finished exam whose answers may not be in the log is written first, whatever starts", () => {
    expect(keptOnStart(saved({ pending }), practice)).toBe("flush");
    expect(keptOnStart(saved({ pending }), another)).toBe("flush");
  });
  test("the same session never touches its own key (every answer runs again)", () => {
    expect(keptOnStart(saved({ pending }), { id: "s1", config: { kind: "exam" } } as Pick<Session, "id" | "config">)).toBe("none");
    expect(keptOnStart(saved(), { id: "s1", config: { kind: "exam" } } as Pick<Session, "id" | "config">)).toBe("none");
  });
  test("practice drops an unfinished kept exam; another exam is left for its own copy to replace", () => {
    expect(keptOnStart(saved(), practice)).toBe("clear");
    expect(keptOnStart(saved(), another)).toBe("none");
  });
});

describe("drafts at the end of an exam", () => {
  const item = (mode: SessionItem["mode"]): SessionItem => ({ question: 1, mode });
  const graded = (correct: boolean) => ({ correct, score: correct ? 1 : 0 }) as SessionItem["graded"];
  test("a picked option or typed text becomes the answer", () => {
    expect(draftResponse(item("choice"), { selected: ["a", "b"] })).toEqual({ mode: "choice", selected: ["a", "b"] });
    expect(draftResponse(item("typed"), { texts: ["x", ""] })).toEqual({ mode: "typed", texts: ["x", ""] });
  });
  test("an empty draft, blank text, no draft or a draft of the wrong kind is no answer", () => {
    expect(draftResponse(item("choice"), { selected: [] })).toBeUndefined();
    expect(draftResponse(item("typed"), { texts: ["  ", ""] })).toBeUndefined();
    expect(draftResponse(item("choice"), undefined)).toBeUndefined();
    expect(draftResponse(item("typed"), { selected: ["a"] })).toBeUndefined();
    expect(draftResponse(item("self_check"), { selected: ["a"], texts: ["x"] })).toBeUndefined();
  });
  test("the dialog counts a question with a draft as answered, as the end will", () => {
    const items: SessionItem[] = [{ question: 1, mode: "choice" }, { question: 2, mode: "typed" }, { question: 3, mode: "choice" }, { question: 4, mode: "choice", graded: graded(true) }];
    expect(unansweredCount(items, { 0: { selected: ["a"] }, 1: { texts: [" "] } })).toBe(2);
    expect(unansweredCount(items, {})).toBe(3);
  });
  test("every non-empty draft is submitted before the exam is finished, and the number matches the dialog", () => {
    const s = exam();
    const drafts = { 0: { selected: ["a"] }, 1: { texts: ["x"] } };
    const asked: [number, string][] = [];
    const out = settleDrafts(s, drafts, (done, at, response) => {
      asked.push([at, response.mode]);
      return { ...done, items: done.items.map((it, i) => (i === at ? { ...it, graded: graded(false) } : it)) };
    });
    expect(asked).toEqual([[0, "choice"], [1, "typed"]]);
    expect(out.items.filter((i) => !i.graded)).toHaveLength(unansweredCount(s.items, drafts));
  });
  test("without drafts the session is left as it is", () => {
    const s = exam();
    expect(settleDrafts(s, {}, () => { throw new Error("nothing to send"); })).toBe(s);
  });
});

describe("style attributes of formulas", () => {
  /** Every style attribute KaTeX writes for a formula. */
  const styles = (tex: string) => [...katex.renderToString(tex, { displayMode: true, throwOnError: false, trust: false, strict: "ignore" }).matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]!);
  const formulas = [
    "x^2", String.raw`\frac{a}{b}`, String.raw`\sqrt{2}`, String.raw`\sum_{i=1}^{n} i`, String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, String.raw`\color{red}{x}`,
    String.raw`\begin{cases}a&b\\c&d\end{cases}`, String.raw`\xrightarrow{abc}`, String.raw`\boxed{x}`, String.raw`\textcolor{#ff0000}{y}\colorbox{yellow}{z}`,
    String.raw`\rule{1em}{2pt}\raisebox{1ex}{a}\phantom{x}`, String.raw`\begin{array}{c|c}a&b\\\hline c&d\end{array}`,
  ];
  const parts = (s: string) => s.split(";").map((d) => d.trim()).filter(Boolean);

  test("keeps every declaration KaTeX writes for the formulas", () => {
    let seen = 0;
    for (const tex of formulas) {
      for (const style of styles(tex)) {
        seen++;
        expect(parts(safeStyle(style)), `${tex}: ${style}`).toEqual(parts(style));
      }
    }
    expect(seen).toBeGreaterThan(20);
  });
  test("a fraction keeps what puts its numerator and denominator at different heights", () => {
    const own = styles(String.raw`\frac{a}{b}`).filter((s) => /top:/.test(s));
    expect(own.length).toBeGreaterThan(0);
    for (const s of own) expect(safeStyle(s)).toMatch(/top:/);
  });
  test("a page-covering box with a picture does not pass", () => {
    expect(safeStyle("position:fixed;top:0;background:url(x)")).not.toMatch(/fixed|url|background|position/);
  });
  test("a formula cannot cover or push away the screen with a huge length", () => {
    for (const tex of [String.raw`\rule{500em}{500em}`, String.raw`\kern{-9999em}x`, String.raw`\raisebox{-300em}{x}`]) {
      const all = styles(tex);
      const huge = /(^|[^.\d])\d{3,}(\.\d+)?em/;
      expect(all.some((style) => huge.test(style)), tex).toBe(true);
      for (const style of all) expect(safeStyle(style), tex).not.toMatch(huge);
    }
    expect(safeStyle("width:100%;margin-left:-0.1667em;color:#123456")).toBe("width:100%;margin-left:-0.1667em;color:#123456");
  });
  test("position is only relative", () => {
    expect(safeStyle("position:relative;top:-0.2em")).toBe("position:relative;top:-0.2em");
    expect(safeStyle("position:absolute")).toBe("");
  });
  test("a value that can load or run something is dropped, the rest stays", () => {
    expect(safeStyle("color:red;width:expression(alert(1));height:1em")).toBe("color:red;height:1em");
    expect(safeStyle("color:url(http://x/y)")).toBe("");
    expect(safeStyle(String.raw`margin-left:1em;color:\72 ed`)).toBe("margin-left:1em");
    expect(safeStyle("color:red;height:@import 'x'")).toBe("color:red");
    expect(safeStyle("color:javascript:alert(1)")).toBe("");
  });
  test("properties outside the list and junk are dropped", () => {
    expect(safeStyle("behavior:red;z-index:9;content:'x';font-size:2em")).toBe("font-size:2em");
    expect(safeStyle("")).toBe("");
    expect(safeStyle(";;:;color")).toBe("");
  });
});
