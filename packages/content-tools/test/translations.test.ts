import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { Bank, QuestionFile } from "@exam/schema";
import { compileContent, loadBank, mergeTranslations, migrateV1, restoreV1, validateContent } from "../src/index.ts";
import { SEMESTER, cleanTemp, copyDemo, tempDir, writeTree } from "./demo.ts";

afterAll(cleanTemp);

const question = (id: number, topic_id: number, correct: string[], extra = {}) => ({
  id, topic_id, type: correct.length > 1 ? "multiple_choice" : "single_choice", question: `Вопрос ${id}`,
  instruction: correct.length > 1 ? "Все." : "Один.",
  options: [{ id: "A", text: "а" }, { id: "B", text: "б" }], correct_answers: correct,
  source_references: [{ file: "Лекции/1.docx", units: ["p1"] }], difficulty_level: 1, ...extra,
});

const v1 = () => ({
  schema_version: "1.0", subject: "Тест", language: "ru", question_count: 3, single_choice_count: 2, multiple_choice_count: 1,
  instructions: { options_per_question: 2, single_choice: "Выберите один.", multiple_choice: "Выберите все.", difficulty: "difficulty_level: 1 — знание." },
  topics: [{ id: 1, name: "Первая", question_count: 2 }, { id: 2, name: "Вторая", question_count: 1 }],
  difficulty_counts: { "1": 3 },
  questions: [question(1, 1, ["A"]), question(2, 2, ["A", "B"]), question(3, 1, ["B"])],
});

const sidecar = (locale: string, topic_id: number, questions: Record<string, unknown>) =>
  ({ bank: "uni/test", locale, topic_id, topic_name: `Topic ${topic_id}`, questions });
const tr = (n: number, free_input?: unknown) => ({ question: `Question ${n}`, options: { A: "a", B: "b" }, ...(free_input ? { free_input } : {}) });

