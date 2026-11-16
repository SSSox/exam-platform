/**
 * Deterministic, offline check of a typed answer against author-supplied accepted answers.
 * Order of leniency: exact -> word form -> kk letters typed on a Russian layout -> typo.
 * Synonyms are never guessed: only what the author listed in `accept` counts.
 */

export type MatchKind = "exact" | "form" | "layout" | "typo";
const RANK: Record<MatchKind, number> = { exact: 0, form: 1, layout: 2, typo: 3 };

export interface MatchSpec {
  accept: string[];
  /** Close but wrong answers: distractors, `reject`, other terms of the bank. */
  confusables?: string[];
  /** Wrong options and `reject` of THIS question: an answer that also contains one of them is rejected. */
  wrong?: string[];
  /** Question text; its words may be repeated in the answer without penalty. */
  context?: string;
  typos?: "auto" | "off";
  ordered?: boolean;
}

export interface MatchResult {
  ok: boolean;
  kind?: MatchKind;
  /** The accepted answer that matched, as the author wrote it. */
  matched?: string;
}

const LATIN_LOOKALIKES: Record<string, string> = { a: "а", o: "о", e: "е", c: "с", p: "р", x: "х", y: "у", i: "і" };
const KK_FOLD: Record<string, string> = { ә: "а", ғ: "г", қ: "к", ң: "н", ө: "о", ұ: "у", ү: "у", һ: "х", і: "и" };
const CYRILLIC = /[Ѐ-ӿ]/;

const STOPWORDS = new Set([
  "и", "в", "во", "на", "с", "со", "по", "к", "ко", "о", "об", "от", "до", "для", "из", "у", "за", "или", "а", "как", "это",
  "the", "a", "an", "of", "and", "or", "in", "on", "to", "for", "is",
  "және", "мен", "бен", "пен", "немесе", "үшін", "бұл",
]);

/** Inflectional endings only; derivational suffixes are kept so different terms stay different. */
const ENDINGS = {
  cyrillic: [
    "иями", "ями", "ами", "ыми", "ими", "ого", "его", "ому", "ему", "ией", "иях", "иям",
    "ой", "ей", "ом", "ем", "ов", "ев", "ам", "ям", "ах", "ях", "ый", "ий", "ая", "яя", "ое", "ее", "ые", "ие",
    "ым", "им", "ую", "юю", "ых", "их", "ию", "ия", "ии", "ью",
    "а", "я", "ы", "и", "у", "ю", "е", "о", "ь", "й",
    // kk case and plural suffixes
    "ның", "нің", "дың", "дің", "тың", "тің", "дан", "ден", "тан", "тен", "нан", "нен",
    "лар", "лер", "дар", "дер", "тар", "тер", "ға", "ге", "қа", "ке", "ны", "ні", "ды", "ді", "ты", "ті", "да", "де", "та", "те",
  ],
  latin: ["'s", "es", "s"],
};
for (const list of Object.values(ENDINGS)) list.sort((a, b) => b.length - a.length);

/** Prefixes that flip or shift the meaning: an edit touching one is never a typo. */
const PREFIX_GROUPS = [
  ["гипер", "гипо"], ["интро", "экстра"], ["экстеро", "интеро", "проприо"], ["extero", "intero", "proprio"], ["интер", "интра"], ["микро", "макро"], ["экзо", "эндо"], ["моно", "поли"],
  ["пре", "пост"], ["до", "после"], ["hyper", "hypo"], ["intro", "extra"], ["inter", "intra"], ["micro", "macro"], ["pre", "post"],
];
const NEGATING = ["не", "анти", "без", "бес", "де", "дис", "контр", "а", "non", "anti", "un", "in", "im", "dis", "de", "бей"];
const NEGATING_SUFFIXES = ["сыз", "сіз"];

export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .map((w) => (CYRILLIC.test(w) ? w.replace(/[aoecpxyi]/g, (c) => LATIN_LOOKALIKES[c]!) : w))
    .join(" ");
}

const tokens = (text: string) => normalize(text).split(" ").filter(Boolean);

const CONJ_AND = new Set(["и", "and", "және"]);
const CONJ_OR = new Set(["или", "or", "немесе"]);
const isConj = (w: string | undefined) => w !== undefined && (CONJ_AND.has(w) || CONJ_OR.has(w));

/** Pure-function memo: the same few hundred strings are compared over and over (bank terms, lint runs). */
function memo<K, V>(fn: (key: K) => V, limit = 100_000): (key: K) => V {
  const cache = new Map<K, V>();
  return (key) => {
    let value = cache.get(key);
    if (value === undefined) {
      if (cache.size >= limit) cache.clear();
      value = fn(key);
      cache.set(key, value);
    }
    return value;
  };
}

interface Phrase {
  /** Every token, stop words included (one-letter Latin look-alikes folded to Cyrillic). */
  all: readonly string[];
  /** Whether each token of `all` is a stop word in this phrase. */
  stop: readonly boolean[];
  /** Content words: stop words dropped except one-letter designations. */
  words: readonly string[];
  /** One-letter designations of the author's phrase ("гепатит А"): they must be typed. */
  marks: ReadonlySet<string>;
  /** Whether each token stands where a designation does: a lone letter at the end, or a capital one inside. */
  placed: readonly boolean[];
  /** For each designation letter, the tokens it follows in this phrase ("" at the start). */
  before: ReadonlyMap<string, ReadonlySet<string>>;
  /** Class of the conjunctions present. */
  and: boolean;
  or: boolean;
}

