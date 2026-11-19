import { LEARNED_BOX, entriesOf, goTo, isFork, strength, submit, type BankBundle, type ContentIndex, type Entry, type NodeManifest, type NodeRef, type ProgressEvent, type QuestionState, type Response, type Session, type SessionItem, type Target } from "@exam/core";

/**
 * What the result counts as shown. An exam counts every question, answered or not. Practice moves only forward, so an item behind
 * the current one was answered or skipped; the ones ahead, repeats queued after a miss among them, were never shown. Leaving early
 * is not a miss, nor is the open question left unanswered when the student finishes.
 */
export const shown = (s: Pick<Session, "config" | "items" | "index">) =>
  s.items.filter((item, i) => s.config.kind === "exam" || item.graded != null || i < s.index);

/** The app's own keys in local storage. On a shared origin (a github.io site) any other key belongs to someone else. */
export const KEYS = { settings: "settings", place: "place", device: "device", exam: "exam", updateCheck: "updateCheck" } as const;

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
