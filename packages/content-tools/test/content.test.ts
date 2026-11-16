import { afterAll, describe, expect, test } from "vitest";
import { Bank, QuestionFile } from "@exam/schema";
import { migrateV1, restoreV1, validateContent } from "../src/index.ts";
import { DEMO, cleanTemp, tempDir, writeTree } from "./demo.ts";

afterAll(cleanTemp);

const question = (id: number, topic_id: number, type: string, correct: string[], extra = {}) => ({
  id, topic_id, type, question: `Вопрос ${id}`, instruction: type === "single_choice" ? "Один." : "Все.",
  options: [{ id: "A", text: "а" }, { id: "B", text: "б" }], correct_answers: correct,
  source_references: [{ file: "Лекции/1.docx", units: ["p1"] }], ...extra,
});

const v1 = () => ({
  schema_version: "1.0", subject: "Тест", language: "ru", question_count: 3, single_choice_count: 2, multiple_choice_count: 1,
  instructions: { options_per_question: 2, single_choice: "Выберите один.", multiple_choice: "Выберите все.", difficulty: "difficulty_level: 1 — знание; 2 — анализ." },
  exam_requirements: { ticket_question_count: 3, notes: ["заметка"] },
  topics: [{ id: 1, name: "Первая", question_count: 2 }, { id: 2, name: "Вторая", question_count: 1 }],
  sources: [{ id: "L1" }], content_notes: ["примечание"], difficulty_counts: { "1": 2, "2": 1 },
  questions: [
    question(1, 1, "single_choice", ["A"], { difficulty_level: 1 }),
    question(2, 2, "multiple_choice", ["A", "B"], { difficulty_level: 2 }),
    question(3, 1, "single_choice", ["B"], { difficulty_level: 1 }),
  ],
});

describe("migration from 1.0", () => {
  test("is lossless: the original can be rebuilt field for field", () => {
    const { bank, files } = migrateV1(v1(), "uni/test");
    expect(Bank.safeParse(bank).success).toBe(true);
    for (const file of files.values()) expect(QuestionFile.safeParse(file).success).toBe(true);
    expect([...files.keys()]).toEqual(["t01.json", "t02.json"]);
    expect(bank.difficulty_scale).toEqual([{ level: 1, title: "Знание" }, { level: 2, title: "Анализ" }]);
    expect(restoreV1(bank, files.values())).toEqual(v1());
  });

  test("refuses data it has no place for", () => {
    expect(() => migrateV1({ ...v1(), mystery: 1 }, "uni/test")).toThrow(/mystery/);
    const odd = v1();
    odd.questions[2]!.instruction = "Иначе.";
    expect(() => migrateV1(odd, "uni/test")).toThrow(/question 3/);
  });
});

/** A small content repository in the folder layout: node `uni` holds the migrated bank `uni/test`. */
function repo(mutate: (files: Record<string, any>) => void = () => {}) {
  const { bank, files } = migrateV1(v1(), "uni/test");
  const out: Record<string, any> = {
    "catalog.json": { format: "exambank/2", kinds: { university: { title: { ru: "Университет" } }, semester: { title: { ru: "Семестр" } } } },
    "uni/node.json": { kind: "university", title: { ru: "Вуз" } },
    "uni/test/bank.json": bank,
  };
  for (const [name, file] of files) out[`uni/test/questions/${name}`] = file;
  mutate(out);
  return validateContent(writeTree(tempDir(), out));
}

const Q1 = "uni/test/questions/t01.json";
const Q2 = "uni/test/questions/t02.json";

