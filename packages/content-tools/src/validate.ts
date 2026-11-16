import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { Bank, Catalog, QuestionFile, type Question } from "@exam/schema";
import { bankTerms, grade } from "@exam/core";
import type { ZodType } from "zod";
import { discoverContent, listBanks, listNodes } from "./discover.ts";

export interface LoadedBank {
  bank: Bank;
  files: Map<string, QuestionFile>;
  questions: Question[];
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function parse<T>(schema: ZodType<T>, path: string, errors: string[]): T | undefined {
  let data: unknown;
  try {
    data = readJson(path);
  } catch (e) {
    errors.push(`${path}: ${(e as Error).message}`);
    return undefined;
  }
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  for (const issue of result.error.issues) errors.push(`${path}: ${issue.path.join(".")}: ${issue.message}`);
  return undefined;
}

export function loadBank(bankDir: string, errors: string[] = []): LoadedBank | undefined {
  const bank = parse(Bank, join(bankDir, "bank.json"), errors);
  const dir = join(bankDir, "questions");
  const files = new Map<string, QuestionFile>();
  for (const name of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []) {
    const file = parse(QuestionFile, join(dir, name), errors);
    if (file) files.set(name, file);
  }
  if (!bank) return undefined;
  return { bank, files, questions: [...files.values()].flatMap((f) => f.questions) };
}

function checkBank({ bank, files, questions }: LoadedBank, where: string, errors: string[]) {
  const err = (msg: string) => errors.push(`${where}: ${msg}`);
  for (const [name, file] of files) if (file.bank !== bank.id) err(`${name}: bank "${file.bank}" does not match "${bank.id}"`);

  const topics = new Set(bank.topics.map((t) => t.id));
  const levels = bank.difficulty_scale && new Set(bank.difficulty_scale.map((s) => s.level));
  const seen = new Set<number>();
  for (const q of questions) {
    const qerr = (msg: string) => err(`question ${q.id}: ${msg}`);
    if (seen.has(q.id)) qerr("duplicate id");
    seen.add(q.id);
    if (!topics.has(q.topic_id)) qerr(`unknown topic_id ${q.topic_id}`);
    if (levels && q.difficulty_level != null && !levels.has(q.difficulty_level)) qerr(`difficulty_level ${q.difficulty_level} is not in difficulty_scale`);
    if (q.type !== "single_choice" && q.type !== "multiple_choice") continue;

    const ids = q.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length) qerr("duplicate option id");
    for (const a of q.correct_answers) if (!ids.includes(a)) qerr(`correct answer ${a} is not an option`);
    if (q.type === "single_choice" && q.correct_answers.length !== 1) qerr("single_choice needs exactly one correct answer");
    if (q.free_input) {
      const covered = q.free_input.answers.map((a) => a.for);
      const want = [...q.correct_answers].sort().join();
      if ([...covered].sort().join() !== want) qerr(`free_input.answers must cover exactly the correct answers (${want})`);
    }
  }
  if (questions.length === 0) err("bank has no questions");
  lintAnswers(bank, questions, err);
}

/**
 * Typed answers must behave as the author expects before learners see them:
 * every accepted wording passes, every distractor and `reject` entry fails.
 */
function lintAnswers(bank: Bank, questions: Question[], err: (msg: string) => void) {
  const options = { scoring: bank.scoring.multiple_choice, bankTerms: bankTerms(questions) };
  const texts = (value: unknown): string[] => (typeof value === "string" ? [value] : Object.values((value ?? {}) as Record<string, string | string[]>).flat());
  for (const q of questions) {
    const spec = q.type === "short_text" ? q : "free_input" in q ? q.free_input : undefined;
    if (!spec) continue;
    const slots = spec.answers.map((a) => texts(a.accept));
    const passes = (slot: number, text: string) =>
      grade(q, { mode: "typed", texts: slots.map((accept, i) => (i === slot ? text : accept[0]!)) }, options).correct;
    slots.forEach((accept, slot) => {
      for (const text of accept) if (!passes(slot, text)) err(`question ${q.id}: accepted answer "${text}" is not accepted (too close to a wrong term?)`);
      const wrong = [...texts(spec.reject), ...("options" in q ? q.options.filter((o) => !q.correct_answers.includes(o.id)).flatMap((o) => texts(o.text)) : [])];
      for (const text of wrong) if (passes(slot, text)) err(`question ${q.id}: wrong answer "${text}" is accepted`);
    });
  }
}

/** Validate a content repository; returns human-readable errors (empty = valid). */
export function validateContent(root: string): { errors: string[]; banks: number; questions: number } {
  const errors: string[] = [];
  const rel = (path: string) => relative(root, path).replaceAll("\\", "/");
  const catalog = parse(Catalog, join(root, "catalog.json"), errors);
  const { roots, problems } = discoverContent(root);
  errors.push(...problems);

  for (const n of listNodes(roots)) {
    const where = `${n.id}/node.json`;
    if (catalog && !(n.node.kind in catalog.kinds)) errors.push(`${where}: kind "${n.node.kind}" is not in catalog.json`);
    const folders = new Set([...n.children.map((c) => c.name), ...n.banks.map((b) => b.name)]);
    const seen = new Set<string>();
    for (const item of n.node.items ?? []) {
      if (seen.has(item)) errors.push(`${where}: items: "${item}" is listed twice`);
      else if (!folders.has(item)) errors.push(`${where}: items: "${item}" is not a child folder`);
      seen.add(item);
    }
  }

  const nodeIds = new Set(listNodes(roots).map((n) => n.id));
  const ids = new Map<string, string>();
  let banks = 0;
  let questions = 0;
  for (const { dir } of listBanks(roots)) {
    const where = rel(dir);
    const loaded = loadBank(dir, errors);
    if (!loaded) continue;
    const first = ids.get(loaded.bank.id);
    // Nodes and banks share one id space: both appear in a node's `order`.
    if (nodeIds.has(loaded.bank.id)) errors.push(`${where}/bank.json: bank id "${loaded.bank.id}" is also the id of a node`);
    if (first) errors.push(`${where}/bank.json: bank id "${loaded.bank.id}" is already used by ${first}`);
    else ids.set(loaded.bank.id, where);
    banks++;
    questions += loaded.questions.length;
    checkBank(loaded, where, errors);
  }

  return { errors, banks, questions };
}
