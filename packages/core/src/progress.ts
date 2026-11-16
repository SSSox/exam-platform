import type { Question } from "@exam/schema";
import type { AnswerMode, Response } from "./grade.ts";
import type { Session, SessionItem } from "./session.ts";
import { LEARNED_BOX, isDue, learn, statusOf, strength, type Memory, type Status } from "./memory.ts";

/** Append-only log. Devices are merged by taking the union of events, so there are no conflicts. */
export type ProgressEvent =
  | {
      id: string; type: "attempt"; at: number; device: string; bank: string; question: number;
      /** Hash of the question content at the time of the attempt. */
      rev: string;
      mode: AnswerMode; correct: boolean; score: number; matchKind: string; response: Response; locale: string; session: string; ms: number;
    }
  | { id: string; type: "bookmark"; at: number; device: string; bank: string; question: number; value: boolean }
  /** The learner says a typed answer marked wrong was right; counted apart from both right and wrong. */
  | { id: string; type: "dispute"; at: number; device: string; bank: string; question: number; attempt: string };

export type AttemptEvent = Extract<ProgressEvent, { type: "attempt" }>;

/** UUIDv7: time-ordered, so ids sort by creation time across devices. */
export function uuidv7(now: number, random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(16));
  for (let i = 0, t = now; i < 6; i++, t = Math.floor(t / 256)) bytes[5 - i] = t % 256;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable short hash of a question (FNV-1a), used to tell which revision was answered. */
