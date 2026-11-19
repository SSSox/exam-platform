import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import i18next from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { BookOpen, Settings as SettingsIcon } from "lucide-react";
import { mergeLogs, type BankBundle, type ContentIndex, type ProgressEvent, type Session } from "@exam/core";
import type { Localized } from "@exam/schema";
import { pick } from "@exam/schema/pick";
import { applyTheme, clearSavedExam, client, loadEvents, loadSavedExam, loadSettings, saveEvents, storeSettings, LOCALE_NAMES, UI_LOCALES, type Settings } from "./platform.ts";
import ru from "./locales/ru.json";
import kk from "./locales/kk.json";
import en from "./locales/en.json";
import { HomeScreen, NodeScreen } from "./catalog.tsx";
import { BankScreen } from "./bank.tsx";
import { SessionScreen } from "./session.tsx";
import { SettingsScreen } from "./settings.tsx";
import { Confirm, Select } from "./ui.tsx";
import { useHome } from "./home.ts";
import { takeBack } from "./back.ts";
import { fitsBundle, holdExam, type Draft } from "./lib.ts";

const initial = loadSettings();
/** Sets the theme before the first paint; the effect in Root takes over and stops this one's system listener. */
let stopEarlyTheme: (() => void) | undefined = applyTheme(initial.theme);
void i18next.use(initReactI18next).init({
  resources: { ru: { translation: ru }, kk: { translation: kk }, en: { translation: en } },
  lng: initial.ui,
  fallbackLng: { kk: ["ru", "en"], default: ["en"] },
  interpolation: { escapeValue: false },
});

/** `line` is the colour of the subject's line, so the session wears the colour the student chose. */
/**
 * `hash` is the bank file in the content cache: a running exam is kept in local storage without the bank itself (see `SavedExam`) and loads it again by this.
 * `drafts` are the unsent answers an exam restored from storage starts with.
 */
export interface Running { session: Session; bundle: BankBundle; back: string; line?: number; hash: string; drafts?: Record<number, Draft> }

interface App {
  settings: Settings;
  update(patch: Partial<Settings>): void;
  index?: ContentIndex;
  offline: boolean;
  events: ProgressEvent[];
  append(events: ProgressEvent[]): Promise<number>;
  /** Adds events like `append`, and says whether the device stored them. */
  commit(events: ProgressEvent[]): Promise<boolean>;
  /** Localized content text plus whether it had to fall back to another language. */
  text(value: Localized | undefined, bankLanguage?: string): string;
  fellBack(value: Localized, bankLanguage: string): boolean;
  running?: Running;
  run(running: Running | undefined): void;
}

const Context = createContext<App>(null!);
export const useApp = () => useContext(Context);

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): { data?: T; error?: unknown; reload(): void } {
  const [state, setState] = useState<{ data?: T; error?: unknown }>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState({});
    load().then((data) => live && setState({ data }), (error) => live && setState({ error }));
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}

export function Status({ error, reload }: { error?: unknown; reload?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="status" role="status">
      <p>{error ? t("state.error") : t("state.loading")}</p>
      {error != null && reload && <button className="button" onClick={reload}>{t("state.retry")}</button>}
    </div>
  );
}

const useRoute = () => {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  return { path, query: new URLSearchParams(query) };
};

