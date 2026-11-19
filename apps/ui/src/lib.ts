import { LEARNED_BOX, createSession, entriesOf, goTo, isDue, isFork, modeFor, pickAdaptive, shuffled, strength, submit, type AnswerMode, type BankBundle, type BankStats, type ContentIndex, type Entry, type NodeManifest, type NodeRef, type ProgressEvent, type QuestionState, type Response, type Session, type SessionConfig, type SessionItem, type Target } from "@exam/core";
import type { Localized, Question } from "@exam/schema";

/**
 * What the result counts as shown. An exam counts every question, answered or not. Practice moves only forward, so an item behind
 * the current one was answered or skipped; the ones ahead, repeats queued after a miss among them, were never shown. Leaving early
 * is not a miss, nor is the open question left unanswered when the student finishes.
 */
export const shown = (s: Pick<Session, "config" | "items" | "index">) =>
  s.items.filter((item, i) => s.config.kind === "exam" || item.graded != null || i < s.index);

/**
 * Ids of the questions the result's "Retry mistakes" asks again and its "Mistakes" line counts: the first showings that were not answered right.
 * An exam also counts a question left without an answer, as its score does; practice leaves out what was only skipped (see `shown`).
 */
export const mistakeIds = (s: Pick<Session, "config" | "items" | "index">): number[] =>
  shown(s).filter((i) => !i.again && (s.config.kind === "exam" ? !i.graded?.correct : i.graded != null && !i.graded.correct)).map((i) => i.question);

/** The app's own keys in local storage. On a shared origin (a github.io site) any other key belongs to someone else. */
export const KEYS = { settings: "settings", place: "place", device: "device", exam: "exam", updateCheck: "updateCheck", setup: "setup", backup: "backup", unwritten: "unwritten" } as const;

/**
 * Removes everything the app keeps on the device: the stored tables (the progress log, the downloaded banks) and its own keys in local storage.
 * The tables are emptied rather than the database deleted, because a delete waits for every other open tab of the app to close it.
 */
export async function wipe(tables: { clear(): Promise<unknown> }[], storage: Pick<Storage, "removeItem">): Promise<void> {
  await Promise.all(tables.map((table) => table.clear()));
  for (const key of Object.values(KEYS)) storage.removeItem(key);
}

/**
 * Whether a value read from an imported progress file is an event the log can hold.
 * Numbers must be finite: JSON turns `1e999` into Infinity, and an attempt at "the end of time" would sort last and count as the newest.
 */
export function isProgressEvent(e: unknown): e is ProgressEvent {
  if (typeof e !== "object" || e === null) return false;
  const x = e as Record<string, unknown>;
  if (typeof x.id !== "string" || !Number.isFinite(x.at) || typeof x.bank !== "string") return false;
  if (x.type === "dispute") return Number.isSafeInteger(x.question) && typeof x.attempt === "string";
  if (x.type === "bookmark") return Number.isSafeInteger(x.question) && typeof x.value === "boolean";
  return x.type === "attempt" && Number.isSafeInteger(x.question) && typeof x.correct === "boolean" && typeof x.mode === "string" && ["choice", "typed", "self_check"].includes(x.mode);
}

/** Stations drawn on a subject's line, however many questions the bank has. */
export const STATIONS = 9;
/** Line colours in the stylesheet; rows take them in turn. */
export const LINE_COLORS = 5;
export const lineOf = (position: number) => position % LINE_COLORS;

export interface Progress { done: number; total: number; lit: number }

/**
 * `done` questions are learned, `lit` stations follow how well the whole bank is known right now (forgetting counted in).
 * `retired` are the ids of withdrawn questions: what was learned of them is still in the log but no longer counts, as `total` leaves them out too.
 */
export function bankProgress(states: Map<number, QuestionState>, total: number, now: number, retired: readonly number[] = []): Progress {
  let done = 0;
  let known = 0;
  for (const [id, state] of states) {
    if (retired.includes(id)) continue;
    known += strength(state.memory, now);
    if (state.memory && state.memory.box >= LEARNED_BOX) done++;
  }
  done = Math.min(done, total);
  return { done, total, lit: total > 0 ? Math.round((STATIONS * Math.min(known, total)) / total) : 0 };
}

/** A bank inside a group is titled "<group>, <level>"; inside the group only the level is needed. */
export function shortTitle(bankTitle: string, groupTitle: string): string {
  const prefix = `${groupTitle}, `;
  return groupTitle && bankTitle.startsWith(prefix) && bankTitle.length > prefix.length ? bankTitle.slice(prefix.length) : bankTitle;
}

/** Names in one line; the dot stays with the name before it so a line never starts with one. */
const joinNames = (names: string[]) => names.join(" · ");

