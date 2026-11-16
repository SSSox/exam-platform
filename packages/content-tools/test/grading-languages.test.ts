import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bankTerms, grade } from "@exam/core";
import { editDistance } from "../../core/src/match.ts";
import { loadBank } from "../src/index.ts";
import { DEMO, SEMESTER } from "./demo.ts";

// The geography bank is written in English and translated into Russian through sidecars.
describe("typed grading with a multilingual bank", () => {
  const { questions } = loadBank(join(DEMO, SEMESTER, "geography"))!;
  const options = { scoring: "exact" as const, bankTerms: bankTerms(questions) };
  const typed = (id: number, ...texts: string[]) => grade(questions.find((q) => q.id === id)!, { mode: "typed", texts }, options);

  test.each<[number, string[]]>([
    [1, ["Pacific"]],
    [1, ["pacific ocean"]],
    [1, ["Тихий"]],
    [1, ["Тихий океан"]],
    [4, ["Nile"]],
    [4, ["Нил"]],
    [6, ["Canberra"]],
    [6, ["Канберра"]],
    [8, ["Equator"]],
    [8, ["Экватор"]],
    [2, ["Antarctica", "Australia"]],
    [2, ["Австралия", "Антарктида"]],
    [2, ["Антарктида", "Australia"]],
  ])("question %i accepts %j in its own language", (id, texts) => {
    expect(typed(id, ...texts).correct).toBe(true);
  });

  test.each<[number, string[]]>([
    [1, ["Atlantic"]],
    [1, ["Атлантический"]],
    [4, ["Blue Nile"]],
    [4, ["Голубой Нил"]],
    [4, ["Niger"]],
    [6, ["Sydney"]],
    [8, ["Prime Meridian"]],
    [2, ["Antarctica", "Antarctica"]],
    [2, ["Австралия", "Австралия"]],
  ])("question %i rejects %j", (id, texts) => {
    expect(typed(id, ...texts).correct).toBe(false);
  });

  test("repeated grading gives identical results (memoised terms do not leak between calls)", () => {
    const first = typed(4, "river Nile");
    expect(typed(4, "Niger")).toMatchObject({ correct: false });
    expect(typed(4, "river Nile")).toEqual(first);
  });
});

describe("editDistance limit", () => {
  const words = ["рецептор", "рецептр", "receptor", "recpetor", "", "а", "сенсибилизация", "сенсибелизация"];
  test("matches the full distance up to the limit and exceeds it beyond", () => {
    for (const a of words) for (const b of words) {
      const full = editDistance(a, b);
      for (const limit of [0, 1, 2]) {
        const capped = editDistance(a, b, limit);
        if (full <= limit) expect(capped).toBe(full);
        else expect(capped).toBeGreaterThan(limit);
      }
    }
  });
});
