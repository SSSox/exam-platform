import { describe, expect, test } from "vitest";
import { pick } from "../src/pick.ts";

describe("pick", () => {
  test("follows the chain, then the bank language, then any text there is", () => {
    expect(pick({ ru: "Тема", en: "Topic" }, ["kk", "en"], "ru")).toEqual({ text: "Topic", locale: "en" });
    expect(pick({ ru: "Тема", en: "Topic" }, ["kk"], "ru")).toEqual({ text: "Тема", locale: "ru" });
    expect(pick({ de: "Thema" }, ["kk"], "ru")).toEqual({ text: "Thema", locale: "de" });
    expect(pick("Тема", ["en"], "ru")).toEqual({ text: "Тема", locale: "ru" });
  });

  test("an empty localized object gives an empty text instead of throwing", () => {
    expect(pick({}, ["kk", "en"], "ru")).toEqual({ text: "", locale: "ru" });
  });

  test("a language named like an inherited property finds no text in an empty object", () => {
    expect(pick({}, ["toString"], "constructor")).toEqual({ text: "", locale: "constructor" });
    expect(pick({ ru: "Тема" }, ["__proto__"], "hasOwnProperty")).toEqual({ text: "Тема", locale: "ru" });
  });
});
