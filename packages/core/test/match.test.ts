import { describe, expect, test } from "vitest";
import { matchAnswer, normalize, type MatchSpec } from "../src/match.ts";

const check = (input: string, spec: MatchSpec) => matchAnswer(input, spec);

describe("normalisation", () => {
  test("ignores case, spaces, punctuation and ё", () => {
    expect(normalize("  «Творческое»,   ВООБРАЖЕНИЕ!  ")).toBe("творческое воображение");
    expect(normalize("Ещё")).toBe(normalize("еще"));
  });
  test("fixes Latin look-alikes inside Cyrillic words only", () => {
    expect(normalize("aдaптaция")).toBe("адаптация");
    expect(normalize("adaptation")).toBe("adaptation");
  });
});

describe("accepted answers", () => {
  const spec: MatchSpec = { accept: ["творческое"], confusables: ["воссоздающее", "репродуктивное", "пассивное непреднамеренное"] };

  test.each([
    ["Творческое", "exact"],
    ["  творческое. ", "exact"],
    ["творческим", "form"],
    ["творческий", "form"],
    ["творчесоке", "typo"],
    ["творчиское", "typo"],
  ])("%s -> %s", (input, kind) => {
    expect(check(input, spec)).toMatchObject({ ok: true, kind });
  });

  test("a word from the question may be repeated", () => {
    const withContext = { ...spec, context: "…характеризует воображение..." };
    expect(check("творческое воображение", withContext).ok).toBe(true);
    expect(check("творческое мышление", withContext).ok).toBe(false);
  });

  test("distractors and unrelated words are rejected", () => {
    expect(check("воссоздающее", spec).ok).toBe(false);
    expect(check("творческое и воссоздающее", spec).ok).toBe(false);
    expect(check("", spec).ok).toBe(false);
  });

  test("multi-word answers: any order, every word required", () => {
    const multi: MatchSpec = { accept: ["акцентуация характера"] };
    expect(check("характера акцентуация", multi).ok).toBe(true);
    expect(check("акцентуацией характера", multi)).toMatchObject({ ok: true, kind: "form" });
    expect(check("акцентуация", multi).ok).toBe(false);
    expect(check("акцентуация темперамента", multi).ok).toBe(false);
    expect(check("характера акцентуация", { ...multi, ordered: true }).ok).toBe(false);
  });

  test("author synonyms count, unlisted ones do not", () => {
    const syn: MatchSpec = { accept: ["выдержка", "самообладание"] };
    expect(check("самообладание", syn).ok).toBe(true);
    expect(check("терпение", syn).ok).toBe(false);
  });

  test("names with initials", () => {
    const name: MatchSpec = { accept: ["Р. Г. Лотце", "Лотце"], confusables: ["М. Вебер", "М. Фуко"] };
    expect(check("лотце", name).ok).toBe(true);
    expect(check("Р.Г. Лотце", name).ok).toBe(true);
    expect(check("Лотцем", name).ok).toBe(true);
    expect(check("М. Лотце", name).ok).toBe(false);
  });
});

describe("no credit for look-alike terms", () => {
  test.each([
    ["интериоризация", "экстериоризация"],
    ["экстраверсия", "интроверсия"],
    ["гипотимия", "гипертимия"],
    ["социальный", "асоциальный"],
    ["формальная", "неформальная"],
    ["микросреда", "макросреда"],
    ["легальность", "нелегальность"],
  ])("%s is not %s", (accepted, wrong) => {
    expect(check(wrong, { accept: [accepted] }).ok).toBe(false);
    expect(check(accepted, { accept: [wrong] }).ok).toBe(false);
  });

  test("a close neighbour switches typo tolerance off for that answer", () => {
    const spec: MatchSpec = { accept: ["адаптация"], confusables: ["адаптивность", "агравация", "апатия"] };
    expect(check("адаптацию", spec)).toMatchObject({ ok: true, kind: "form" });
    expect(check("адаптивность", spec).ok).toBe(false);
    const crowded: MatchSpec = { accept: ["апперцепция"], confusables: ["перцепция"] };
    expect(check("апперцепция", crowded).ok).toBe(true);
    expect(check("апперцепцию", crowded)).toMatchObject({ ok: true, kind: "form" });
    expect(check("аперцепция", crowded).ok).toBe(false);
    expect(check("перцепция", crowded).ok).toBe(false);
    expect(check("десенсибилизация", { accept: ["сенсибилизация"] }).ok).toBe(false);
    expect(check("сенсибелизация", { accept: ["сенсибилизация"] })).toMatchObject({ ok: true, kind: "typo" });
  });

  test("numbers, dates and short words are exact only", () => {
    expect(check("1879", { accept: ["1879"] }).ok).toBe(true);
    expect(check("1897", { accept: ["1879"] }).ok).toBe(false);
    expect(check("ид", { accept: ["эго"] }).ok).toBe(false);
    expect(check("эга", { accept: ["эго"] }).ok).toBe(false);
  });

  test("typos can be switched off by the author", () => {
    expect(check("творчесоке", { accept: ["творческое"], typos: "off" }).ok).toBe(false);
  });
});