describe("validation", () => {
  test("a migrated bank inside a node is valid", () => {
    expect(repo()).toEqual({ errors: [], banks: 1, questions: 3 });
  });

  test("the demo content is valid", () => {
    const result = validateContent(DEMO);
    expect(result.errors).toEqual([]);
    expect(result.banks).toBe(5);
  });

  test.each<[string, (f: Record<string, any>) => void, RegExp]>([
    ["duplicate id", (f) => (f[Q2].questions[0].id = 1), /duplicate id/],
    ["unknown topic", (f) => (f[Q1].questions[0].topic_id = 9), /unknown topic_id 9/],
    ["key outside options", (f) => (f[Q1].questions[0].correct_answers = ["Z"]), /not an option/],
    ["two keys in single choice", (f) => (f[Q1].questions[0].correct_answers = ["A", "B"]), /exactly one/],
    ["level outside the scale", (f) => (f[Q1].questions[0].difficulty_level = 7), /difficulty_scale/],
    ["free input not covering the key", (f) => (f[Q2].questions[0].free_input = { answers: [{ for: "A", accept: { ru: ["а"] } }] }), /cover exactly/],
    ["unknown field", (f) => (f[Q1].questions[0].hint = "x"), /t01\.json/],
    ["question file naming another bank", (f) => (f[Q1].bank = "uni/other"), /does not match "uni\/test"/],
    ["node with unknown kind", (f) => (f["uni/node.json"].kind = "galaxy"), /uni\/node\.json: kind "galaxy" is not in catalog/],
  ])("rejects %s", (_name, mutate, message) => {
    expect(repo(mutate).errors.join("\n")).toMatch(message);
  });

  describe("folder layout", () => {
    const withCopy = (f: Record<string, any>, to: string) => {
      for (const path of Object.keys(f)) if (path.startsWith("uni/test/")) f[path.replace("uni/test/", `${to}/`)] = structuredClone(f[path]);
    };

    test("the bank id is not tied to the folder path, but question files must name it", () => {
      expect(repo((f) => (f["uni/test/bank.json"].id = "elsewhere/renamed")).errors.join("\n")).toMatch(/does not match "elsewhere\/renamed"/);
      expect(repo((f) => {
        f["uni/test/bank.json"].id = "elsewhere/renamed";
        for (const name of ["t01", "t02"]) f[`uni/test/questions/${name}.json`].bank = "elsewhere/renamed";
      })).toEqual({ errors: [], banks: 1, questions: 3 });
    });

    test("rejects two banks with the same id", () => {
      const result = repo((f) => withCopy(f, "uni/copy"));
      expect(result.errors.join("\n")).toMatch(/bank\.json: bank id "uni\/test" is already used by uni\/(copy|test)/);
    });

    test("two banks with different ids are both counted", () => {
      const result = repo((f) => {
        withCopy(f, "uni/copy");
        f["uni/copy/bank.json"].id = "uni/copy";
        for (const name of ["t01", "t02"]) f[`uni/copy/questions/${name}.json`].bank = "uni/copy";
      });
      expect(result).toEqual({ errors: [], banks: 2, questions: 6 });
    });

    test("rejects a bank whose id is also the id of a node", () => {
      const result = repo((f) => {
        f["uni/clash/node.json"] = { kind: "semester", title: { ru: "Семестр" } };
        f["uni/clash/test2/bank.json"] = { ...structuredClone(f["uni/test/bank.json"]), id: "uni/clash" };
        for (const name of ["t01", "t02"]) f[`uni/clash/test2/questions/${name}.json`] = { ...structuredClone(f[`uni/test/questions/${name}.json`]), bank: "uni/clash" };
      });
      expect(result.errors.join(String.fromCharCode(10))).toMatch(/uni\/clash\/test2\/bank\.json: bank id "uni\/clash" is also the id of a node/);
    });

    test("rejects a bank in the content root", () => {
      const result = repo((f) => {
        for (const path of Object.keys(f)) if (path.startsWith("uni/test/")) { f[path.replace("uni/test/", "")] = f[path]; delete f[path]; }
      });
      expect(result.errors.join("\n")).toMatch(/bank\.json: a bank must live inside a node folder/);
    });

    test("rejects a bank folder directly under the content root", () => {
      const result = repo((f) => {
        for (const path of Object.keys(f)) if (path.startsWith("uni/test/")) { f[path.replace("uni/", "")] = f[path]; delete f[path]; }
      });
      expect(result.errors.join("\n")).toMatch(/test: a bank must live inside a node folder/);
    });

    test("rejects a node without children and banks", () => {
      const result = repo((f) => (f["uni/empty/node.json"] = { kind: "semester", title: { ru: "Пусто" } }));
      expect(result.errors.join("\n")).toMatch(/uni\/empty: node has no child nodes and no banks/);
    });

    test("rejects names in `items` that are not child folders, and repeated names", () => {
      const unknown = repo((f) => (f["uni/node.json"].items = ["test", "ghost"]));
      expect(unknown.errors.join("\n")).toMatch(/uni\/node\.json: items: "ghost" is not a child folder/);
      const twice = repo((f) => (f["uni/node.json"].items = ["test", "test"]));
      expect(twice.errors.join("\n")).toMatch(/items: "test" is listed twice/);
      expect(repo((f) => (f["uni/node.json"].items = ["test"])).errors).toEqual([]);
    });
  });
});
