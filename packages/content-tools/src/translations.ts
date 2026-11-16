import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { discoverContent, listBanks } from "./discover.ts";

type Json = Record<string, any>;

export interface MergeResult {
  errors: string[];
  warnings: string[];
  /** Sidecar files folded in (0 when there were errors). */
  sidecars: number;
  /** Source files rewritten. */
  written: number;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const filled = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : entry.endsWith(".json") ? [path] : [];
  });
}

/** String -> `{ <language>: original, <locale>: text }`; map -> the locale key is set. The original text is never touched. */
function localize(value: unknown, language: string, locale: string, text: string): Json {
  const map: Json = typeof value === "string" ? { [language]: value } : isObject(value) ? { ...value } : {};
  map[locale] = text;
  return map;
}

interface BankState {
  dir: string;
  bank: Json;
  files: Map<string, Json>;
  /** Serialized form as loaded, to rewrite only what changed. */
  original: Map<string, string>;
  questions: Map<number, Json>;
}

function loadState(dir: string, where: string, errors: string[]): BankState | undefined {
  try {
    const bank = readJson(join(dir, "bank.json"));
    const files = new Map<string, Json>();
    const original = new Map<string, string>([["bank.json", JSON.stringify(bank)]]);
    const questions = new Map<number, Json>();
    const qdir = join(dir, "questions");
    for (const name of existsSync(qdir) ? readdirSync(qdir).filter((f) => f.endsWith(".json")).sort() : []) {
      const file = readJson(join(qdir, name));
      files.set(name, file);
      original.set(name, JSON.stringify(file));
      for (const q of file.questions ?? []) questions.set(q.id, q);
    }
    return { dir, bank, files, original, questions };
  } catch (e) {
    errors.push(`${where}: cannot read bank: ${(e as Error).message}`);
    return undefined;
  }
}

function checkBankSidecar(state: BankState, side: Json, where: string, err: (m: string) => void) {
  if ("subject" in side && !filled(side.subject)) err(`${where}: subject is empty`);
  for (const [level, title] of Object.entries<any>(side.difficulty_scale ?? {})) {
    if (!filled(title)) err(`${where}: difficulty_scale.${level} is empty`);
    if (!state.bank.difficulty_scale?.some((s: Json) => String(s.level) === level)) err(`${where}: difficulty level ${level} is not in the bank`);
  }
}

function checkTopicSidecar(state: BankState, side: Json, where: string, err: (m: string) => void, warn: (m: string) => void) {
  const topic = (state.bank.topics as Json[]).find((t) => t.id === side.topic_id);
  if (!topic) return err(`${where}: topic_id ${side.topic_id} is not in the bank`);
  if ("topic_name" in side && !filled(side.topic_name)) err(`${where}: topic_name is empty`);
  if (!isObject(side.questions)) return err(`${where}: "questions" must be an object`);

  for (const [key, t] of Object.entries<any>(side.questions)) {
    const w = `${where}: question ${key}`;
    const q = state.questions.get(Number(key));
    if (!q) { err(`${w}: no such question in the bank`); continue; }
    if (q.topic_id !== side.topic_id) err(`${w}: belongs to topic ${q.topic_id}, not ${side.topic_id}`);
    if (!isObject(t)) { err(`${w}: must be an object`); continue; }
    if (!filled(t.question)) err(`${w}: question text is empty or missing`);

    const sourceIds: string[] = (q.options ?? []).map((o: Json) => o.id);
    if (sourceIds.length || t.options !== undefined) {
      const given = isObject(t.options) ? Object.keys(t.options) : [];
      const missing = sourceIds.filter((id) => !given.includes(id));
      const extra = given.filter((id) => !sourceIds.includes(id));
      if (missing.length) err(`${w}: missing options ${missing.join(", ")}`);
      if (extra.length) err(`${w}: unknown options ${extra.join(", ")}`);
      for (const id of given) if (!filled(t.options[id])) err(`${w}: option ${id} is empty`);
    }

    const fi = t.free_input;
    if (fi === undefined) {
      if (q.free_input) warn(`${w}: free_input is not translated`);
      continue;
    }
    if (!q.free_input) { err(`${w}: has no free_input in the bank`); continue; }
    if (!isObject(fi)) { err(`${w}: free_input must be an object`); continue; }
    if (fi.question !== undefined && !filled(fi.question)) err(`${w}: free_input.question is empty`);
    const accept = isObject(fi.accept) ? fi.accept : {};
    const forIds: string[] = q.free_input.answers.map((a: Json) => a.for);
    for (const [id, list] of Object.entries<any>(accept)) {
      if (!forIds.includes(id)) err(`${w}: free_input.accept "${id}" matches no answer`);
      if (!Array.isArray(list) || !list.length || !list.every(filled)) err(`${w}: free_input.accept.${id} must be a non-empty list of non-empty strings`);
    }
    const unanswered = forIds.filter((id) => !(id in accept));
    if (unanswered.length) warn(`${w}: free_input.accept has no translation for ${unanswered.join(", ")}`);
    if (fi.reject !== undefined && (!Array.isArray(fi.reject) || !fi.reject.every(filled))) err(`${w}: free_input.reject must be a list of non-empty strings`);
  }
}