/** The folders on the way, as one quiet line. When the heading is the last folder's own title it is not repeated; under a prompt or a bank title it is. */
export const pathNames = (titles: string[], headingIsLastTitle: boolean): string => joinNames(headingIsLastTitle ? titles.slice(0, -1) : titles);

/** The first few names of what a folder holds, as one quiet line. */
export function namesLine(names: string[], limit = 4): string {
  return joinNames(names.slice(0, limit)) + (names.length > limit ? " · …" : "");
}

/** One folder on the way down; `fork` says it was picked among several, `parent` is the page that lists its neighbours. */
export interface Station { node: NodeManifest; fork: boolean; parent: string }

export function stationsOf(roots: NodeRef[], chain: NodeManifest[]): Station[] {
  return chain.map((node, i) => {
    const above = chain[i - 1];
    return { node, fork: above ? isFork(above) : roots.length > 1, parent: above?.id ?? "" };
  });
}

/** Page where the nearest choice can be made again, or nothing when no choice was ever made. */
export const changeTarget = (stations: Station[]): string | undefined => stations.findLast((s) => s.fork)?.parent;

/** Nearest folder at or above the end of the chain that is a page of its own (more than one entry); the root list otherwise. */
export const pageAbove = (chain: NodeManifest[]): string => chain.findLast((n) => isFork(n))?.id ?? "";

/**
 * Where "#/" leads for a remembered place, judged from a chain of folders that reaches it: single entries are followed down,
 * the first real choice or the only bank is the answer. The same walk the home screen makes, without loading anything.
 */
export function homeOf(chain: NodeManifest[], place: string): Target {
  let at = chain.findIndex((n) => n.id === place);
  if (at < 0) return { type: "node", id: place };
  for (;;) {
    const folder = chain[at]!;
    const entries = entriesOf(folder);
    const only = entries.length === 1 ? entries[0]! : undefined;
    if (!only) return { type: "node", id: folder.id };
    if (only.type === "bank") return { type: "bank", node: folder.id, id: only.ref.id };
    if (chain[at + 1]?.id !== only.ref.id) return { type: "node", id: folder.id };
    at++;
  }
}

/** The kind shared by every entry when all of them are folders. */
export function sharedKind(entries: Entry[]): string | undefined {
  const first = entries[0];
  if (first?.type !== "node") return undefined;
  return entries.every((e) => e.type === "node" && e.ref.kind === first.ref.kind) ? first.ref.kind : undefined;
}

/**
 * An exam with answers is written to the log only when it ends, so every way out of it (the Back button, a changed address)
 * is held: the screen stays on the exam and the address the learner was heading for is kept until they choose to leave.
 * Pressing Back again with the question open keeps the first address; once the exam has no answers or has ended, nothing is held.
 */
export function holdExam(unsaved: boolean, path: string, heading: string | undefined, address: string): { heading: string | undefined; stay: boolean } {
  if (!unsaved) return { heading: undefined, stay: false };
  if (path === "session") return { heading, stay: false };
  return { heading: heading ?? address, stay: true };
}

/** What the app shows of the content index: `offline` only after the network was asked and did not answer. */
export interface ContentShown { index?: ContentIndex; offline: boolean; error?: unknown }
export type ContentStep = { stored: ContentIndex | undefined } | { fresh: ContentIndex; offline: boolean } | { failed: unknown };

/**
 * The index the device holds is shown at once and the network answer replaces it. The same version keeps the same object:
 * screens have effects that depend on the identity of `index`, and a copy would repeat them.
 */
export function showContent(now: ContentShown, step: ContentStep): ContentShown {
  if ("stored" in step) {
    if (now.index || !step.stored) return now;
    return { index: step.stored, offline: now.error != null };
  }
  if ("failed" in step) return now.index ? (now.offline && now.error == null ? now : { index: now.index, offline: true }) : { offline: false, error: step.failed };
  const index = now.index?.version === step.fresh.version ? now.index : step.fresh;
  return index === now.index && step.offline === now.offline && now.error == null ? now : { index, offline: step.offline };
}

/** What the learner has picked or typed on a question but not sent yet; kept by the screen so leaving the question and coming back loses nothing. */
export interface Draft { selected?: string[]; texts?: string[] }

/** The answer an unsent draft stands for, or nothing when it is empty or belongs to another way of answering. */
export function draftResponse(item: Pick<SessionItem, "mode">, draft: Draft | undefined): Response | undefined {
  if (item.mode === "choice" && draft?.selected?.length) return { mode: "choice", selected: draft.selected };
  if (item.mode === "typed" && draft?.texts?.some((x) => x.trim())) return { mode: "typed", texts: draft.texts };
  return undefined;
}