/** Writes a v2 bank (question 1 has free_input) inside node `uni`, plus the given sidecars; returns the root. */
function setup(sidecars: Record<string, unknown>) {
  const { bank, files } = migrateV1(v1(), "uni/test");
  (files.get("t01.json")!.questions[0] as any).free_input = { question: "Какая буква первая?", answers: [{ for: "A", accept: { ru: ["а"] } }] };
  const out: Record<string, unknown> = {
    "catalog.json": { format: "exambank/2", kinds: { university: { title: { ru: "Вуз" } } } },
    "uni/node.json": { kind: "university", title: { ru: "Вуз" } },
    "uni/test/bank.json": bank,
    ...Object.fromEntries([...files].map(([n, f]) => [`uni/test/questions/${n}`, f])),
    ...sidecars,
  };
  return writeTree(tempDir("exam-merge-"), out);
}
const T = "uni/test/translations/en";
const read = (root: string, path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const snapshot = (root: string) => ["bank.json", "questions/t01.json", "questions/t02.json"].map((f) => readFileSync(join(root, "uni/test", f), "utf8"));

const full = (): Record<string, any> => ({
  [`${T}/bank.json`]: { bank: "uni/test", locale: "en", subject: "Test", difficulty_scale: { "1": "Knowledge" } },
  [`${T}/t01.json`]: sidecar("en", 1, { "1": tr(1, { question: "Which letter is first?", accept: { A: ["a"] }, reject: ["b"] }), "3": tr(3) }),
  [`${T}/t02.json`]: sidecar("en", 2, { "2": tr(2) }),
});

describe("merge-translations", () => {
  test("folds translations into maps, keeps the original text and key order", () => {
    const root = setup(full());
    const keysBefore = Object.keys(read(root, "uni/test/questions/t01.json").questions[0]);
    const r = mergeTranslations(root);
    expect(r).toMatchObject({ errors: [], warnings: [], sidecars: 3 });

    const bank = read(root, "uni/test/bank.json");
    expect(bank.subject).toEqual({ ru: "Тест", en: "Test" });
    expect(bank.topics[0].name).toEqual({ ru: "Первая", en: "Topic 1" });
    expect(bank.difficulty_scale[0].title).toEqual({ ru: "Знание", en: "Knowledge" });
    expect(bank.translations).toEqual({ en: "machine" });

    const q = read(root, "uni/test/questions/t01.json").questions[0];
    expect(q.question).toEqual({ ru: "Вопрос 1", en: "Question 1" });
    expect(q.options[1].text).toEqual({ ru: "б", en: "b" });
    expect(q.free_input.question).toEqual({ ru: "Какая буква первая?", en: "Which letter is first?" });
    expect(q.free_input.answers[0].accept).toEqual({ ru: ["а"], en: ["a"] });
    expect(q.free_input.reject).toEqual({ en: ["b"] });
    expect(Object.keys(q)).toEqual(keysBefore);
    expect(readFileSync(join(root, "uni/test/bank.json"), "utf8").endsWith("}\n")).toBe(true);
  });

  test("running twice changes nothing; a reviewed locale stays reviewed", () => {
    const root = setup(full());
    const bankPath = join(root, "uni/test/bank.json");
    const bank = read(root, "uni/test/bank.json");
    bank.translations = { en: "reviewed" };
    writeFileSync(bankPath, JSON.stringify(bank, null, 2) + "\n");
    mergeTranslations(root);
    const once = snapshot(root);
    const again = mergeTranslations(root);
    expect(snapshot(root)).toEqual(once);
    expect(again.written).toBe(0);
    expect(read(root, "uni/test/bank.json").translations).toEqual({ en: "reviewed" });
  });

  test("restoreV1 of a merged bank equals the original; content validates and compiles", () => {
    const root = setup(full());
    mergeTranslations(root);
    const errors: string[] = [];
    const loaded = loadBank(join(root, "uni/test"), errors)!;
    expect(errors).toEqual([]);
    expect(restoreV1(loaded.bank, loaded.files.values())).toEqual(v1());
    expect(validateContent(root).errors).toEqual([]);
    expect(() => compileContent(root, tempDir("exam-dist-"))).not.toThrow();
    expect(Bank.safeParse(loaded.bank).success).toBe(true);
    for (const f of loaded.files.values()) expect(QuestionFile.safeParse(f).success).toBe(true);
  });

  test("partial translation: warns about the gaps, merges the rest, content validates", () => {
    const root = setup({ [`${T}/t01.json`]: sidecar("en", 1, { "1": tr(1) }) });
    const r = mergeTranslations(root);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/no translation for questions 3/);
    const q = read(root, "uni/test/questions/t01.json").questions;
    expect(q[0].question.en).toBe("Question 1");
    expect(q[1].question).toBe("Вопрос 3");
    expect(validateContent(root).errors).toEqual([]);
  });

  test.each<[string, (s: Record<string, any>) => void, RegExp]>([
    ["unknown question id", (s) => (s[`${T}/t01.json`].questions["99"] = tr(99)), /question 99: no such question/],
    ["missing option", (s) => delete s[`${T}/t01.json`].questions["3"].options.B, /missing options B/],
    ["extra option", (s) => (s[`${T}/t01.json`].questions["3"].options.Z = "z"), /unknown options Z/],
    ["empty string", (s) => (s[`${T}/t01.json`].questions["3"].question = " "), /question text is empty/],
    ["bank not matching the bank id", (s) => (s[`${T}/t02.json`].bank = "uni/other"), /does not match the bank id "uni\/test"/],
    ["locale not matching the path", (s) => (s[`${T}/t02.json`].locale = "kk"), /locale "kk" does not match/],
    ["free_input on a question without one", (s) => (s[`${T}/t01.json`].questions["3"].free_input = { accept: { A: ["a"] } }), /has no free_input/],
    ["empty accept list", (s) => (s[`${T}/t01.json`].questions["1"].free_input.accept.A = []), /accept\.A must be/],
  ])("reports %s and writes nothing", (_name, mutate, message) => {
    const sidecars = full();
    mutate(sidecars);
    const root = setup(sidecars);
    const before = snapshot(root);
    const r = mergeTranslations(root);
    expect(r.errors.join("\n")).toMatch(message);
    expect(snapshot(root)).toEqual(before);
  });

  test("a source free_input without question gets no translated question", () => {
    const root = setup(full());
    const path = join(root, "uni/test/questions/t01.json");
    const file = read(root, "uni/test/questions/t01.json");
    delete file.questions[0].free_input.question;
    writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
    mergeTranslations(root);
    expect(read(root, "uni/test/questions/t01.json").questions[0].free_input.question).toBeUndefined();
  });

  test("a sidecar must sit in <locale>/ inside the bank folder", () => {
    const root = setup({ "uni/test/translations/loose.json": { bank: "uni/test", locale: "en" } });
    expect(mergeTranslations(root).errors.join("\n")).toMatch(/uni\/test\/translations\/loose\.json: expected translations\/<locale>\/<file>\.json/);
  });

  test("a layout problem is an error and nothing is written", () => {
    const sidecars = full();
    sidecars["stray/bank.json"] = { id: "stray" };
    const root = setup(sidecars);
    const before = snapshot(root);
    const r = mergeTranslations(root);
    expect(r.errors.join("\n")).toMatch(/stray: a bank must live inside a node folder/);
    expect(r).toMatchObject({ sidecars: 0, written: 0 });
    expect(snapshot(root)).toEqual(before);
  });

  test("a sidecar that is not a JSON object is an error, not a crash", () => {
    for (const bad of ["null", "[]", "42"]) {
      const root = setup({ [`${T}/t01.json`]: bad });
      expect(mergeTranslations(root).errors.join(String.fromCharCode(10))).toMatch(/must be a JSON object/);
    }
  });

  test("a sidecar for the bank's original language is refused", () => {
    const root = setup({ "uni/test/translations/ru/bank.json": { bank: "uni/test", locale: "ru", subject: "Тест" } });
    expect(mergeTranslations(root).errors.join("\n")).toMatch(/locale is the bank's original language/);
  });
});

describe("merge-translations on the demo content", () => {
  test("the shipped content is already merged: sidecars are found inside the bank folder and nothing is rewritten", () => {
    const root = copyDemo();
    const before = readFileSync(join(root, SEMESTER, "geography/bank.json"), "utf8");
    const r = mergeTranslations(root);
    expect(r).toEqual({ errors: [], warnings: [], sidecars: 4, written: 0 });
    expect(readFileSync(join(root, SEMESTER, "geography/bank.json"), "utf8")).toBe(before);
    expect(read(root, `${SEMESTER}/geography/bank.json`).translations).toEqual({ ru: "machine" });
  });

  test("a changed sidecar is folded in once, and a second run changes nothing", () => {
    const root = copyDemo();
    const path = join(root, SEMESTER, "geography/translations/ru/t03.json");
    const side = read(root, `${SEMESTER}/geography/translations/ru/t03.json`);
    side.questions["6"].question = "Как называется столица Австралии?";
    writeFileSync(path, JSON.stringify(side, null, 2) + "\n");

    expect(mergeTranslations(root)).toMatchObject({ errors: [], written: 1 });
    expect(read(root, `${SEMESTER}/geography/questions/t03.json`).questions[0].question).toEqual({
      en: "What is the capital of Australia?",
      ru: "Как называется столица Австралии?",
    });
    expect(mergeTranslations(root).written).toBe(0);
    expect(validateContent(root).errors).toEqual([]);
  });
});
