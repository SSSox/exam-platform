import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { bankTerms, grade, type Response } from "@exam/core";
import { loadBank } from "../src/index.ts";
import { DEMO, SEMESTER } from "./demo.ts";

// What a learner would really type or tick, graded against the demo banks.
const banks = {
  arithmetic: `${SEMESTER}/arithmetic`,
  physics: `${SEMESTER}/natural-sciences/physics`,
  chemistry: `${SEMESTER}/natural-sciences/chemistry`,
  astronomy: "demo/science/bachelor/earth-sciences/year-1/semester-1/astronomy",
};

function gradeIn(name: keyof typeof banks, scoring: "exact" | "partial" = "exact") {
  const { questions } = loadBank(join(DEMO, banks[name]))!;
  const options = { scoring, bankTerms: bankTerms(questions) };
  return (id: number, response: Response) => grade(questions.find((q) => q.id === id)!, response, options);
}
const typed = (...texts: string[]): Response => ({ mode: "typed", texts });
const choice = (...selected: string[]): Response => ({ mode: "choice", selected });

describe("typed answers", () => {
  test.each<[keyof typeof banks, number, string[]]>([
    ["arithmetic", 6, ["Equilateral"]],
    ["arithmetic", 6, ["an equilateral triangle"]],
    ["physics", 1, ["Newton"]],
    ["physics", 1, ["newtons"]],
    ["physics", 5, ["kinetic energy"]],
    ["physics", 5, ["kinetik energy"]],
    ["physics", 6, ["in a vacuum"]],
    ["chemistry", 5, ["h2o"]],
    ["chemistry", 6, ["CO2"]],
    ["chemistry", 6, ["Carbon dioxide"]],
    ["astronomy", 1, ["mercury"]],
    ["astronomy", 5, ["The Moon"]],
    ["astronomy", 6, ["sun"]],
  ])("%s question %i accepts %j", (name, id, texts) => {
    expect(gradeIn(name)(id, typed(...texts)).correct).toBe(true);
  });

  test.each<[keyof typeof banks, number, string[]]>([
    ["arithmetic", 5, ["sum"]],
    ["arithmetic", 5, ["factor"]],
    ["arithmetic", 5, ["produkt"]], // `typos: "off"` on this question
    ["arithmetic", 6, ["isosceles"]],
    ["physics", 1, ["Pascal"]],
    ["physics", 5, ["potential energy"]],
    ["chemistry", 5, ["H2O2"]],
    ["chemistry", 6, ["Oxygen"]],
    ["astronomy", 1, ["Venus"]],
    ["astronomy", 5, ["Sun"]],
    ["astronomy", 6, ["Moon"]],
  ])("%s question %i rejects %j", (name, id, texts) => {
    expect(gradeIn(name)(id, typed(...texts)).correct).toBe(false);
  });
});

describe("numeric answers", () => {
  test.each<[string, boolean]>([
    ["30", true],
    [" 30 ", true],
    ["30.0", true],
    ["31", false],
    ["", false],
    ["thirty", false],
  ])("exact value: %j is %s", (text, ok) => {
    expect(gradeIn("arithmetic")(3, typed(text)).correct).toBe(ok);
  });

  test.each<[string, boolean]>([
    ["7.1", true],
    ["7,1", true],
    ["7.07", true],
    ["7.2", false],
    ["7", false],
  ])("tolerance 0.05 around 7.1: %j is %s", (text, ok) => {
    expect(gradeIn("arithmetic")(4, typed(text)).correct).toBe(ok);
  });

  test("a unit on the answer does not change what is typed", () => {
    expect(gradeIn("physics")(4, typed("75")).correct).toBe(true);
  });
});

describe("choice answers", () => {
  test("a multiple-choice question needs the whole key under exact scoring", () => {
    const g = gradeIn("arithmetic");
    expect(g(2, choice("A", "C")).correct).toBe(true);
    expect(g(2, choice("C", "A")).correct).toBe(true);
    expect(g(2, choice("A")).correct).toBe(false);
    expect(g(2, choice("A", "B", "C")).correct).toBe(false);
  });

  test("partial scoring gives credit for each right pick and takes it back for each wrong one", () => {
    const g = gradeIn("physics", "partial");
    expect(g(3, choice("A")).score).toBeCloseTo(1 / 3);
    expect(g(3, choice("A", "B")).score).toBeCloseTo(2 / 3);
    expect(g(3, choice("A", "B", "D")).score).toBe(1);
    expect(g(3, choice("A", "C")).score).toBe(0);
  });

  test("a question without `free_input` has no typed mode; an open one is self-checked only", () => {
    expect(() => gradeIn("physics")(2, typed("velocity"))).toThrow(/does not support mode typed/);
    expect(gradeIn("arithmetic")(7, { mode: "self_check", knew: true }).correct).toBe(true);
  });
});