/** Questions that end up without an answer when the exam ends: no answer given and no draft that becomes one. */
export const unansweredCount = (items: SessionItem[], drafts: Record<number, Draft>): number =>
  items.filter((item, i) => !item.graded && !draftResponse(item, drafts[i])).length;

/**
 * The session with every unsent draft sent as the answer to its question, in order; `send` gives the session after one answer.
 * A draft on a question that already has an answer replaces it: it is what the learner last saw there.
 */
export function settleDrafts(s: Session, drafts: Record<number, Draft>, send: (done: Session, index: number, response: Response) => Session): Session {
  let out = s;
  s.items.forEach((item, i) => {
    const response = draftResponse(item, drafts[i]);
    if (response) out = send(out, i, response);
  });
  return out;
}

/** `settleDrafts` with the core's own `goTo` and `submit`: what the end of an exam runs. */
export function submitDrafts(s: Session, drafts: Record<number, Draft>, questions: Map<number, Parameters<typeof submit>[1]>, options: Parameters<typeof submit>[4], now: number): Session {
  return settleDrafts(s, drafts, (done, i, response) => {
    const q = questions.get(done.items[i]!.question);
    return q ? submit(goTo(done, i, now), q, response, now, options) : done;
  });
}

/**
 * An exam in progress as it is kept in local storage: the session, the unsent drafts, where to go back to, and the bank file (the bank itself stays in the content cache).
 * `pending` is set when the exam has ended: its answers as log events, kept until the log is known to hold them. Writing them again is harmless (same ids),
 * while ending the exam again would log every answer twice.
 */
export interface SavedExam { v: 1; session: Session; drafts: Record<number, Draft>; back: string; line?: number; hash: string; pending?: ProgressEvent[] }

/** Where the log write of a finished exam's answers stands, by session id (see `storePending` in `app.tsx`). */
export type WriteState = "saving" | "saved" | "failed";

/**
 * Finished exams' answers that the log may not hold yet, kept apart from the exam key (`KEYS.unwritten`): a new exam replaces that key,
 * and a write that fails twice must not take the earlier answers with it. Merged by id, so writing them again doubles nothing.
 */
export function parseUnwritten(raw: string | null): ProgressEvent[] {
  if (raw == null) return [];
  try {
    const x: unknown = JSON.parse(raw);
    return Array.isArray(x) ? x.filter(isProgressEvent) : [];
  } catch {
    return [];
  }
}
export function withUnwritten(kept: ProgressEvent[], added: ProgressEvent[]): ProgressEvent[] {
  const ids = new Set(kept.map((e) => e.id));
  return [...kept, ...added.filter((e) => !ids.has(e.id))];
}
export function withoutWritten(kept: ProgressEvent[], written: ProgressEvent[]): ProgressEvent[] {
  const ids = new Set(written.map((e) => e.id));
  return kept.filter((e) => !ids.has(e.id));
}

/**
 * What starting `next` does with the exam kept in storage: `flush` when the kept one has ended and its answers may not be in the log yet
 * (they are written first, and the key goes only once the log has them), `clear` when practice starts over an unfinished kept exam, else `none`.
 * The same session (every answer calls `run` again) and leaving (`next` is nothing) never touch the key.
 */
export function keptOnStart(kept: Pick<SavedExam, "session" | "pending"> | undefined, next: Pick<Session, "id" | "config"> | undefined): "none" | "flush" | "clear" {
  if (!kept || !next || kept.session.id === next.id) return "none";
  if (kept.pending) return "flush";
  return next.config.kind === "exam" ? "none" : "clear";
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStrings = (x: unknown) => Array.isArray(x) && x.every((v) => typeof v === "string");
const MODES = ["choice", "typed", "self_check"];

function isOpenExam(x: unknown): x is Session {
  if (!isObject(x) || typeof x.id !== "string" || typeof x.bank !== "string" || x.finishedAt != null) return false;
  if (!isNumber(x.startedAt) || !isNumber(x.shownAt) || !Number.isSafeInteger(x.index)) return false;
  const config = x.config;
  if (!isObject(config) || config.kind !== "exam" || !MODES.includes(config.answerMode as string)) return false;
  if ((config.timeLimitSec != null && !isNumber(config.timeLimitSec)) || (config.passPercent != null && !isNumber(config.passPercent))) return false;
  const items = x.items;
  if (!Array.isArray(items) || !items.length || (x.index as number) < 0 || (x.index as number) >= items.length) return false;
  return items.every((item) =>
    isObject(item) && Number.isSafeInteger(item.question) && MODES.includes(item.mode as string)
    && (item.graded == null || (isObject(item.graded) && isNumber(item.graded.score) && typeof item.graded.correct === "boolean")));
}

/** The value of the exam key, or nothing when it is absent, unreadable, of another version, foreign, finished or not an exam. Never throws. */
export function parseSavedExam(raw: string | null | undefined): SavedExam | undefined {
  if (!raw) return undefined;
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(x) || x.v !== 1 || typeof x.hash !== "string" || !x.hash || typeof x.back !== "string") return undefined;
  if (x.line != null && !isNumber(x.line)) return undefined;
  if (x.pending != null && !(Array.isArray(x.pending) && x.pending.every(isProgressEvent))) return undefined;
  if (!isOpenExam(x.session) || !isObject(x.drafts)) return undefined;
  const count = x.session.items.length;
  for (const [key, draft] of Object.entries(x.drafts)) {
    const at = Number(key);
    if (!Number.isSafeInteger(at) || at < 0 || at >= count || !isObject(draft)) return undefined;
    if ((draft.selected != null && !isStrings(draft.selected)) || (draft.texts != null && !isStrings(draft.texts))) return undefined;
  }
  return x as unknown as SavedExam;
}

