import Dexie from "dexie";
import { ContentClient, uuidv7, type Http, type KeyValue, type ProgressEvent } from "@exam/core";
import { KEYS, isFirefox, isShell, parseSavedExam, pinnedBanks, setupOf, storeSetup, wipe, type SavedExam, type Setup } from "./lib.ts";

const db = new Dexie("exam-platform");
db.version(1).stores({ kv: "", events: "id" });

const cache: KeyValue = {
  get: (key) => db.table("kv").get(key),
  set: async (key, value) => void (await db.table("kv").put(value, key)),
  keys: () => db.table("kv").toCollection().primaryKeys() as Promise<string[]>,
  delete: (key) => db.table("kv").delete(key),
};

const http: Http = {
  // The signal also covers reading the body, so a connection that stalls mid-file is given up too.
  async get(url, signal) {
    const response = await fetch(url, { cache: url.endsWith("index.json") ? "no-cache" : "default", signal });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.text();
  },
};

/** A key of local storage as text; storage that cannot be read gives nothing. */
function readKey(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The network mirrors give the index; the snapshot shipped inside the app, when the build has one, is its fallback and the first place to look for hashed files. */
export const client = new ContentClient([...__CONTENT_URLS__], http, cache, {
  snapshot: __CONTENT_SNAPSHOT__ ? "./content" : undefined,
  pinned: () => pinnedBanks(readKey(KEYS.exam)),
});

export const loadEvents = (): Promise<ProgressEvent[]> => db.table("events").toArray();
export const saveEvents = (events: ProgressEvent[]) => db.table("events").bulkPut(events);
/** Everything the app stored: the log, the downloaded banks, settings and the remembered place. The caller reloads the page, so nothing held in memory writes it back. */
export const clearAppData = () => wipe([db.table("kv"), db.table("events")], localStorage);

/** Firefox asks the learner for permission when the page requests persistent storage, so there the request waits for a deliberate click (see `settings.tsx`). */
export const persistOnClick = (): boolean => isFirefox(navigator.userAgent);

let persistAsked = false;
/** Asks the browser, once per launch, not to clear the log under storage pressure. The apps keep their data themselves. */
export function requestPersistence(): void {
  if (persistAsked || inShell()) return;
  persistAsked = true;
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    // an unsupported browser keeps the log as before
  }
}

/** Bytes the page's storage takes on the device, where the browser can tell. */
export const storageUsed = async (): Promise<number | undefined> => (await navigator.storage?.estimate?.())?.usage;

export const UI_LOCALES = ["kk", "ru", "en"] as const;
export const LOCALE_NAMES: Record<string, string> = { kk: "Қазақша", ru: "Русский", en: "English" };

export type Theme = "system" | "light" | "dark";
export const THEMES: Theme[] = ["system", "light", "dark"];

export interface Settings {
  ui: string;
  theme: Theme;
  /** "auto" follows the interface language. */
  content: string;
  unsupported: "self_check" | "skip";
}

function read<T>(key: string, fallback: () => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {
    // unreadable storage falls through to the default
  }
  const value = fallback();
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // not remembered: the value is used for this run only
  }
  return value;
}

export const loadSettings = (): Settings => ({
  ui: UI_LOCALES.find((l) => navigator.language.toLowerCase().startsWith(l)) ?? "ru",
  theme: "system",
  content: "auto",
  unsupported: "self_check",
  ...read<Partial<Settings>>(KEYS.settings, () => ({})),
});

const prefersDark = () => matchMedia("(prefers-color-scheme: dark)");
declare global {
  /**
   * `ExamSystemBars` exists in the Android shell only. The page owns the theme, so it tells the status and navigation bars which icons to draw;
   * and while an exam holds answers or a sheet is open it asks for the Back button (`holdBack`, see `back.ts`), which the shell then hands to `examBack` instead of going back in history.
   */
  interface Window {
    ExamSystemBars?: { setDark(dark: boolean): void; holdBack(hold: boolean): void };
    examBack?: () => void;
  }
}
/** Inside the Windows or Android app (see `isShell`); anything else is the web page. */
export const inShell = (): boolean => isShell(location.hostname, window);

/** Puts the chosen theme on the page: "system" follows the operating system and keeps following it while the page is open. */
export function applyTheme(theme: Theme): () => void {
  const set = () => {
    const shown = theme === "system" ? (prefersDark().matches ? "dark" : "light") : theme;
    document.documentElement.dataset.theme = shown;
    window.ExamSystemBars?.setDark(shown === "dark");
  };
  set();
  if (theme !== "system") return () => {};
  const media = prefersDark();
  media.addEventListener("change", set);
  return () => media.removeEventListener("change", set);
}
export function storeSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEYS.settings, JSON.stringify(settings));
  } catch {
    // the choice holds until the app is closed
  }
}
export const deviceId = read(KEYS.device, () => uuidv7(Date.now()));

/** The remembered place: a folder id. Storage that cannot be read or written just means nothing is remembered. */
export function loadPlace(): string | undefined {
  try {
    return localStorage.getItem(KEYS.place) || undefined;
  } catch {
    return undefined;
  }
}
export function storePlace(id: string): void {
  try {
    localStorage.setItem(KEYS.place, id);
  } catch {
    // not remembered
  }
}
export function forgetPlace(): void {
  try {
    localStorage.removeItem(KEYS.place);
  } catch {
    // nothing to forget
  }
}

/** The setup remembered for a bank, as stored (it is fitted to the bank by `fitSetup`). Unreadable storage means nothing is remembered. */
export function loadSetup(bank: string): Setup | undefined {
  try {
    return setupOf(localStorage.getItem(KEYS.setup), bank);
  } catch {
    return undefined;
  }
}
export function rememberSetup(bank: string, setup: Setup): void {
  try {
    localStorage.setItem(KEYS.setup, storeSetup(localStorage.getItem(KEYS.setup), bank, setup));
  } catch {
    // not remembered
  }
}

/** When the progress was last saved to a file, if ever. */
export function lastBackup(): number | undefined {
  try {
    const raw = localStorage.getItem(KEYS.backup);
    const at = raw == null ? NaN : Number(raw);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}
export function markBackup(): void {
  try {
    localStorage.setItem(KEYS.backup, String(Date.now()));
  } catch {
    // the reminder just comes again
  }
}

/** The exam kept from the last run, if there is a sound one; a value that is not is removed. */
export function loadSavedExam(): SavedExam | undefined {
  const raw = readKey(KEYS.exam);
  const saved = parseSavedExam(raw);
  if (raw != null && !saved) clearSavedExam();
  return saved;
}
/** Keeps the exam in progress; its bank file is pinned in the content cache while it is here. Without storage the exam just does not survive a reload. */
export function saveExam(exam: SavedExam): void {
  try {
    localStorage.setItem(KEYS.exam, JSON.stringify(exam));
  } catch {
    // not kept
  }
}
export function clearSavedExam(): void {
  try {
    localStorage.removeItem(KEYS.exam);
  } catch {
    // nothing to clear
  }
}