export function Root() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(initial);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [saveFailed, setSaveFailed] = useState(false);
  const [running, setRunning] = useState<Running>();
  const [restoreFailed, setRestoreFailed] = useState(false);
  const content = useAsync(() => client.index(), []);
  // Starting anything but an exam drops the kept one; an exam is kept (and ended) by the session screen.
  const run = useCallback((next: Running | undefined) => {
    if (next && next.session.config.kind !== "exam") clearSavedExam();
    setRunning(next);
  }, []);
  const route = useRoute();
  const home = useHome();
  const latest = useRef({ settings, events });
  latest.current = { settings, events };

  // An exam is written to the log when it ends, so while it holds answers every way out of it is held (see holdExam):
  // the exam stays on screen under the question "leave?", and Back pressed again, down to the first page of the history, cannot close the app on it.
  // An exam restored at launch is held even before its first answer: the address was set without a touch, so on Android Back would skip it
  // and close the app with the exam still kept, to open it again at every launch.
  const unsaved = running != null && running.session.config.kind === "exam" && running.session.finishedAt == null
    && (running.drafts != null || running.session.items.some((item) => item.graded));
  const [heading, setHeading] = useState<string>();
  const held = unsaved && route.path !== "session";
  useLayoutEffect(() => {
    // The address bar, not the route state, which trails it by a hashchange: a restored exam sets the address first.
    const next = holdExam(unsaved, location.hash.replace(/^#\/?/, "").split("?")[0]!, heading, location.hash);
    setHeading(next.heading);
    if (next.stay) location.hash = "#/session";
  }, [unsaved, route.path, route.query.toString()]);

  // In the Android shell Back never reaches the history during such an exam: it asks "leave?", and pressed again with the question open it means "keep going".
  const back = running?.back;
  useEffect(() => (unsaved ? takeBack(() => setHeading((to) => (to == null ? back : undefined))) : undefined), [unsaved, back]);

  // An exam that was open when the app closed or the page reloaded comes back as it was left: the clock kept running, so one that has run out ends at once.
  useEffect(() => {
    const saved = loadSavedExam();
    if (!saved) return;
    // It had ended, and whether the log got its answers is not known: they are written again (the same events, so nothing doubles), the exam is not reopened.
    if (saved.pending) {
      void commit(saved.pending).then((stored) => stored && loadSavedExam()?.session.id === saved.session.id && clearSavedExam());
      return;
    }
    let live = true;
    client.bank(saved.hash).then((bundle) => {
      if (!fitsBundle(saved.session, bundle)) throw new Error("the bank has changed");
      // Something else was started while the bank was loading: the kept exam was dropped then, and it stays dropped.
      if (!live || loadSavedExam()?.session.id !== saved.session.id) return;
      location.hash = "#/session";
      setRunning((now) => now ?? { session: saved.session, bundle, back: saved.back, line: saved.line, hash: saved.hash, drafts: saved.drafts });
    }).catch(() => {
      if (!live || loadSavedExam()?.session.id !== saved.session.id) return;
      clearSavedExam();
      setRestoreFailed(true);
    });
    return () => void (live = false);
  }, []);
  useEffect(() => {
    if (!restoreFailed) return;
    const timer = setTimeout(() => setRestoreFailed(false), 8000);
    return () => clearTimeout(timer);
  }, [restoreFailed]);

  // Answers given before the stored log is read are kept: the two lists are merged, not swapped.
  useEffect(() => {
    loadEvents().then((stored) => {
      const merged = mergeLogs(latest.current.events, stored);
      latest.current.events = merged;
      setEvents(merged);
    }, () => setSaveFailed(true));
  }, []);
  // A new screen starts at its top, not where the previous one was scrolled to.
  const path = held ? "session" : route.path;
  const screenKey = held ? "session" : route.path + route.query.toString();
  useLayoutEffect(() => {
    scrollTo(0, 0);
  }, [screenKey]);
  useEffect(() => {
    stopEarlyTheme?.();
    stopEarlyTheme = undefined;
    return applyTheme(settings.theme);
  }, [settings.theme]);
  useEffect(() => {
    document.documentElement.lang = settings.ui;
    document.title = t("app");
  }, [settings.ui, t]);

  const update = useCallback((patch: Partial<Settings>) => {
    const next = { ...latest.current.settings, ...patch };
    storeSettings(next);
    if (patch.ui) void i18next.changeLanguage(patch.ui);
    setSettings(next);
  }, []);

  /**
   * Adds events to the log; returns how many were new (an imported file may repeat known ones).
   * The screen takes them at once; when the device cannot store them, the learner is told and the answers stay until the app closes.
   */
  const put = useCallback(async (added: ProgressEvent[]) => {
    const before = latest.current.events;
    const merged = mergeLogs(before, added);
    latest.current.events = merged;
    setEvents(merged);
    let saved = true;
    try {
      await saveEvents(added);
    } catch {
      saved = false;
      setSaveFailed(true);
    }
    return { count: merged.length - before.length, saved };
  }, []);
  const append = useCallback(async (added: ProgressEvent[]) => (await put(added)).count, [put]);
  const commit = useCallback(async (added: ProgressEvent[]) => (await put(added)).saved, [put]);

  const app = useMemo<App>(() => {
    const wanted = settings.content === "auto" ? settings.ui : settings.content;
    const chain = [wanted, settings.ui];
    return {
      settings, update, index: content.data?.index, offline: content.data?.offline ?? false, events, append, commit, running, run,
      text: (value, language = "ru") => (value == null ? "" : pick(value, chain, language).text),
      fellBack: (value, language) => pick(value, chain, language).locale !== wanted,
    };
  }, [settings, update, content.data, events, append, commit, running, run]);

  let screen: ReactNode;
  if (path === "session" && running) screen = <SessionScreen key={running.session.id} />;
  else if (path === "settings") screen = <SettingsScreen />;
  else if (!content.data) screen = <Status error={content.error} reload={content.reload} />;
  else if (path === "bank") screen = <BankScreen node={route.query.get("node") ?? ""} bank={route.query.get("id") ?? ""} />;
  else if (path.startsWith("n/")) screen = <NodeScreen path={path.slice(2)} />;
  else screen = <HomeScreen />;

  const inSession = path === "session" && running;
  return (
    <Context.Provider value={app}>
      {!inSession && (
        <header className="topbar">
          <a className="brand" href={home}>
            <svg className="mark" viewBox="0 0 30 30" width="30" height="30" aria-hidden>
              <rect width="30" height="30" rx="10" fill="currentColor" />
              <path d="M7 20.5l5-6 3.5 3.5L23 9.5" fill="none" stroke="var(--on-accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="7" cy="20.5" r="2" fill="var(--on-accent)" />
              <circle cx="23" cy="9.5" r="2" fill="var(--on-accent)" />
            </svg>
            <span>{t("app")}</span>
          </a>
          <nav aria-label={t("app")}>
            <a href={home} aria-current={route.path !== "settings" ? "page" : undefined}><BookOpen size={18} strokeWidth={1.5} aria-hidden /><span>{t("nav.catalog")}</span></a>
            <a href="#/settings" aria-current={route.path === "settings" ? "page" : undefined}><SettingsIcon size={18} strokeWidth={1.5} aria-hidden /><span>{t("nav.settings")}</span></a>
            <Select className="lang" aria-label={t("settings.uiLanguage")} value={settings.ui} onChange={(e) => update({ ui: e.target.value })}>
              {UI_LOCALES.map((l) => <option key={l} value={l} title={LOCALE_NAMES[l]}>{l.toUpperCase()}</option>)}
            </Select>
          </nav>
        </header>
      )}
      {app.offline && !inSession && <p className="notice">{t("state.offline")}</p>}
      {restoreFailed && <p className={inSession ? "notice notice-top" : "notice"} role="status">{t("state.restoreFailed")}</p>}
      {saveFailed && <p className={inSession ? "notice notice-top" : "notice"} role="alert">{t("state.saveFailed")}</p>}
      {unsaved && heading != null && (
        <Confirm
          title={t("session.leaveTitle")} body={t("session.leaveBody")} stay={t("session.keepGoing")} go={t("session.leave")}
          onStay={() => setHeading(undefined)} onGo={() => { clearSavedExam(); run(undefined); setHeading(undefined); location.hash = heading; }}
        />
      )}
      <main className={inSession ? "main main-session" : "main"}><div className="screen" key={screenKey}>{screen}</div></main>
    </Context.Provider>
  );
}