/** Cache keys the saved exam needs kept: its bank file. */
export const pinnedBanks = (raw: string | null | undefined): string[] => {
  const saved = parseSavedExam(raw);
  return saved ? [`banks/${saved.hash}`] : [];
};

/** Whether a loaded bank is the one the session was made from and still holds all its questions. */
export const fitsBundle = (s: Session, bundle: Pick<BankBundle, "bank" | "questions">): boolean => {
  const ids = new Set(bundle.questions.map((q) => q.id));
  return bundle.bank.id === s.bank && s.items.every((item) => ids.has(item.question));
};

const STYLE_PROPERTIES = [
  /^(min-|max-)?(width|height)$/, /^(top|bottom|left|right)$/, /^margin(-(top|right|bottom|left))?$/, /^padding(-(top|right|bottom|left))?$/,
  /^(vertical-align|font-size|color|background-color)$/, /^border(-(top|right|bottom|left))?-(width|style|color)$/,
];
/** Properties whose value must be one of a few words; the others take a length or a colour. */
const STYLE_WORDS: Record<string, RegExp> = { position: /^relative$/, display: /^(inline|inline-block|block)$/ };
const STYLE_VALUE = /^[\w\s.,%#()+-]+$/;
const STYLE_MAX = 100;
const STYLE_DANGER =/url\(|expression\(|@import|javascript:|\\/i;

/**
 * The declarations of a style attribute that KaTeX needs for its layout and that are harmless: a short list of properties, with plain
 * lengths and colours as values. What could load or run something (`url(`, `expression(`, `@import`, `javascript:`, a backslash) goes.
 */
export function safeStyle(style: string): string {
  const kept: string[] = [];
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!value || STYLE_DANGER.test(value)) continue;
    const words = STYLE_WORDS[property];
    if (words ? !words.test(value) : !STYLE_PROPERTIES.some((p) => p.test(property)) || !STYLE_VALUE.test(value)) continue;
    // A formula has no use for a length of hundreds of em (`\kern{-9999em}`, `\rule{500em}{500em}`): it would cover or push away the screen.
    if (!property.endsWith("color") && (value.match(/\d+(\.\d+)?/g) ?? []).some((n) => Number(n) > STYLE_MAX)) continue;
    kept.push(`${property}:${value}`);
  }
  return kept.join(";");
}

/** Download addresses of the installable apps, set at build time (`downloads.json` in the repository root). */
export type Downloads = { windows?: string; android?: string };
export type AppLink = { os: "windows" | "android"; href: string };

/**
 * Whether the page runs inside the Windows or Android app: they serve it from tauri.localhost and inject Tauri's internals
 * (`tauri dev` too, which serves it from localhost), and Android adds its own bridge.
 */
export const isShell = (hostname: string, globals: object): boolean =>
  hostname === "tauri.localhost" || "__TAURI_INTERNALS__" in globals || "ExamSystemBars" in globals;

/** Links to the Windows and Android apps, for the web page only: inside an app there is nothing to download. An Android phone sees its own app first. */
export function appLinks(downloads: Downloads, inShell: boolean, userAgent: string): AppLink[] {
  if (inShell) return [];
  const links = (["windows", "android"] as const).flatMap((os) => (downloads[os] ? [{ os, href: downloads[os] }] : []));
  return /android/i.test(userAgent) ? links.reverse() : links;
}

/**
 * Where an update of the Windows or Android app stands. The shell does the work (`update.rs`, `AppUpdates.kt`) and reports:
 * `off` no updates in this build or on this platform, `ready` downloaded and verified (Android), `permission` Android must allow
 * this app to install apps, `installing` the Windows installer runs and closes the app.
 */
export const UPDATE_PHASES = ["off", "idle", "checking", "latest", "available", "downloading", "installing", "ready", "permission", "failed"] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];
export type UpdateState = { phase: UpdatePhase; current?: string; version?: string; size?: number; received?: number; reason?: string };