function foldTopicSidecar(state: BankState, side: Json, locale: string) {
  const lang: string = state.bank.language;
  if ("topic_name" in side) {
    const topic = (state.bank.topics as Json[]).find((t) => t.id === side.topic_id)!;
    topic.name = localize(topic.name, lang, locale, side.topic_name);
  }
  for (const [key, t] of Object.entries<Json>(side.questions)) {
    const q = state.questions.get(Number(key))!;
    q.question = localize(q.question, lang, locale, t.question);
    for (const o of q.options ?? []) o.text = localize(o.text, lang, locale, t.options[o.id]);
    const fi = t.free_input;
    const spec = q.free_input;
    if (fi === undefined || !spec) continue;
    // With no source `question` there is nothing to translate: a lone locale key would hide the original.
    if (fi.question !== undefined && spec.question !== undefined) spec.question = localize(spec.question, lang, locale, fi.question);
    for (const a of spec.answers) {
      if (a.for in (fi.accept ?? {})) a.accept = { ...a.accept, [locale]: fi.accept[a.for] };
    }
    if (fi.reject !== undefined) spec.reject = { ...(isObject(spec.reject) ? spec.reject : {}), [locale]: fi.reject };
  }
}

function foldBankSidecar(state: BankState, side: Json, locale: string) {
  const { bank } = state;
  if ("subject" in side) bank.subject = localize(bank.subject, bank.language, locale, side.subject);
  for (const [level, title] of Object.entries<string>(side.difficulty_scale ?? {})) {
    const entry = bank.difficulty_scale.find((s: Json) => String(s.level) === level);
    entry.title = localize(entry.title, bank.language, locale, title);
  }
}

/**
 * Fold every translation sidecar (`<bank folder>/translations/<locale>/<file>.json`) into the bank sources.
 * Banks are found by walking the content tree. All problems are collected before anything is written;
 * with errors, nothing is.
 */
export function mergeTranslations(root: string): MergeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const states = new Map<string, BankState>();
  const locales = new Map<string, Set<string>>();
  const accepted: { state: BankState; side: Json; locale: string; isBank: boolean }[] = [];

  const { roots, problems } = discoverContent(root);
  errors.push(...problems);

  for (const { dir } of listBanks(roots)) {
    const bankWhere = relative(root, dir).replaceAll("\\", "/");
    const tdir = join(dir, "translations");
    for (const path of walk(tdir).sort()) {
      const rel = relative(tdir, path).replaceAll("\\", "/");
      const where = `${bankWhere}/translations/${rel}`;
      const parts = rel.split("/");
      if (parts.length !== 2) { errors.push(`${where}: expected translations/<locale>/<file>.json`); continue; }
      const [locale, file] = parts as [string, string];
      let side: Json;
      try {
        side = readJson(path);
      } catch (e) {
        errors.push(`${where}: ${(e as Error).message}`);
        continue;
      }

      if (!isObject(side)) { errors.push(`${where}: must be a JSON object`); continue; }

      if (!states.has(dir)) {
        const loaded = loadState(dir, bankWhere, errors);
        if (loaded) states.set(dir, loaded);
      }
      const state = states.get(dir);
      if (!state) continue;
      if (side.bank !== state.bank.id) errors.push(`${where}: bank "${side.bank}" does not match the bank id "${state.bank.id}"`);
      if (side.locale !== locale) errors.push(`${where}: locale "${side.locale}" does not match the path "${locale}"`);
      if (locale === state.bank.language) { errors.push(`${where}: locale is the bank's original language`); continue; }

      const before = errors.length;
      const isBank = file === "bank.json";
      const err = (m: string) => errors.push(m);
      if (isBank) checkBankSidecar(state, side, where, err);
      else {
        checkTopicSidecar(state, side, where, err, (m) => warnings.push(m));
        const covered = new Set(Object.keys(isObject(side.questions) ? side.questions : {}).map(Number));
        const lacking = [...state.questions.values()].filter((q) => q.topic_id === side.topic_id && !covered.has(q.id)).map((q) => q.id);
        if (lacking.length) warnings.push(`${where}: no translation for questions ${lacking.join(", ")}`);
      }
      if (errors.length > before) continue;
      accepted.push({ state, side, locale, isBank });
      if (!locales.has(dir)) locales.set(dir, new Set());
      locales.get(dir)!.add(locale);
    }
  }
  if (errors.length) return { errors, warnings, sidecars: 0, written: 0 };

  for (const { state, side, locale, isBank } of accepted) (isBank ? foldBankSidecar : foldTopicSidecar)(state, side, locale);
  for (const [dir, set] of locales) {
    const bank = states.get(dir)!.bank;
    const translations: Json = bank.translations ?? {};
    for (const locale of [...set].sort()) if (translations[locale] !== "reviewed") translations[locale] = "machine";
    bank.translations = translations;
  }

  let written = 0;
  const save = (path: string, name: string, data: Json, state: BankState) => {
    if (JSON.stringify(data) === state.original.get(name)) return;
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
    written++;
  };
  for (const state of states.values()) {
    save(join(state.dir, "bank.json"), "bank.json", state.bank, state);
    for (const [name, file] of state.files) save(join(state.dir, "questions", name), name, file, state);
  }
  return { errors, warnings, sidecars: accepted.length, written };
}