describe("kk and English", () => {
  test("kk letters typed on a Russian layout", () => {
    const kk: MatchSpec = { accept: ["қабылдау"], confusables: ["түйсік", "зейін"] };
    expect(check("қабылдау", kk)).toMatchObject({ ok: true, kind: "exact" });
    expect(check("кабылдау", kk)).toMatchObject({ ok: true, kind: "layout" });
    expect(check("қабылдауды", kk)).toMatchObject({ ok: true, kind: "form" });
    expect(check("зейін", kk).ok).toBe(false);
  });
  test("folding must not merge two real terms", () => {
    expect(check("ұн", { accept: ["үн"] }).ok).toBe(false);
  });
  test("kk negation suffix is not a typo", () => {
    expect(check("саналысыз", { accept: ["саналы"] }).ok).toBe(false);
  });
  test("English plural and typo", () => {
    const en: MatchSpec = { accept: ["sensation"], confusables: ["perception"] };
    expect(check("Sensations", en)).toMatchObject({ ok: true, kind: "form" });
    expect(check("sensaton", en)).toMatchObject({ ok: true, kind: "typo" });
    expect(check("perception", en).ok).toBe(false);
    expect(check("unconscious", { accept: ["conscious"] }).ok).toBe(false);
  });
});

describe("significant one-letter tokens", () => {
  const hep: MatchSpec = { accept: ["гепатит А"] };
  test("a letter designation is required and must be the same", () => {
    expect(check("гепатит в", hep).ok).toBe(false);
    expect(check("гепатит в", { ...hep, confusables: ["гепатит В"] }).ok).toBe(false);
    expect(check("гепатит а", hep).ok).toBe(true);
    expect(check("Гепатит А", hep).ok).toBe(true);
    expect(check("гепатит", hep).ok).toBe(false);
    expect(check("витамин", { accept: ["витамин С"] }).ok).toBe(false);
    expect(check("витамин с", { accept: ["витамин С"] }).ok).toBe(true);
  });
  test("an uppercase letter inside a phrase is a designation", () => {
    const grp: MatchSpec = { accept: ["группа А крови"] };
    expect(check("группа в крови", grp).ok).toBe(false);
    expect(check("группа а крови", grp).ok).toBe(true);
  });
  test("first uppercase letter before a conjunction", () => {
    expect(check("в и с", { accept: ["В и С"] }).ok).toBe(true);
    expect(check("с", { accept: ["В и С"] }).ok).toBe(false);
  });
  test("Latin look-alike of the letter is the same designation", () => {
    expect(check("гепатит a", hep).ok).toBe(true);
    expect(check("hepatitis a", { accept: ["hepatitis A"] }).ok).toBe(true);
    expect(check("hepatitis", { accept: ["hepatitis A"] }).ok).toBe(false);
  });
  test("a lone Latin letter in a Latin phrase is not the Cyrillic preposition it looks like", () => {
    for (const answer of ["vitamin C", "Vitamin C deficiency", "blood type O", "Y chromosome"]) {
      expect(check(answer, { accept: [answer] }).ok, answer).toBe(true);
      expect(check(answer.toLowerCase(), { accept: [answer] }).ok, answer).toBe(true);
    }
    expect(check("vitamin", { accept: ["vitamin C"] }).ok).toBe(false);
    expect(check("chromosome", { accept: ["Y chromosome"] }).ok).toBe(false);
    expect(check("vitamin D", { accept: ["vitamin C"] }).ok).toBe(false);
  });
  test("a Latin letter that opens a Cyrillic phrase is a designation, not a preposition to skip", () => {
    expect(check("Y-хромосома", { accept: ["Y-хромосома"] }).ok).toBe(true);
    expect(check("хромосома", { accept: ["Y-хромосома"] }).ok).toBe(false);
    expect(check("антиген", { accept: ["O-антиген"] }).ok).toBe(false);
    expect(check("А-реактивный белок", { accept: ["C-реактивный белок"] }).ok).toBe(false);
  });
  test("a phrase with the designation letter also as a preposition accepts itself", () => {
    for (const answer of ["препарат с витамином С", "продукты с витамином C", "в группе В", "Витамин В в печени", "vitamin A in a diet", "тип крови и резус И"]) {
      expect(check(answer, { accept: [answer] }).ok, answer).toBe(true);
    }
    expect(check("препарат с витамином", { accept: ["препарат с витамином С"] }).ok).toBe(false);
  });
  test("a Latin letter typed in a Cyrillic phrase is still the Cyrillic designation", () => {
    expect(check("витамин C", { accept: ["витамин C"] }).ok).toBe(true);
    expect(check("витамин С", { accept: ["витамин C"] }).ok).toBe(true);
    expect(check("витамин", { accept: ["витамин C"] }).ok).toBe(false);
  });
});