/** The shell's report as the page uses it: a value it does not know turns into `off`, a field of the wrong type is dropped. */
export function readUpdateState(raw: unknown): UpdateState {
  const value = (typeof raw === "string" ? safeParse(raw) : raw) as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || !UPDATE_PHASES.includes(value.phase as UpdatePhase)) return { phase: "off" };
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  const count = (key: string) => (typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0 ? (value[key] as number) : undefined);
  const state: UpdateState = { phase: value.phase as UpdatePhase };
  const fields = { current: text("current"), version: text("version"), size: count("size"), received: count("received"), reason: text("reason") };
  for (const [key, field] of Object.entries(fields)) if (field !== undefined) Object.assign(state, { [key]: field });
  return state;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The app looks for a new version by itself at most once a day: the manifest is tiny, but nobody needs it more often. */
export const UPDATE_CHECK_EVERY = 24 * 60 * 60 * 1000;

/** Whether the automatic check is due. A stored time in the future (a clock set back) counts as due rather than blocking checks for good. */
export const isUpdateDue = (lastCheck: number | undefined, now: number): boolean =>
  lastCheck == null || !Number.isFinite(lastCheck) || lastCheck > now || now - lastCheck >= UPDATE_CHECK_EVERY;

/**
 * Only "nothing new" restarts the daily wait. A found update is not remembered across launches, so the next launch checks
 * again and offers it again; a failed check is retried at the next launch too.
 */
export const isCheckDone = (phase: UpdatePhase): boolean => phase === "latest";

export interface AsyncState<T> { data?: T; error?: unknown }
export type AsyncStep<T> = { start: true } | { data: T } | { error: unknown };

/**
 * The state of a load: new data replaces the old; a new load clears an error but keeps the data shown, and a failed one keeps it too,
 * so a changed key never blanks the screen. Without an error a start gives the same object back, so nothing re-renders.
 */
export function stepAsync<T>(now: AsyncState<T>, step: AsyncStep<T>): AsyncState<T> {
  if ("data" in step) return { data: step.data };
  if ("error" in step) return { data: now.data, error: step.error };
  return now.error == null ? now : { data: now.data };
}

/** Firefox shows a permission prompt when a page asks for persistent storage, so there it is asked at a moment the learner chose. */
export const isFirefox = (userAgent: string): boolean => /\bFirefox\//.test(userAgent);

/** What the learner chose on a bank's preparation panel. */
export interface Setup {
  scope: "smart" | "all" | "mistakes" | "bookmarks"; answerMode: AnswerMode; kind: "practice" | "exam"; topics: number[]; level: number; count: number; minutes: number;
  /** Questions per difficulty level of the bank's own exam; used only for an exam with any difficulty, scaled to `count`. */
  levels?: LevelShare[];
}

export interface LevelShare { level: number; count: number }

/** `total` split in proportion to the shares by largest remainders, so the parts add up to exactly `total`; empty parts are dropped. */
export function scaleShares(shares: readonly LevelShare[], total: number): LevelShare[] {
  const sum = shares.reduce((a, s) => a + s.count, 0);
  if (!(sum > 0) || !(total > 0)) return [];
  const parts = shares.map((s, i) => {
    const exact = (s.count * total) / sum;
    return { i, level: s.level, floor: Math.floor(exact), rest: exact - Math.floor(exact), weight: s.count };
  });
  let left = total - parts.reduce((a, p) => a + p.floor, 0);
  // Bigger remainder first; a tie goes to the bigger share, then to the earlier level.
  for (const p of [...parts].sort((a, b) => b.rest - a.rest || b.weight - a.weight || a.i - b.i)) {
    if (left <= 0) break;
    p.floor++;
    left--;
  }
  return parts.filter((p) => p.floor > 0).map((p) => ({ level: p.level, count: p.floor }));
}

const isShares = (x: unknown): x is LevelShare[] =>
  Array.isArray(x) && x.length > 0 && x.every((s) => isObject(s) && Number.isSafeInteger(s.level) && Number.isSafeInteger(s.count) && (s.count as number) >= 0) && x.some((s) => (s as LevelShare).count > 0);

export interface SessionInput {
  bankId: string; questions: Question[]; states: Map<number, QuestionState>; stats: Pick<BankStats, "mistakes" | "bookmarks">; setup: Setup;
  unsupported: "self_check" | "skip";
  /** Explicit questions (one opened from the map, the mistakes of the last session): always practice, asked in the nearest mode they support. */
  only?: number[]; now: number; seed: number; id: string;
}