const rawTokens =(text: string) => text.normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);

function parsePhrase(text: string): Phrase {
  const norm = tokens(text);
  const raw = rawTokens(text);
  // Case is read from the author's raw text; if the splits ever disagree, no token counts as a designation.
  const cased = raw.length === norm.length;
  const all = norm.map((w) => (w.length === 1 && LATIN_LOOKALIKES[w] ? LATIN_LOOKALIKES[w] : w));
  // A stop word is judged as typed: nobody writes a Russian preposition with a Latin letter, so a lone Latin "C", "O" or "Y" is a word
  // of its own ("vitamin C", "Y-хромосома"), and in the author's phrase a designation that the Cyrillic look-alike also answers.
  const stop = norm.map((w) => STOPWORDS.has(w));
  const marks = new Set<string>();
  const before = new Map<string, Set<string>>();
  const kept: string[] = [];
  const placed = all.map((w, i) => {
    const upper = cased && raw[i]!.length === 1 && raw[i] !== raw[i]!.toLowerCase();
    return w.length === 1 && (i === all.length - 1 || (upper && i > 0) || (upper && i === 0 && isConj(all[1])));
  });
  all.forEach((w, i) => {
    const mark = (stop[i] && placed[i]) || (!stop[i] && w !== norm[i] && STOPWORDS.has(w));
    if (mark) {
      marks.add(w);
      before.set(w, (before.get(w) ?? new Set()).add(all[i - 1] ?? ""));
    }
    if (!stop[i] || mark) kept.push(w);
  });
  return {
    all, stop, placed, before, words: kept.length ? kept : all, marks,
    and: all.some((w) => CONJ_AND.has(w)), or: all.some((w) => CONJ_OR.has(w)),
  };
}

/** Phrase analysis keyed by the raw text, so "гепатит А" and "гепатит а" stay distinct. Shared between calls: do not mutate. */
const phrase = memo(parsePhrase);

/** Words of a typed answer compared against one expected phrase: stop words go unless that phrase has them as designations. */
function inputWords(input: Phrase, against: Phrase): readonly string[] {
  // A designation letter may also stand in the phrase as a plain preposition ("препарат с витамином С"). A stop word of the answer is
  // kept as the designation only where one stands (at the end, a capital inside, after the word the author put it after), and no more
  // of them than the phrase has.
  const room = new Map<string, number>();
  for (const w of against.words) if (against.marks.has(w)) room.set(w, (room.get(w) ?? 0) + 1);
  const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && a.slice(0, 4) === b.slice(0, 4));
  const kept: string[] = [];
  for (let i = input.all.length - 1; i >= 0; i--) {
    const w = input.all[i]!;
    const left = room.get(w) ?? 0;
    if (input.stop[i]) {
      const prev = input.all[i - 1] ?? "";
      if (!left || !(input.placed[i] || [...(against.before.get(w) ?? [])].some((p) => near(p, prev)))) continue;
    }
    if (left) room.set(w, left - 1);
    kept.unshift(w);
  }
  return kept.length ? kept : input.all;
}

function stemUncached(word: string): string {
  const list = CYRILLIC.test(word) ? ENDINGS.cyrillic : ENDINGS.latin;
  for (const ending of list) {
    if (word.endsWith(ending) && word.length - ending.length >= 4) return word.slice(0, -ending.length);
  }
  return word;
}

export const stem: (word: string) => string = memo(stemUncached);

/** One ending is stripped at most, so a bare form must also be compared with the other word's stem. */
const sameLemma = (a: string, b: string) => stem(a) === stem(b) || stem(a) === b || a === stem(b);

const foldKk = memo((word: string) => word.replace(/[әғқңөұүһі]/g, (c) => KK_FOLD[c]!));

/**
 * Optimal string alignment distance (Levenshtein + adjacent transposition).
 * With `limit`, any distance above it may be reported as `limit + 1`: callers that only
 * compare against a threshold get the same answer without filling the table.
 */
export function editDistance(a: string, b: string, limit = Infinity): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const cols = b.length + 1;
  let prev2 = new Array<number>(cols), prev = Array.from({ length: cols }, (_, j) => j), row = new Array<number>(cols);
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    let min = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      row[j] = v;
      if (v < min) min = v;
    }
    if (min > limit) return limit + 1;
    [prev2, prev, row] = [prev, row, prev2];
  }
  return prev[b.length]!;
}

const typoBudget = (expected: string) => (/\d/.test(expected) || expected.length <= 4 ? 0 : expected.length <= 8 ? 1 : 2);

