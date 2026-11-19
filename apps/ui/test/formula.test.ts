import { describe, expect, it } from "vitest";
import { needsMath } from "../src/formula.ts";

describe("needsMath", () => {
  it("is true only for a text that can hold a formula", () => {
    expect(needsMath("Find $x^2$")).toBe(true);
    expect(needsMath("$$a$$")).toBe(true);
    expect(needsMath("Plain *markdown* text")).toBe(false);
    expect(needsMath("")).toBe(false);
  });
});