/** The session the panel asks for, or nothing when no question fits. */
export function buildSession(input: SessionInput): Session | undefined {
  const { questions, states, stats, setup, only, now } = input;
  const practice = only != null || setup.kind === "practice";
  const smart = !only && practice && setup.scope === "smart";
  const unsupported = only ? "self_check" : input.unsupported;
  const fits = (q: Question) => (!setup.topics.length || setup.topics.includes(q.topic_id)) && (!setup.level || q.difficulty_level === setup.level);
  let ids = only ?? (setup.scope === "mistakes" ? stats.mistakes : setup.scope === "bookmarks" ? stats.bookmarks : undefined);
  // Shares make no sense for "all of it" (count 0), so they need a count to scale to.
  const shares = !only && !practice && !setup.level && setup.count > 0 && setup.levels?.length ? scaleShares(setup.levels, setup.count) : [];
  if (shares.length) {
    const pool = questions.filter((q) => !q.retired && fits(q) && (!ids || ids.includes(q.id)) && modeFor(q, { answerMode: setup.answerMode, unsupported }));
    const chosen: Question[] = [];
    for (const { level, count } of shares) chosen.push(...shuffled(pool.filter((q) => q.difficulty_level === level), input.seed).slice(0, count));
    // A level with too few questions is topped up from whatever the pool has left.
    const taken = new Set(chosen.map((q) => q.id));
    chosen.push(...shuffled(pool.filter((q) => !taken.has(q.id)), input.seed).slice(0, setup.count - chosen.length));
    ids = shuffled(chosen, input.seed).map((q) => q.id);
  } else if (smart) {
    // Only questions the chosen answer mode can ask, or the draw could hand the session questions it then drops.
    const pool = questions.filter((q) => !q.retired && fits(q) && modeFor(q, { answerMode: setup.answerMode, unsupported }));
    ids = pickAdaptive(pool, states, now, setup.count || undefined, input.seed);
  }
  // An empty id list would mean "no restriction" to createSession, so it must stop here.
  if (ids && !ids.length) return undefined;
  const config: SessionConfig = {
    kind: practice ? "practice" : "exam", answerMode: setup.answerMode, unsupported, shuffle: true, seed: input.seed, keepOrder: smart || shares.length > 0, relearn: practice,
    topics: only ? [] : setup.topics, levels: !only && setup.level ? [setup.level] : undefined, ids, count: only ? only.length : setup.count || undefined,
    timeLimitSec: !practice && setup.minutes ? setup.minutes * 60 : undefined, passPercent: !practice ? 50 : undefined,
  };
  const session = createSession(input.bankId, questions, config, now, input.id);
  return session.items.length ? session : undefined;
}

const SCOPES = ["smart", "all", "mistakes", "bookmarks"];
const KINDS = ["practice", "exam"];
const DEFAULT_SETUP: Setup = { scope: "smart", answerMode: "choice", kind: "practice", topics: [], level: 0, count: 20, minutes: 20 };
const SETUPS_KEPT = 30;

const isSetup = (x: unknown): x is Setup =>
  isObject(x) && SCOPES.includes(x.scope as string) && MODES.includes(x.answerMode as string) && KINDS.includes(x.kind as string)
  && Array.isArray(x.topics) && x.topics.every((t) => Number.isSafeInteger(t)) && isNumber(x.level) && isNumber(x.count) && isNumber(x.minutes);

/** The stored form is a list of [bank, setup] pairs, oldest first: an object would sort keys that look like numbers. A plain object is read too. */
function readSetups(raw: string | null | undefined): [string, Setup][] {
  const x = raw ? safeParse(raw) : null;
  const pairs: unknown[] = Array.isArray(x) ? x : isObject(x) ? Object.entries(x) : [];
  return pairs.filter((p): p is [string, Setup] => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && isSetup(p[1]))
    // A malformed `levels` costs only the shares, not the rest of the remembered setup.
    .map(([id, setup]) => {
      const { levels, ...rest } = setup;
      return [id, isShares(levels) ? { ...rest, levels: levels.map((s) => ({ level: s.level, count: s.count })) } : rest];
    });
}

/** The remembered setups by bank id. Never throws; an entry that is not well-formed is dropped. */
export const parseSetups = (raw: string | null | undefined): Record<string, Setup> => Object.fromEntries(readSetups(raw));

/** The remembered setup of one bank. A bank id that is also a property of every object (`constructor`, `__proto__`) is not a hit unless it was stored. */
export function setupOf(raw: string | null | undefined, bankId: string): Setup | undefined {
  const all = parseSetups(raw);
  return Object.hasOwn(all, bankId) ? all[bankId] : undefined;
}

/** The setup put last and only the `limit` most recently stored banks kept. */
export function storeSetup(raw: string | null | undefined, bankId: string, setup: Setup, limit = SETUPS_KEPT): string {
  const rest = readSetups(raw).filter(([id]) => id !== bankId);
  return JSON.stringify([...rest, [bankId, setup]].slice(-Math.max(1, limit)));
}