function prefixConflict(a: string, b: string): boolean {
  for (const group of PREFIX_GROUPS) {
    const pa = group.find((p) => a.startsWith(p)), pb = group.find((p) => b.startsWith(p));
    if (pa && pb && pa !== pb && editDistance(a.slice(pa.length), b.slice(pb.length), 2) <= 2) return true;
  }
  for (const [long, short] of [[a, b], [b, a]] as const) {
    if (long.length <= short.length) continue;
    for (const p of NEGATING) if (long.startsWith(p) && editDistance(long.slice(p.length), short, 1) <= 1) return true;
    for (const s of NEGATING_SUFFIXES) if (long.endsWith(s) && editDistance(long.slice(0, -s.length), stem(short), 1) <= 1) return true;
  }
  return false;
}

/** How a typed word relates to an expected word; `edits` is 0 unless it is a typo. */
function matchWord(input: string, expected: string, allowTypos: boolean): { kind: MatchKind; edits: number } | undefined {
  if (input === expected) return { kind: "exact", edits: 0 };
  if (prefixConflict(input, expected)) return undefined;
  if (/\d/.test(expected) || expected.length <= 3) return undefined;
  if (sameLemma(input, expected)) return { kind: "form", edits: 0 };
  const fi = foldKk(input), fe = foldKk(expected);
  if (fi === fe || sameLemma(fi, fe)) return { kind: "layout", edits: 0 };
  if (!allowTypos) return undefined;
  const budget = typoBudget(expected);
  const edits = Math.min(editDistance(fi, fe, budget), editDistance(stem(fi), stem(fe), budget));
  return budget > 0 && edits <= budget ? { kind: "typo", edits } : undefined;
}

interface PhraseMatch { kind: MatchKind; edits: number }

function matchPhrase(input: readonly string[], expected: readonly string[], context: Set<string>, allowTypos: boolean, ordered: boolean): PhraseMatch | undefined {
  const free = input.map((word, index) => ({ word, index }));
  let kind: MatchKind = "exact", edits = 0, last = -1;
  for (const want of expected) {
    let best: { at: number; kind: MatchKind; edits: number } | undefined;
    free.forEach((candidate, at) => {
      if (ordered && candidate.index < last) return;
      const m = matchWord(candidate.word, want, allowTypos);
      if (m && (!best || RANK[m.kind] < RANK[best.kind] || (m.kind === best.kind && m.edits < best.edits))) best = { at, ...m };
    });
    if (!best) return undefined;
    last = free[best.at]!.index;
    free.splice(best.at, 1);
    if (RANK[best.kind] > RANK[kind]) kind = best.kind;
    edits += best.edits;
  }
  if (edits > 2) return undefined;
  // Leftover words are fine only if they repeat the question.
  if (free.some(({ word }) => !context.has(word) && !context.has(stem(word)))) return undefined;
  return { kind, edits };
}

/** Does `haystack` contain every token of `needle` as the very same word, each haystack token used once? Forms of a wrong word are the confusables' job. */
function containsAll(haystack: readonly string[], needle: readonly string[]): boolean {
  const free = [...haystack];
  return needle.every((n) => {
    const at = free.indexOf(n);
    if (at < 0) return false;
    free.splice(at, 1);
    return true;
  });
}

export function matchAnswer(rawInput: string, spec: MatchSpec): MatchResult {
  const input = phrase(rawInput);
  if (input.all.length === 0) return { ok: false };
  const contextWords = tokens(spec.context ?? "");
  const context = new Set([...contextWords, ...contextWords.map(stem)]);
  const confusables = (spec.confusables ?? []).map((c) => phrase(c)).filter((c) => c.words.length);
  const wrong = (spec.wrong ?? []).map((w) => phrase(w).all).filter((w) => w.length);
  const ordered = spec.ordered ?? false;
  const none = new Set<string>();

  let best: (PhraseMatch & { matched: string; expected: Phrase }) | undefined;
  for (const accepted of spec.accept) {
    const expected = phrase(accepted);
    if (expected.words.length === 0) continue;
    // "и" and "или" are different claims; leaving a conjunction out is still fine.
    if ((input.or && expected.and && !expected.or) || (input.and && expected.or && !expected.and)) continue;
    // A neighbour within typo range of this answer makes typos unsafe for it.
    const crowded = confusables.some((c) => matchPhrase(c.words, expected.words, none, true, ordered));
    const m = matchPhrase(inputWords(input, expected), expected.words, context, spec.typos !== "off" && !crowded, ordered);
    if (m && (!best || RANK[m.kind] < RANK[best.kind])) best = { ...m, matched: accepted, expected };
  }
  if (!best) return { ok: false };
  // Naming the right answer together with a wrong option is not an answer, whatever the match kind.
  for (const w of wrong) {
    if (containsAll(input.all, w) && !containsAll(best.expected.all, w)) return { ok: false };
  }
  if (best.kind !== "exact") {
    // A lenient match must not be at least as close to a wrong answer.
    for (const c of confusables) {
      const close = matchPhrase(inputWords(input, c), c.words, context, true, ordered);
      if (close && (RANK[close.kind] <= RANK.form || RANK[close.kind] < RANK[best.kind] || (close.kind === best.kind && close.edits <= best.edits))) {
        return { ok: false };
      }
    }
  }
  return { ok: true, kind: best.kind, matched: best.matched };
}
