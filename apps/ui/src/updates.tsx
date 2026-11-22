import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Download, RefreshCw } from "lucide-react";
import { applySiteUpdate, useSiteUpdate } from "./pwa.ts";
import { useApp } from "./app.tsx";
import { useBackClose } from "./ui.tsx";
import { KEYS, isCheckDone, isUpdateDue, readUpdateState, updateOffer, type UpdateState } from "./lib.ts";

/**
 * Updates of the Windows and Android apps. The shell finds, downloads and verifies the new version; the page only asks and shows.
 * The web page has nothing to update and keeps the state `off`, so nothing here appears there.
 */

/** What the Android shell offers (`AppUpdates.kt`): no address or file ever goes from the page to the shell. */
type AndroidUpdates = { state(): string; check(): void; install(): void; allowInstalls(): void };

declare global {
  interface Window {
    ExamUpdates?: AndroidUpdates;
  }
}

type Shell = { check(): void; install(): void; allowInstalls?(): void };

let state: UpdateState = { phase: "off" };
let shell: Shell | undefined;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  if (isCheckDone(next.phase)) {
    try {
      localStorage.setItem(KEYS.updateCheck, String(Date.now()));
    } catch {
      // Storage may be full or blocked; the check then simply runs again next launch.
    }
  }
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useUpdate = (): UpdateState => useSyncExternalStore(subscribe, () => state);

/**
 * A new version is on its way in: the Windows installer will close the app, the Android one opens over it. No test starts meanwhile,
 * so none is cut off; the dialog and the automatic install themselves never begin during one.
 */
export const useUpdating = (): boolean => {
  const { phase } = useUpdate();
  return phase === "downloading" || phase === "installing";
};

/** The version the learner asked not to be shown again ("Don't show again"); a newer one is shown as usual. */
let skipped: string | undefined = (() => {
  try {
    return localStorage.getItem(KEYS.updateSkip) ?? undefined;
  } catch {
    return undefined;
  }
})();
const useSkipped = () => useSyncExternalStore(subscribe, () => skipped);

function skipVersion(version: string) {
  skipped = version;
  try {
    localStorage.setItem(KEYS.updateSkip, version);
  } catch {
    // Not remembered: the version is offered again at the next launch.
  }
  listeners.forEach((listener) => listener());
}

/** The version this run already installed by itself: kept outside React, so a remount or a second effect run does not start it twice. */
let autoTried: string | undefined;

export const checkForUpdate = () => shell?.check();
export const installUpdate = () => shell?.install();
export const allowInstalls = () => shell?.allowInstalls?.();

function android(bridge: AndroidUpdates): Shell {
  addEventListener("exam-update", (event) => set(readUpdateState((event as CustomEvent).detail)));
  set(readUpdateState(bridge.state()));
  return { check: () => bridge.check(), install: () => bridge.install(), allowInstalls: () => bridge.allowInstalls() };
}

/** The answers of `update_check` and the events of `update_install` in `src-tauri/src/update.rs`. */
type Checked = { status: "off" | "latest"; current: string } | { status: "available"; current: string; version: string };
type Progress = { event: "started"; total: number | null } | { event: "received"; received: number; total: number | null } | { event: "installing" };

const REASONS = ["signature", "network", "manifest", "error"];

/** The desktop shell; the Tauri API is loaded only here, so the web page never downloads it. */
function desktop(): Shell {
  let busy = false;
  const api = () => import("@tauri-apps/api/core");
  // A build without the updater's public key could not verify an installer, so it shows nothing and never checks.
  (async () => {
    if (!(await (await api()).invoke<boolean>("update_enabled"))) return;
    const current = await (await import("@tauri-apps/api/app")).getVersion();
    if (state.phase === "off") set({ phase: "idle", current });
  })().catch(() => {});
  const failed = (error: unknown) => {
    // `update.rs` answers with a reason code (`signature`, `network`, `manifest`, `error`); anything else is a failed IPC call.
    const reason = typeof error === "string" && REASONS.includes(error) ? error : "error";
    set({ phase: "failed", current: state.current, version: state.version, reason });
  };
  return {
    async check() {
      if (busy || state.phase === "off") return;
      busy = true;
      set({ phase: "checking", current: state.current });
      try {
        const { invoke } = await api();
        const found = await invoke<Checked>("update_check");
        set(found.status === "available" ? { phase: "available", current: found.current, version: found.version } : { phase: found.status === "off" ? "off" : "latest", current: found.current });
      } catch (error) {
        failed(error);
      } finally {
        busy = false;
      }
    },
    async install() {
      if (busy || state.phase !== "available") return;
      busy = true;
      const { version, current } = state;
      set({ phase: "downloading", current, version, received: 0 });
      try {
        const { Channel, invoke } = await api();
        const onEvent = new Channel<Progress>();
        onEvent.onmessage = (message) => {
          if (message.event === "installing") set({ phase: "installing", current, version });
          else set({ phase: "downloading", current, version, received: message.event === "received" ? message.received : 0, size: message.total ?? undefined });
        };
        // On success the installer closes the app, so this call does not come back.
        await invoke("update_install", { onEvent });
      } catch (error) {
        failed(error);
      } finally {
        busy = false;
      }
    },
  };
}

