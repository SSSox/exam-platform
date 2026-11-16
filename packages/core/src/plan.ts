import type { Question } from "@exam/schema";
import { BOX_WAIT, DAY, LEARNED_BOX, type Memory } from "./memory.ts";
import type { QuestionState } from "./progress.ts";
import { random } from "./session.ts";

/** A few misses count fully; past this many the weight stops growing so one stubborn question cannot take over. */
const LAPSE_CAP = 6;
/** The largest part of a sitting that missed questions may take for sure; the rest is drawn by weight. */
const MISSED_SHARE = 0.6;

/**
 * How badly a question needs asking now. Missed questions come first, then those whose time has come,
 * then new ones; learned questions that are not due still turn up now and then. Every question that was
 * missed often keeps a higher weight for good, even after it is learned.
 */
export function weight(m: Memory | undefined, now: number): number {
  if (!m || m.reps === 0) return 1.2;
  const lapses = Math.min(m.lapses, LAPSE_CAP);
  if (m.box === 0) return 5 + 1.5 * lapses;
  const boost = 1 + 0.5 * lapses;
  if (now >= m.due) return (3 + Math.min((now - m.due) / Math.max(BOX_WAIT[m.box]!, DAY), 3)) * boost;
  return (m.box >= LEARNED_BOX ? 0.12 : 0.6) * boost;
}

/**
 * The questions for one training sitting, in the order to ask them. A weighted draw without replacement
 * (Efraimidis and Spirakis): heavy questions tend to be drawn early, light ones still have a chance, no question repeats.
 * The same seed and the same log give the same list.
 */
export function pickAdaptive(questions: Question[], states: Map<number, QuestionState>, now: number, count: number | undefined, seed: number): number[] {
  const next = random(seed);
  const keyed = questions
    .filter((q) => !q.retired)
    .map((q) => {
      const memory = states.get(q.id)?.memory;
      return { id: q.id, missed: memory != null && memory.reps > 0 && memory.box === 0, key: next() ** (1 / weight(memory, now)) };
    });
  keyed.sort((a, b) => b.key - a.key || a.id - b.id);
  const total = count || keyed.length;
  // A draw alone can leave a mistake out of the sitting, so missed questions get a reserved share before the draw fills the rest.
  const reserved = new Set(keyed.filter((k) => k.missed).slice(0, Math.ceil(total * MISSED_SHARE)).map((k) => k.id));
  const picked = new Set(reserved);
  for (const k of keyed) if (picked.size < total) picked.add(k.id);
  return keyed.filter((k) => picked.has(k.id)).map((k) => k.id);
}