export interface BankFacts { topicIds: number[]; levels: number[]; mistakes: number; bookmarks: number; questions: number }

const whole = (n: number, max = Infinity) => Math.min(max, Math.max(0, Number.isFinite(n) ? Math.round(n) : 0));

/** A remembered setup made valid for the bank as it is now (topics, levels and lists may have changed), or the default when none is saved. */
export function fitSetup(saved: Setup | undefined, facts: BankFacts): Setup {
  if (!saved) return { ...DEFAULT_SETUP, topics: [] };
  let scope = saved.scope;
  if ((scope === "mistakes" && !facts.mistakes) || (scope === "bookmarks" && !facts.bookmarks)) scope = "smart";
  if (saved.kind === "exam" && scope === "smart") scope = "all";
  const levels = saved.levels?.filter((s) => facts.levels.includes(s.level));
  return {
    scope, answerMode: saved.answerMode, kind: saved.kind,
    topics: saved.topics.filter((id) => facts.topicIds.includes(id)),
    level: facts.levels.includes(saved.level) ? saved.level : 0,
    count: whole(saved.count, facts.questions), minutes: whole(saved.minutes),
    ...(levels?.some((s) => s.count > 0) ? { levels } : {}),
  };
}

/** The length and size of a bank's mock exam from its free-form `exam` object (both positive whole numbers), and its questions per difficulty level when all are given. */
export function examProfile(exam: unknown): { minutes: number; count: number; levels?: LevelShare[] } | undefined {
  if (!isObject(exam)) return undefined;
  const minutes = exam.duration_minutes;
  const count = exam.test_question_count;
  const ok = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
  if (!ok(minutes) || !ok(count)) return undefined;
  // `official_levels` counts per test; a record with `bank_share` instead is a share of the bank, not of the test, and is not read.
  const raw = exam.official_levels;
  const levels = Array.isArray(raw) ? raw.map((r) => (isObject(r) ? { level: r.level, count: r.per_test } : r)) : undefined;
  return isShares(levels) ? { minutes, count, levels } : { minutes, count };
}

/** How many seen questions have their repeat time come, counted from the states alone; withdrawn ids are left out as in `bankProgress`. */
export function dueCount(states: Map<number, QuestionState>, now: number, retired: readonly number[] = []): number {
  let due = 0;
  for (const [id, state] of states) if (state.lastAt != null && !retired.includes(id) && isDue(state.memory, now)) due++;
  return due;
}

const SNIPPET = 120;

/** The question text cut to about `SNIPPET` characters around the first place a word of the query appears. */
function snippetOf(text: string, words: string[]): string {
  if (text.length <= SNIPPET) return text;
  const lower = text.toLocaleLowerCase();
  const found = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const at = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, Math.min(at - SNIPPET / 4, text.length - SNIPPET));
  const end = Math.min(text.length, start + SNIPPET);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * A text without its markdown and TeX marks, for what is shown as plain text: a search result, and the text drawn before the markup chunk arrives.
 * Careful rather than complete: a mark goes only where the renderer would read it as one, so `snake_case`, `5 * 3`, `$5` and a lone `_` stay.
 */
