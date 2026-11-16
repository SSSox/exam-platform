import { FORMAT, type Bank, type Question, type QuestionFile } from "@exam/schema";

type Json = Record<string, any>;

export interface MigratedBank {
  bank: Bank;
  /** File name (inside `questions/`) -> content. */
  files: Map<string, QuestionFile>;
}

const COMPUTED = ["question_count", "single_choice_count", "multiple_choice_count", "difficulty_counts"];

const topicFile = (topicId: number) => `t${String(topicId).padStart(2, "0")}.json`;

function difficultyScale(text: string | undefined, used: Set<number>) {
  if (!text || used.size === 0) return undefined;
  const scale = [...text.matchAll(/(\d)\s*—\s*([^;.]+)/g)]
    .map((m) => ({ level: Number(m[1]), title: m[2]!.trim().replace(/^./, (c) => c.toUpperCase()) }))
    .filter((s) => used.has(s.level));
  return scale.length === used.size ? scale : undefined;
}

/** Convert a schema 1.0 bank file into exambank/2. Nothing is dropped: see `restoreV1`. */
export function migrateV1(v1: Json, bankId: string): MigratedBank {
  if (v1.schema_version !== "1.0") throw new Error(`expected schema_version 1.0, got ${v1.schema_version}`);
  const known = new Set([
    "schema_version", "subject", "language", "created_on", "instructions", "exam_requirements", "topics",
    "sources", "source_catalog", "source_indexing", "content_notes", "questions", ...COMPUTED,
  ]);
  const unknown = Object.keys(v1).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`unmapped top-level keys: ${unknown.join(", ")}`);

  const files = new Map<string, QuestionFile>();
  const levels = new Set<number>();
  const instructionByType: Record<string, string> = {};
  for (const q of v1.questions as Json[]) {
    const { instruction, ...rest } = q;
    // The per-question text is the same for every question of a type, so it is stored once.
    instructionByType[q.type] ??= instruction;
    if (instruction !== instructionByType[q.type]) {
      throw new Error(`question ${q.id}: instruction differs from other ${q.type} questions`);
    }
    if (rest.difficulty_level != null) levels.add(rest.difficulty_level);
    const name = topicFile(q.topic_id);
    if (!files.has(name)) files.set(name, { format: FORMAT, bank: bankId, questions: [] });
    files.get(name)!.questions.push(rest as Question);
  }

  const bank: Json = { format: FORMAT, id: bankId, subject: v1.subject, language: v1.language };
  if (v1.created_on) bank.created_on = v1.created_on;
  const scale = difficultyScale(v1.instructions.difficulty, levels);
  if (scale) bank.difficulty_scale = scale;
  bank.scoring = { multiple_choice: "exact" };
  if (v1.exam_requirements) bank.exam = v1.exam_requirements;
  bank.topics = (v1.topics as Json[]).map(({ question_count, ...t }) => t);
  for (const key of ["sources", "source_catalog", "source_indexing"]) if (key in v1) bank[key] = v1[key];
  if ("content_notes" in v1) bank.notes = v1.content_notes;
  bank.legacy = {
    schema_version: v1.schema_version,
    instructions: v1.instructions,
    question_instruction: instructionByType,
    computed_keys: COMPUTED.filter((k) => k in v1),
    topic_question_count: (v1.topics as Json[]).every((t) => "question_count" in t),
  };
  return { bank: bank as Bank, files };
}

/** Localized text -> the string in the bank language (1.0 has no translations). */
const unwrap = (value: unknown, language: string) => (typeof value === "string" ? value : (value as Json)[language]);

/** Rebuild the 1.0 object from a migrated bank; used to prove the migration is lossless. */
export function restoreV1(bank: Bank, files: Iterable<QuestionFile>): Json {
  const legacy = bank.legacy as Json;
  const questions: Json[] = [...files]
    .flatMap((f) => f.questions as Json[])
    .sort((a, b) => a.id - b.id)
    .map(({ free_input, explanation, ...q }) => ({
      ...q,
      question: unwrap(q.question, bank.language),
      ...(q.options && { options: q.options.map((o: Json) => ({ ...o, text: unwrap(o.text, bank.language) })) }),
      instruction: legacy.question_instruction[q.type],
    }));
  const count = (pred: (q: Json) => boolean) => questions.filter(pred).length;

  const v1: Json = { schema_version: legacy.schema_version, subject: unwrap(bank.subject, bank.language), language: bank.language };
  if (bank.created_on) v1.created_on = bank.created_on;
  const computed: Json = {
    question_count: questions.length,
    single_choice_count: count((q) => q.type === "single_choice"),
    multiple_choice_count: count((q) => q.type === "multiple_choice"),
    difficulty_counts: Object.fromEntries(
      [...new Set(questions.map((q) => q.difficulty_level))].sort().map((l) => [String(l), count((q) => q.difficulty_level === l)]),
    ),
  };
  for (const key of legacy.computed_keys as string[]) v1[key] = computed[key];
  v1.instructions = legacy.instructions;
  if (bank.exam) v1.exam_requirements = bank.exam;
  v1.topics = (bank.topics as Json[]).map((t) =>
    {
    const topic = { ...t, name: unwrap(t.name, bank.language) };
    return legacy.topic_question_count ? { ...topic, question_count: count((q) => q.topic_id === t.id) } : topic;
  });
  for (const key of ["sources", "source_catalog", "source_indexing"] as const) if (key in bank) v1[key] = bank[key];
  if ("notes" in bank) v1.content_notes = bank.notes;
  v1.questions = questions;
  return v1;
}