export function revision(q: Question): string {
  let h = 0x811c9dc5;
  for (const ch of JSON.stringify(q)) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function mergeLogs(...logs: ProgressEvent[][]): ProgressEvent[] {
  const byId = new Map(logs.flat().map((e) => [e.id, e]));
  return [...byId.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

/** The log record for one answered item of a session. */
export function attemptEvent(s: Session, item: SessionItem, q: Question, at: number, device: string, locale: string, id = uuidv7(at)): AttemptEvent {
  if (!item.graded || !item.response || item.question !== q.id) throw new Error("item is not answered");
  return {
    id, type: "attempt", at, device, bank: s.bank, question: q.id, rev: revision(q), mode: item.mode,
    correct: item.graded.correct, score: item.graded.score, matchKind: item.graded.matchKind, response: item.response, locale, session: s.id, ms: item.ms ?? 0,
  };
}

export interface ModeState { attempts: number; correct: number; disputed: number; streak: number; lastCorrect?: boolean }
export interface QuestionState { modes: Partial<Record<AnswerMode, ModeState>>; bookmarked: boolean; lastCorrect?: boolean; lastAt?: number; memory?: Memory }

/** Correct answers in a row needed to call a question mastered in a mode; choice can be guessed, so it needs two. */
const MASTERY_STREAK: Record<AnswerMode, number> = { choice: 2, typed: 1, self_check: 1 };
export const mastered = (state: QuestionState | undefined, mode: AnswerMode) => (state?.modes[mode]?.streak ?? 0) >= MASTERY_STREAK[mode];

/** Current state of every question of a bank, rebuilt from the log. */
export function project(events: ProgressEvent[], bank: string): Map<number, QuestionState> {
  // A dispute names an attempt of its own bank, so only this bank's events are sorted and replayed.
  const own = events.filter((e) => e.bank === bank);
  const disputed = new Set(own.flatMap((e) => (e.type === "dispute" ? [e.attempt] : [])));
  const states = new Map<number, QuestionState>();
  for (const e of mergeLogs(own)) {
    if (e.type === "dispute") continue;
    // A log from outside (an imported file) can hold an attempt in no known mode; it says nothing about the question, so it is left out.
    if (e.type === "attempt" && !Object.hasOwn(MASTERY_STREAK, e.mode)) continue;
    let state = states.get(e.question);
    if (!state) states.set(e.question, (state = { modes: {}, bookmarked: false }));
    if (e.type === "bookmark") {
      state.bookmarked = e.value;
      continue;
    }
    const mode = (state.modes[e.mode] ??= { attempts: 0, correct: 0, disputed: 0, streak: 0 });
    if (disputed.has(e.id)) {
      mode.disputed++;
      continue;
    }
    mode.attempts++;
    mode.correct += e.correct ? 1 : 0;
    mode.streak = e.correct ? mode.streak + 1 : 0;
    mode.lastCorrect = state.lastCorrect = e.correct;
    state.lastAt = e.at;
    state.memory = learn(state.memory, e.at, e.mode, e.correct);
  }
  return states;
}

export interface Tally { attempts: number; correct: number }
export interface BankStats {
  questions: number;
  seen: number;
  mastered: Record<AnswerMode, number>;
  byMode: Record<AnswerMode, Tally>;
  byTopic: Map<number, Tally>;
  /** Key: `${difficulty_level}:${mode}`. */
  byLevelAndMode: Map<string, Tally>;
  /** Questions missed and not yet answered right twice since; they stay here after one lucky answer. */
  mistakes: number[];
  bookmarks: number[];
  /** Seen questions whose repeat time has come. */
  due: number[];
  status: Map<number, Status>;
  /** Questions learned: answered right at spaced sittings. */
  learned: number;
  /** How well the bank is known right now, 0..1, with forgetting counted in. */
  mastery: number;
  byTopicMastery: Map<number, { mastery: number; learned: number; total: number }>;
}

export function bankStats(states: Map<number, QuestionState>, questions: Question[], now: number = Date.now()): BankStats {
  const tally = (): Tally => ({ attempts: 0, correct: 0 });
  const add = (t: Tally, m: ModeState) => {
    t.attempts += m.attempts;
    t.correct += m.correct;
  };
  const stats: BankStats = {
    questions: 0, seen: 0,
    mastered: { choice: 0, typed: 0, self_check: 0 },
    byMode: { choice: tally(), typed: tally(), self_check: tally() },
    byTopic: new Map(), byLevelAndMode: new Map(), mistakes: [], bookmarks: [],
    due: [], status: new Map(), learned: 0, mastery: 0, byTopicMastery: new Map(),
  };
  let known = 0;
  for (const q of questions) {
    if (q.retired) continue;
    stats.questions++;
    const state = states.get(q.id);
    const status = statusOf(state?.memory);
    stats.status.set(q.id, status);
    const topic = stats.byTopicMastery.get(q.topic_id) ?? { mastery: 0, learned: 0, total: 0 };
    topic.total++;
    stats.byTopicMastery.set(q.topic_id, topic);
    if (!state) continue;
    if (state.bookmarked) stats.bookmarks.push(q.id);
    if (state.lastAt == null) continue;
    stats.seen++;
    const level = strength(state.memory, now);
    known += level;
    topic.mastery += level;
    if (state.memory && state.memory.box >= LEARNED_BOX) {
      stats.learned++;
      topic.learned++;
    }
    if (status === "weak") stats.mistakes.push(q.id);
    if (isDue(state.memory, now)) stats.due.push(q.id);
    for (const [mode, m] of Object.entries(state.modes) as [AnswerMode, ModeState][]) {
      if (mastered(state, mode)) stats.mastered[mode]++;
      add(stats.byMode[mode], m);
      if (!stats.byTopic.has(q.topic_id)) stats.byTopic.set(q.topic_id, tally());
      add(stats.byTopic.get(q.topic_id)!, m);
      if (q.difficulty_level != null) {
        const key = `${q.difficulty_level}:${mode}`;
        if (!stats.byLevelAndMode.has(key)) stats.byLevelAndMode.set(key, tally());
        add(stats.byLevelAndMode.get(key)!, m);
      }
    }
  }
  stats.mastery = stats.questions ? known / stats.questions : 0;
  for (const topic of stats.byTopicMastery.values()) topic.mastery = topic.total ? topic.mastery / topic.total : 0;
  return stats;
}