export function plainText(text: string): string {
  // Code and formulas are set aside first, so marks inside them are not read as markdown; a formula opens and closes like the renderer's rule (no space inside the dollars).
  const held: string[] = [];
  const hold = (inner: string) => `${held.push(inner) - 1}`;
  return text
    .replace(/```[^\n]*\n?([\s\S]*?)\n?```/g, (_, code: string) => hold(code))
    .replace(/`([^`\n]+)`/g, (_, code: string) => hold(code))
    .replace(/\$\$(?!\s)([^$]*[^\s$])\$\$/g, (_, tex: string) => hold(tex))
    .replace(/\$(?!\s)([^$]*[^\s$])\$/g, (_, tex: string) => hold(tex))
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, "")
    // No lookbehind (older Safari fails to parse it): the character before a mark is captured and put back. A mark glued to a word is not one.
    .replace(/(^|[^\w*])\*\*(?=\S)([^*\n]*[^\s*])\*\*(?![\w*])/g, "$1$2")
    .replace(/(^|\W)__(?=\S)([^_\n]*[^\s_])__(?!\w)/g, "$1$2")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*[^\s*])\*(?![\w*])/g, "$1$2")
    .replace(/(^|\W)_(?=[^\s_])([^_\n]*[^\s_])_(?!\w)/g, "$1$2")
    .replace(/(^|[^\w~])~~(?=\S)([^~\n]*[^\s~])~~(?![\w~])/g, "$1$2")
    .replace(/(\d+)/g, (_, n: string) => held[Number(n)] ?? "");
}

/** Whether a query is long enough to search: a number from one digit (a question number runs from 1), anything else from two characters. */
export const searchable = (query: string): boolean => {
  const trimmed = query.trim();
  return /^\d+$/.test(trimmed) || trimmed.length >= 2;
};

/**
 * Questions whose text or option text holds every word of the query (a number also finds the question with that id, first).
 * `text` picks the language, so the search sees what the learner reads; markdown and TeX marks are left out of what is searched and shown.
 * A single digit finds only the question with that number: as a word it would match nearly every text.
 */
export function findQuestions(questions: Question[], query: string, text: (value: Localized | undefined) => string, limit = 50): { id: number; topic: number; snippet: string }[] {
  const trimmed = query.trim();
  if (!searchable(trimmed)) return [];
  const words = trimmed.toLocaleLowerCase().split(/\s+/);
  const byId = /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
  const idOnly = trimmed.length < 2;
  const hits: { q: Question; body: string }[] = [];
  for (const q of questions) {
    if (q.retired) continue;
    const body = plainText(text(q.question));
    const options = q.type === "single_choice" || q.type === "multiple_choice" ? q.options.map((o) => plainText(text(o.text))) : [];
    const haystack = [body, ...options].map((x) => x.toLocaleLowerCase());
    if (q.id === byId || (!idOnly && words.every((w) => haystack.some((h) => h.includes(w))))) hits.push({ q, body });
  }
  hits.sort((a, b) => Number(b.q.id === byId) - Number(a.q.id === byId));
  return hits.slice(0, limit).map(({ q, body }) => ({ id: q.id, topic: q.topic_id, snippet: snippetOf(body, words) }));
}

const BACKUP_EVERY = 14 * 24 * 60 * 60 * 1000;
const BACKUP_MIN_EVENTS = 50;

/** Whether to remind the learner to save the progress to a file: only on the web page (the apps keep their own data), once there is something worth keeping. */
export const backupDue = (input: { shell: boolean; events: number; lastBackup: number | undefined; now: number }): boolean => {
  const { shell, events, lastBackup, now } = input;
  if (shell || events < BACKUP_MIN_EVENTS) return false;
  return lastBackup == null || !Number.isFinite(lastBackup) || lastBackup > now || now - lastBackup >= BACKUP_EVERY;
};

export interface SessionKeyEvent {
  code: string; key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean;
  target: { tagName?: string; isContentEditable?: boolean; type?: string } | null; dialogOpen: boolean;
  /** Set while an input method (IME) composes text: its keys belong to it. */
  isComposing?: boolean;
}

/** Whether the focused element takes typed keys itself: a text field must keep its digits and Enter. */
function typesText(target: SessionKeyEvent["target"]): boolean {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase();
  if (target.isContentEditable || tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !["radio", "checkbox"].includes((target.type ?? "").toLowerCase());
}

/**
 * What a key does in a session: a digit picks that option, Enter does the main action.
 * The top row goes by the physical key (`code`), because on the Kazakh layout it types letters. The numpad needs `key` to be a digit too:
 * without NumLock the same keys are End, ArrowDown and the like. An input method that is composing keeps its keys (Enter confirms its text).
 */
export function sessionKey(e: SessionKeyEvent, options: number): { pick: number } | "primary" | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey || e.dialogOpen || e.isComposing === true || e.key === "Process" || typesText(e.target)) return undefined;
  if (e.code === "Enter" || e.code === "NumpadEnter" || e.key === "Enter") {
    const tag = e.target?.tagName?.toUpperCase();
    // A button or link already acts on Enter by itself.
    return tag === "BUTTON" || tag === "A" ? undefined : "primary";
  }
  const digit = /^(Digit|Numpad)([1-9])$/.exec(e.code);
  const n = digit && (digit[1] === "Digit" || /^[0-9]$/.test(e.key)) ? Number(digit[2]) : 0;
  return n >= 1 && n <= options ? { pick: n - 1 } : undefined;
}

/** The options picked after one is pressed: a single choice is replaced, a multiple choice flips that option. */
export const toggleChoice = (selected: string[], id: string, single: boolean): string[] =>
  single ? [id] : selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];

/** What the learner answered, as lines to show in the review: the chosen options' texts, or the typed texts; none when nothing was answered or the way of answering gave no text. */
export function givenLines(response: Response | undefined, q: Question, text: (value: Localized | undefined) => string): string[] {
  if (response?.mode === "choice" && (q.type === "single_choice" || q.type === "multiple_choice")) return q.options.filter((o) => response.selected.includes(o.id)).map((o) => text(o.text));
  if (response?.mode === "typed") return response.texts.map((x) => x.trim()).filter(Boolean);
  return [];
}
