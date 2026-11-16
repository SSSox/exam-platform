import { Component, type ErrorInfo, type ReactNode } from "react";
import ru from "./locales/ru.json";
import kk from "./locales/kk.json";
import en from "./locales/en.json";
import { KEYS } from "./lib.ts";

const TEXTS = { ru: ru.crash, kk: kk.crash, en: en.crash };

/** The words for the screen below, in the interface language the learner chose, read straight from storage: nothing the app sets up at start has to have worked. */
function words(): (typeof TEXTS)["ru"] {
  let wanted = "";
  try {
    wanted = JSON.parse(localStorage.getItem(KEYS.settings) ?? "{}").ui ?? "";
  } catch {
    // unreadable storage: the language of the browser
  }
  const lang = [wanted, navigator.language.slice(0, 2).toLowerCase()].find((l): l is keyof typeof TEXTS => l in TEXTS);
  return TEXTS[lang ?? "ru"];
}

/** Starts over: the unfinished exam is dropped (reloading would bring it back, and with it the error) and the page opens without an address inside the app. */
function startOver(): void {
  try {
    localStorage.removeItem(KEYS.exam);
  } catch {
    // nothing kept, nothing to drop
  }
  location.replace(location.pathname + location.search);
}

/** What takes the place of the app when drawing it throws. Built from plain elements and the page's own classes, so it needs no context, no i18n and no hook. */
function Crash() {
  const t = words();
  return (
    <main className="main main-session">
      <div className="screen">
        <div className="sheet" role="alert">
          <h1>{t.title}</h1>
          <p>{t.body}</p>
          <p className="hint">{t.resetHint}</p>
          <footer className="dock">
            <button type="button" className="button" onClick={startOver}>{t.reset}</button>
            <button type="button" className="button primary" autoFocus onClick={() => location.reload()}>{t.reload}</button>
          </footer>
        </div>
      </div>
    </main>
  );
}

/** Catches what is thrown while drawing; errors in handlers and promises are not its business. */
export class CrashBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    return this.state.failed ? <Crash /> : this.props.children;
  }
}