/** Picks the shell once at start and, if the daily check is due, runs it a few seconds after the first screen has settled. */
export function startUpdates() {
  if (shell) return;
  if (window.ExamUpdates) shell = android(window.ExamUpdates);
  else if ("__TAURI_INTERNALS__" in window) shell = desktop();
  if (!shell) return;
  const due = () => {
    let last: number | undefined;
    try {
      last = Number(localStorage.getItem(KEYS.updateCheck) ?? undefined);
    } catch {
      last = undefined;
    }
    return isUpdateDue(last, Date.now());
  };
  let tried = 0;
  // The automatic check: when the day has passed and nothing is on offer, and at most once an hour while it keeps failing (offline).
  const auto = () => {
    if (!["idle", "latest", "failed"].includes(state.phase) || !due() || Date.now() - tried < 60 * 60 * 1000) return;
    tried = Date.now();
    checkForUpdate();
  };
  setTimeout(auto, 4000);
  // A phone keeps the app alive in the background for days, so coming back to it counts as a launch.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") auto();
  });
}

const megabytes = (bytes: number, locale: string) => new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1_000_000);

/** The status sentence and the one action of the current state; shared by the settings card and the line under the subjects. */
function useStatus() {
  const { t, i18n } = useTranslation();
  const update = useUpdate();
  const mb = (bytes: number) => megabytes(bytes, i18n.language);
  const version = update.version ?? "";
  const status = (() => {
    switch (update.phase) {
      case "latest": return t("update.latest");
      case "available": return update.size ? t("update.availableSize", { version, size: mb(update.size) }) : t("update.available", { version });
      case "downloading": return update.size ? t("update.downloading", { received: mb(update.received ?? 0), size: mb(update.size) }) : t("update.downloadingStart");
      case "installing": return t("update.installing");
      case "ready": return t("update.ready", { version });
      case "permission": return t("update.permission");
      case "failed": return update.reason === "network" ? t("update.failedNetwork") : t("update.failedCheck");
      default: return "";
    }
  })();
  const action = (() => {
    switch (update.phase) {
      case "available": return { label: t("update.install"), run: installUpdate, primary: true };
      case "ready": return { label: t("update.open"), run: installUpdate, primary: true };
      case "permission": return { label: t("update.allow"), run: allowInstalls, primary: true };
      case "idle": case "latest": return { label: t("update.check"), run: checkForUpdate, primary: false };
      case "checking": return { label: t("update.checking"), run: undefined, primary: false };
      case "failed": return { label: t("update.retry"), run: checkForUpdate, primary: false };
      default: return undefined;
    }
  })();
  return { update, status, action };
}

function Meter({ update }: { update: UpdateState }) {
  if (update.phase !== "downloading" || !update.size) return null;
  return <progress className="meter-bar" max={update.size} value={update.received ?? 0} aria-hidden />;
}

/** Settings card inside the apps: the installed version, the state of the update, its one button and whether updates install by themselves. */
export function UpdateCard() {
  const { t } = useTranslation();
  const { settings, update: change } = useApp();
  const { update, status, action } = useStatus();
  if (update.phase === "off") return null;
  return (
    <section className="card block">
      <h2>{t("update.title")}</h2>
      {update.current && <p className="meta">{t("update.current", { version: update.current })}</p>}
      {status && <p className={update.phase === "failed" ? "hint warn" : "update-status"} role="status">{status}</p>}
      <Meter update={update} />
      {action && (
        <div className="actions">
          <button className={action.primary ? "button primary" : "button"} disabled={!action.run} onClick={action.run}>
            {action.primary && <Download size={18} strokeWidth={1.5} aria-hidden />}{action.label}
          </button>
        </div>
      )}
      <label className="check-line">
        <input type="checkbox" checked={settings.autoUpdate} onChange={(e) => change({ autoUpdate: e.target.checked })} />
        <span>{t("update.auto")}<small className="hint">{t(window.ExamUpdates ? "update.autoHintAndroid" : "update.autoHint")}</small></span>
      </label>
    </section>
  );
}

