import type { Question } from "@exam/schema";
import { answerModes, grade, type AnswerMode, type Graded, type GradeOptions, type Response } from "./grade.ts";

export interface SessionConfig {
  /** practice: feedback after each answer; exam: feedback only after finishing. */
  kind: "practice" | "exam";
  answerMode: AnswerMode;
  /** What to do with questions that cannot be asked in `answerMode`. */
  unsupported: "self_check" | "skip";
  topics?: number[];
  levels?: number[];
  blocks?: number[];
  /** Restrict to these questions (mistakes, bookmarks). */
  ids?: number[];
  count?: number;
  shuffle: boolean;
  /** Ask `ids` in the order given instead of shuffling them (a planned training sitting). */
  keepOrder?: boolean;
  /** Practice only: a missed question comes back a few questions later until it is answered right twice. */
  relearn?: boolean;
  seed: number;
  timeLimitSec?: number;
  passPercent?: number;
}

export interface SessionItem {
  question: number;
  mode: AnswerMode;
  /** 1, 2, ... for the repeats of a missed question; absent on the first time it is asked. */
  again?: number;
  response?: Response;
  graded?: Graded;
  ms?: number;
}

export interface Session {
  id: string;
  bank: string;
  config: SessionConfig;
  items: SessionItem[];
  index: number;
  startedAt: number;
  shownAt: number;
  finishedAt?: number;
}

/** Seeded random numbers in [0, 1): the same seed always gives the same sequence. */
export function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded shuffle: the same seed always gives the same order. */
export function shuffled<T>(list: T[], seed: number): T[] {
  const next = random(seed);
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The mode a question is actually asked in, or undefined when it has to be skipped. */
export function modeFor(q: Question, config: Pick<SessionConfig, "answerMode" | "unsupported">): AnswerMode | undefined {
  const modes = answerModes(q);
  if (modes.includes(config.answerMode)) return config.answerMode;
  // A question with no options cannot be made easier; it keeps its only native mode.
  if (config.answerMode === "choice") return modes[0];
  if (config.unsupported === "skip") return undefined;
  return modes.includes("self_check") ? "self_check" : modes[0];
}

export function createSession(bank: string, questions: Question[], config: SessionConfig, now: number, id: string): Session {
  const within = (list: number[] | undefined, value: number | undefined) => !list?.length || (value != null && list.includes(value));
  let pool = questions.filter(
    (q) => !q.retired && within(config.ids, q.id) && within(config.topics, q.topic_id) && within(config.levels, q.difficulty_level) && within(config.blocks, q.exam_block),
  );
  if (config.keepOrder && config.ids?.length) {
    const rank = new Map(config.ids.map((id, i) => [id, i]));
    pool.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  } else if (config.shuffle) pool = shuffled(pool, config.seed);
  const items: SessionItem[] = [];
  for (const q of pool) {
    const mode = modeFor(q, config);
    if (mode) items.push({ question: q.id, mode });
    if (config.count && items.length === config.count) break;
  }
  return { id, bank, config, items, index: 0, startedAt: now, shownAt: now };
}

export const timeLeftSec = (s: Session, now: number) =>
  s.config.timeLimitSec == null ? undefined : Math.max(0, s.config.timeLimitSec - Math.floor((now - s.startedAt) / 1000));

export function submit(s: Session, question: Question, response: Response, now: number, options: GradeOptions): Session {
  const item = s.items[s.index];
  if (!item || s.finishedAt != null) throw new Error("session is finished");
  if (item.question !== question.id || item.mode !== response.mode) throw new Error("response does not match the current question");
  const answered = { ...item, response, graded: grade(question, response, options), ms: now - s.shownAt };
  const next = { ...s, items: s.items.with(s.index, answered) };
  return s.config.kind === "practice" && s.config.relearn ? requeue(next, s.index) : next;
}

/** Right answers in a row a missed question needs in this sitting before it is left alone. */
const RELEARN_RIGHT = 2;
/** Most times one question is put back in a sitting. */
const MAX_AGAIN = 4;

/**
 * A missed question is asked again after a few others, then once more a little later. The gap is at least
 * one question, so the same question never comes twice in a row; a miss on the very last question has nothing
 * to put between and is left for the next sitting, which the log makes it first in line for.
 */
function requeue(s: Session, at: number): Session {
  const item = s.items[at]!;
  const tries = s.items.slice(0, at + 1).filter((i) => i.question === item.question && i.graded);
  if (!tries.some((i) => !i.graded!.correct)) return s;
  let streak = 0;
  for (let k = tries.length - 1; k >= 0 && tries[k]!.graded!.correct; k--) streak++;
  if (streak >= RELEARN_RIGHT) return s;
  if (s.items.filter((i) => i.question === item.question).length > MAX_AGAIN) return s;
  if (s.items.slice(at + 1).some((i) => i.question === item.question)) return s;
  const gap = Math.min(streak === 0 ? 3 : 6, s.items.length - at - 1);
  if (gap < 1) return s;
  const again: SessionItem = { question: item.question, mode: item.mode, again: (item.again ?? 0) + 1 };
  return { ...s, items: s.items.toSpliced(at + 1 + gap, 0, again) };
}

export function goTo(s: Session, index: number, now: number): Session {
  if (index < 0 || index >= s.items.length) return s;
  return { ...s, index, shownAt: now };
}

export const finish = (s: Session, now: number): Session => (s.finishedAt != null ? s : { ...s, finishedAt: now });

export interface Summary {
  total: number;
  answered: number;
  correct: number;
  /** Share of points, 0..100: over every question in an exam, over the answered ones in practice. */
  percent: number;
  passed?: boolean;
}

/** Scores the first time each question was asked; a repeat after a miss is practice and does not change the score. */
export function summarize(s: Session): Summary {
  const first = s.items.filter((i) => !i.again);
  const answered = first.filter((i) => i.graded);
  const points = answered.reduce((sum, i) => sum + i.graded!.score, 0);
  // An unanswered exam question is a lost point; leaving practice early is not.
  const base = s.config.kind === "exam" ? first.length : answered.length;
  const percent = base ? Math.round((points / base) * 100) : 0;
  return {
    total: first.length,
    answered: answered.length,
    correct: answered.filter((i) => i.graded!.correct).length,
    percent,
    passed: s.config.passPercent == null ? undefined : percent >= s.config.passPercent,
  };
}