describe("ordinary stop words may be skipped", () => {
  test("B", () => {
    expect(check("кровь лимфа", { accept: ["кровь и лимфа"] }).ok).toBe(true);
    expect(check("жизнь городе", { accept: ["жизнь в городе"] }).ok).toBe(true);
    expect(check("А также кровь", { accept: ["кровь"] }).ok).toBe(false);
  });
});

describe("conjunction classes", () => {
  test.each([
    ["кровь или лимфа", "кровь и лимфа"],
    ["кровь и лимфа", "кровь или лимфа"],
    ["blood or lymph", "blood and lymph"],
    ["blood and lymph", "blood or lymph"],
    ["қан немесе лимфа", "қан және лимфа"],
    ["қан және лимфа", "қан немесе лимфа"],
  ])("%s is not %s", (input, accepted) => {
    expect(check(input, { accept: [accepted] }).ok).toBe(false);
  });
  test("same class and omitted conjunction still pass", () => {
    expect(check("кровь и лимфа", { accept: ["кровь и лимфа"] }).ok).toBe(true);
    expect(check("кровь или лимфа", { accept: ["кровь или лимфа"] }).ok).toBe(true);
    expect(check("кровь лимфа", { accept: ["кровь или лимфа"] }).ok).toBe(true);
  });
  test("another accepted answer with the matching class wins", () => {
    expect(check("кровь или лимфа", { accept: ["кровь и лимфа", "кровь или лимфа"] }).ok).toBe(true);
  });
});

describe("wrong options", () => {
  test("correct answer plus a wrong one is rejected", () => {
    const spec: MatchSpec = { accept: ["кислород"], confusables: ["азот"], wrong: ["азот"], context: "Какой газ тяжелее: кислород или азот?" };
    expect(check("кислород азот", spec).ok).toBe(false);
    expect(check("кислород", spec).ok).toBe(true);
  });
  test("wrong letter designation", () => {
    expect(check("гепатит в", { accept: ["гепатит А"], wrong: ["гепатит В"] }).ok).toBe(false);
    expect(check("гепатит а", { accept: ["гепатит А"], wrong: ["гепатит В"] }).ok).toBe(true);
  });
  test("a correct answer may contain the distractor itself", () => {
    expect(check("серная кислота", { accept: ["серная кислота"], wrong: ["кислота"] }).ok).toBe(true);
  });
  test("stop words count when comparing with wrong options", () => {
    expect(check("маған мен", { accept: ["маған"], wrong: ["мен"] }).ok).toBe(false);
    expect(check("маған", { accept: ["маған"], wrong: ["мен"] }).ok).toBe(true);
  });
});

test("a repeated token of a wrong option needs as many tokens in the correct answer", () => {
  const spec: MatchSpec = { accept: ["қып-қызыл"], wrong: ["қызыл-қызыл"] };
  expect(check("қып-қызыл", spec).ok).toBe(true);
  expect(check("қып-қызыл қызыл-қызыл", spec).ok).toBe(false);
});

test("the correct answer excuses a wrong option only if it holds that very word", () => {
  expect(check("тоғызда тоғызды", { accept: ["тоғызда"], wrong: ["тоғызды"], typos: "off" }).ok).toBe(false);
  expect(check("тоғызда", { accept: ["тоғызда"], wrong: ["тоғызды"], typos: "off" }).ok).toBe(true);
});
