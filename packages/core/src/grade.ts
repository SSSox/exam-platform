import type { Localized, Question } from "@exam/schema";
import { matchAnswer, type MatchKind } from "./match.ts";

/** How the learner answers. Independent of the subject difficulty stored in the bank. */
export type AnswerMode = "choice" | "typed" | "self_check";

export type Response =
  | { mode: "choice"; selected: string[] }
  | { mode: "typed"; texts: string[] }
  | { mode: "self_check"; knew: boolean };

export interface Graded {
  correct: boolean;
  /** 0..1; differs from `correct` only under partial scoring. */
  score: number;
  /** Weakest evidence among the parts: exact < form < layout < typo. */
  matchKind: MatchKind | "choice" | "numeric" | "self";
  parts?: { text: string; ok: boolean; matched?: string }[];
}

export interface GradeOptions {
  scoring: "exact" | "partial";
  /** Other terms of the bank that must not be mistaken for the answer. */
  bankTerms?: string[];
}

const KIND_RANK = ["exact", "form", "layout", "typo"] as const;
const all = (value: Localized | undefined): string[] => (value == null ? [] : typeof value === "string" ? [value] : Object.values(value));
const flat = (lists: Record<string, string[]> | undefined): string[] => Object.values(lists ?? {}).flat();

export function answerModes(q: Question): AnswerMode[] {
  switch (q.type) {
    case "single_choice":
    case "multiple_choice":
      return q.free_input ? ["choice", "typed", "self_check"] : ["choice", "self_check"];
    case "short_text":
      return ["typed", "self_check"];
    case "numeric":
      return ["typed"];
    case "open":
      return ["self_check"];
  }
}

/** Every accepted typed answer of a bank; passed to `grade` so one term is not taken for another. */
export function bankTerms(questions: Question[]): string[] {
  const terms = questions.flatMap((q) =>
    q.type === "short_text" ? q.answers : "free_input" in q && q.free_input ? q.free_input.answers : [],
  ).flatMap((a) => flat(a.accept));
  return [...new Set(terms)];
}

/** Number of text fields the typed mode shows. */
export function typedSlots(q: Question): number {
  if (q.type === "short_text") return q.answers.length;
  if (q.type === "numeric") return 1;
  return "free_input" in q && q.free_input ? q.free_input.answers.length : 0;
}

const foreignCache = new WeakMap<string[], WeakMap<object, string[]>>();

/** Bank terms that the question's own answers do not already accept. Memoised: it does not depend on the typed text. */
function foreignTerms(answers: { accept?: Record<string, string[]> | undefined }[], bankTerms: string[] | undefined): string[] {
  if (!bankTerms?.length) return [];
  let perAnswers = foreignCache.get(bankTerms);
  if (!perAnswers) foreignCache.set(bankTerms, (perAnswers = new WeakMap()));
  let terms = perAnswers.get(answers);
  if (!terms) {
    const own = { accept: answers.flatMap((a) => flat(a.accept)), typos: "off" as const };
    perAnswers.set(answers, (terms = bankTerms.filter((term) => !matchAnswer(term, own).ok)));
  }
  return terms;
}

/** Decimal inputs like 7.15 vs 7.1 ± 0.05 differ from the bound by float noise; allow for it. */
const withinTolerance = (value: number, target: number, tolerance: number) =>
  Math.abs(value - target) <= tolerance + Number.EPSILON * 8 * Math.max(1, Math.abs(value), Math.abs(target));

function gradeTyped(q: Question, texts: string[], options: GradeOptions): Graded {
  if (q.type === "numeric") {
    const value = Number(texts[0]?.replace(/\s/g, "").replace(",", "."));
    const correct = texts[0]?.trim() !== "" && Number.isFinite(value) && withinTolerance(value, q.answer.value, q.answer.tolerance);
    return { correct, score: correct ? 1 : 0, matchKind: "numeric" };
  }
  const spec =
    q.type === "short_text" ? { answers: q.answers, reject: q.reject, typos: q.typos, question: q.question, wrongOptions: [] as string[] }
    : (q.type === "single_choice" || q.type === "multiple_choice") && q.free_input
      ? {
          ...q.free_input,
          question: q.free_input.question ?? q.question,
          wrongOptions: q.options.filter((o) => !q.correct_answers.includes(o.id)).flatMap((o) => all(o.text)),
        }
      : undefined;
  if (!spec) throw new Error(`question ${q.id} has no typed answers`);

  const context = [...all(q.question), ...all(spec.question)].join(" ");
  // Another question may accept the same term in another form; that is not a wrong answer here.
  const confusables = [...spec.wrongOptions, ...flat(spec.reject), ...foreignTerms(spec.answers, options.bankTerms)];

  const wrong = [...spec.wrongOptions, ...flat(spec.reject)];

  const open = [...spec.answers];
  let weakest = 0;
  const parts = texts.map((text) => {
    for (const [i, answer] of open.entries()) {
      const m = matchAnswer(text, { accept: flat(answer.accept), confusables, wrong, context, typos: spec.typos, ordered: answer.ordered });
      if (!m.ok) continue;
      open.splice(i, 1);
      weakest = Math.max(weakest, KIND_RANK.indexOf(m.kind!));
      return { text, ok: true, matched: m.matched };
    }
    return { text, ok: false };
  });
  const hits = parts.filter((p) => p.ok).length;
  const correct = open.length === 0 && hits === parts.length;
  const score = options.scoring === "partial" ? hits / spec.answers.length : correct ? 1 : 0;
  return { correct, score, matchKind: KIND_RANK[weakest]!, parts };
}

export function grade(q: Question, response: Response, options: GradeOptions): Graded {
  if (!answerModes(q).includes(response.mode)) throw new Error(`question ${q.id} does not support mode ${response.mode}`);
  if (response.mode === "self_check") return { correct: response.knew, score: response.knew ? 1 : 0, matchKind: "self" };
  if (response.mode === "typed") return gradeTyped(q, response.texts, options);

  const key = new Set((q as { correct_answers: string[] }).correct_answers);
  const picked = new Set(response.selected);
  const hits = [...picked].filter((id) => key.has(id)).length;
  const correct = hits === key.size && picked.size === key.size;
  const score = options.scoring === "partial" ? Math.max(0, hits - (picked.size - hits)) / key.size : correct ? 1 : 0;
  return { correct, score, matchKind: "choice" };
}
