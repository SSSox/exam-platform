import type { AnswerMode } from "./grade.ts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/**
 * Leitner boxes. A question sits in a box and comes due again after that box's wait.
 * Box 0 is "still being learned": the question is asked again within the same sitting.
 */
export const BOX_WAIT = [0, 8 * HOUR, 2 * DAY, 5 * DAY, 12 * DAY, 30 * DAY] as const;
/** From this box on a question counts as learned: it was answered right at three spaced sittings. */
export const LEARNED_BOX = 3;
/** Share of a wait that may still be left and an answer already counts as "due". */
const GRACE = 0.1;
/** Highest box an answer in this mode can reach: picking a right option is weaker proof than recalling it. */
const CEILING: Record<AnswerMode, number> = { choice: 4, self_check: 5, typed: 5 };
/** How much of a question counts as known in each box. Boxes 4 and 5 differ only in how rarely they come back. */
const KNOWN = [0, 0.2, 0.45, 0.75, 1, 1] as const;

/** What the log says about one question, replayed attempt by attempt. */
export interface Memory {
  box: number;
  /** Right answers in a row while in box 0. */
  step: number;
  /** When the question should be asked again, ms. */
  due: number;
  /** Wrong answers, ever. Never reset: a question that was often missed keeps coming up. */
  lapses: number;
  reps: number;
  /** A right answer without options (typed or self-check) since the last wrong one. */
  recall: boolean;
  lastAt: number;
  lastCorrect: boolean;
}

/** `new` was never answered, `weak` was missed and not yet re-learned, `learning` is on its way, `choice` and `typed` are learned. */
export type Status = "new" | "weak" | "learning" | "choice" | "typed";

/** One more attempt. Pure: the same log always gives the same memory. */
export function learn(prev: Memory | undefined, at: number, mode: AnswerMode, correct: boolean): Memory {
  const m: Memory = prev ?? { box: 0, step: 0, due: at, lapses: 0, reps: 0, recall: false, lastAt: at, lastCorrect: correct };
  const next = { ...m, reps: m.reps + 1, lastAt: at, lastCorrect: correct };
  if (!correct) return { ...next, box: 0, step: 0, due: at, lapses: m.lapses + 1, recall: false };

  const recall = m.recall || mode !== "choice";
  if (m.box === 0) {
    // A question that was missed has to be answered right twice before it leaves box 0; a new one once.
    const step = m.step + 1;
    if (step < (m.lapses > 0 ? 2 : 1)) return { ...next, step, due: at, recall };
    return { ...next, box: 1, step: 0, due: at + BOX_WAIT[1], recall };
  }
  // Answering early, before the question is due, is practice but not proof: the box stays.
  if (at < m.due - GRACE * BOX_WAIT[m.box]!) return { ...next, recall };
  const box = Math.min(m.box + 1, Math.max(m.box, CEILING[mode]));
  return { ...next, box, due: at + BOX_WAIT[box]!, recall };
}

export function statusOf(m: Memory | undefined): Status {
  if (!m || m.reps === 0) return "new";
  if (m.box === 0) return "weak";
  if (m.box >= LEARNED_BOX) return m.recall ? "typed" : "choice";
  return "learning";
}

export const isDue = (m: Memory | undefined, now: number): boolean => m != null && m.reps > 0 && now >= m.due;

/** How well a question is known right now, 0..1. A question left past its due date fades. */
export function strength(m: Memory | undefined, now: number): number {
  if (!m || m.reps === 0) return 0;
  const base = KNOWN[m.box]!;
  const late = now - m.due;
  if (late <= 0 || m.box === 0) return base;
  return base * 0.5 ** (late / Math.max(BOX_WAIT[m.box]!, DAY));
}