/** A quiet line under the subjects once a new version is found, so it is seen without opening the settings; not for a version skipped for good. */
export function UpdateLine() {
  const { status, update, action } = useStatus();
  const skip = useSkipped();
  if (!["available", "ready", "permission"].includes(update.phase) || (update.phase !== "permission" && update.version === skip)) return null;
  return (
    <p className="get-app" role="status">
      <span>{status}</span>
      {action?.primary && (
        <span className="get-app-links">
          <button className="button quiet" onClick={action.run}><Download size={18} strokeWidth={1.5} aria-hidden />{action.label}</button>
        </span>
      )}
    </p>
  );
}

/**
 * The download and the install on any screen but the settings (its card shows them): on Windows the installer closes the app, and it should
 * not come as a surprise.
 */
export function UpdateNotice({ top }: { top: boolean }) {
  const { status, update } = useStatus();
  if (update.phase !== "downloading" && update.phase !== "installing") return null;
  return <p className={top ? "notice notice-top" : "notice"} role="status">{status}</p>;
}

/**
 * A found version, when nothing on screen may be interrupted (`paused` holds it during a session and on the settings screen): installed by
 * itself with the "update automatically" setting, otherwise offered in a dialog.
 */
export function UpdatePrompt({ auto, paused }: { auto: boolean; paused: boolean }) {
  const update = useUpdate();
  const skip = useSkipped();
  const [answered, setAnswered] = useState<string>();
  const offer = paused ? undefined : updateOffer(update, { auto, skipped: skip, answered, tried: autoTried });
  const version = update.version;
  useEffect(() => {
    if (offer !== "install" || !version || autoTried === version) return;
    autoTried = version;
    installUpdate();
  }, [offer, version]);
  if (offer !== "ask" || !version) return null;
  return (
    <UpdateDialog
      key={version} version={version} size={update.size}
      onLater={(never) => { if (never) skipVersion(version); setAnswered(version); }}
      // Answered either way: on Android the system installer opens over the page, and a cancelled one leaves the line under the subjects.
      onInstall={() => { setAnswered(version); installUpdate(); }}
    />
  );
}

/** "Later" closes it for this run, and with "Don't show again" ticked, for good for this version; Esc and the Android Back button count as "Later". */
function UpdateDialog({ version, size, onLater, onInstall }: { version: string; size?: number; onLater(never: boolean): void; onInstall(): void }) {
  const { t, i18n } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [never, setNever] = useState(false);
  const later = () => onLater(never);
  useBackClose(later);
  useEffect(() => {
    if (!dialog.current!.open) dialog.current!.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="confirm" aria-labelledby={id} onCancel={(e) => { e.preventDefault(); later(); }}>
      <h2 id={id}>{size ? t("update.availableSize", { version, size: megabytes(size, i18n.language) }) : t("update.available", { version })}</h2>
      <p>{t("update.promptBody")}</p>
      <label className="check-line">
        <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
        <span>{t("update.dontShow")}</span>
      </label>
      <div className="actions">
        <button type="button" className="button" onClick={later}>{t("update.later")}</button>
        <button type="button" className="button primary" autoFocus onClick={onInstall}><Download size={18} strokeWidth={1.5} aria-hidden />{t("update.open")}</button>
      </div>
    </dialog>
  );
}

/** A quiet line for the web page: a new version of the site is installed and waits. Nothing happens until the button is pressed. */
export function SiteUpdateLine() {
  const { t } = useTranslation();
  if (!useSiteUpdate()) return null;
  return (
    <p className="get-app" role="status">
      <span>{t("site.updateReady")}</span>
      <span className="get-app-links">
        <button className="button quiet" onClick={applySiteUpdate}><RefreshCw size={18} strokeWidth={1.5} aria-hidden />{t("site.updateApply")}</button>
      </span>
    </p>
  );
}
