import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, Moon, Sun } from "lucide-react";
import { LOCALE_NAMES, THEMES, UI_LOCALES, clearAppData, forgetPlace, loadPlace, markBackup, storageUsed, type Theme } from "./platform.ts";
import { isProgressEvent } from "./lib.ts";
import { forgetHome } from "./home.ts";
import { useApp } from "./app.tsx";
import { Confirm, Segmented, Select, useBackClose } from "./ui.tsx";
import { DownloadCard } from "./downloads.tsx";
import { UpdateCard } from "./updates.tsx";

const FILE_KIND = "exam-progress/1";
/** The File System Access API is not in the DOM typings of every TypeScript version, so the part used here is declared. */
type SaveFilePicker = (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }> }>;

const ThemeIcon = ({ theme }: { theme: Theme }) => {
  const Icon = theme === "system" ? Monitor : theme === "light" ? Sun : Moon;
  return <Icon size={18} strokeWidth={1.5} aria-hidden />;
};

/**
 * Wipes the device and starts the app again from its first page: the log, the settings and the place live in memory too,
 * so a reload is the one way to be sure none of it is written back.
 */
function WipeData() {
  const { t, i18n } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [used, setUsed] = useState<number>();
  useEffect(() => void storageUsed().then(setUsed, () => {}), []);
  const wipe = async () => {
    try {
      await clearAppData();
    } catch {
      setAsking(false);
      setFailed(true);
      return;
    }
    history.replaceState(null, "", "#/");
    // The Android WebView restores part of the old scroll after a reload; the fresh first page should open at its top.
    scrollTo(0, 0);
    location.reload();
  };
  const megabytes = used == null ? undefined : new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(used / 1_000_000);
  return (
    <section className="card block">
      <h2>{t("settings.data")}</h2>
      <p className="hint">{t("settings.dataHint")}</p>
      {megabytes != null && <p className="meta">{t("settings.dataUsed", { size: megabytes })}</p>}
      <div className="actions">
        <button className="button danger" onClick={() => { setFailed(false); setAsking(true); }}>{t("settings.wipe")}</button>
      </div>
      {failed && <p className="hint warn" role="alert">{t("settings.wipeFailed")}</p>}
      {asking && <WipeConfirm onStay={() => setAsking(false)} onGo={wipe} />}
    </section>
  );
}

/** On Android the Back button closes the question instead of leaving the page under it. */
function WipeConfirm({ onStay, onGo }: { onStay(): void; onGo(): void }) {
  const { t } = useTranslation();
  useBackClose(onStay);
  return <Confirm title={t("settings.wipeTitle")} body={t("settings.wipeBody")} stay={t("settings.wipeStay")} go={t("settings.wipeGo")} danger onStay={onStay} onGo={onGo} />;
}

export function SettingsScreen() {
  const { t } = useTranslation();
  const { settings, update, events, append, index } = useApp();
  const [message, setMessage] = useState("");
  const [remembered, setRemembered] = useState(() => loadPlace() != null);
  const [cleared, setCleared] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  /**
   * The system's "save as" dialog where the WebView has one (Android's WebView ignores `<a download>` on a blob and saves nothing);
   * otherwise, or when the dialog cannot be opened, a plain download. Closing the dialog is not an error.
   */
  const save = async () => {
    setMessage("");
    const json = JSON.stringify({ kind: FILE_KIND, events });
    const name = `exam-progress-${new Date().toISOString().slice(0, 10)}.json`;
    const download = () => {
      const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([json], { type: "application/json" })), download: name });
      link.click();
      URL.revokeObjectURL(link.href);
      markBackup();
    };
    const picker = (window as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    if (!picker) return download();
    let target;
    try {
      target = await picker({ suggestedName: name, types: [{ description: "JSON", accept: { "application/json": [".json"] } }] });
    } catch (error) {
      return (error as { name?: string }).name === "AbortError" ? undefined : download();
    }
    try {
      const writable = await target.createWritable();
      await writable.write(json);
      await writable.close();
      markBackup();
      setMessage(t("settings.saved"));
    } catch {
      setMessage(t("settings.saveFailed"));
    }
  };
  const load = async (picked: File | undefined) => {
    if (!picked) return;
    try {
      const data = JSON.parse(await picked.text());
      if (data.kind !== FILE_KIND || !Array.isArray(data.events) || !data.events.every(isProgressEvent)) throw new Error("not a progress file");
      setMessage(t("settings.imported", { count: await append(data.events) }));
    } catch {
      setMessage(t("settings.importFailed"));
    }
    file.current!.value = "";
  };

  return (
    <div className="sheet">
      <h1>{t("settings.title")}</h1>
      <section className="card block">
        <Segmented<Theme> label={t("settings.theme")} value={settings.theme} onChange={(theme) => update({ theme })} options={THEMES.map((value) => ({
          value, title: t(`settings.theme${value[0]!.toUpperCase()}${value.slice(1)}`), icon: <ThemeIcon theme={value} />,
        }))} />
        <label className="field">
          <span>{t("settings.uiLanguage")}</span>
          <Select value={settings.ui} onChange={(e) => update({ ui: e.target.value })}>
            {UI_LOCALES.map((l) => <option key={l} value={l}>{LOCALE_NAMES[l]}</option>)}
          </Select>
        </label>
        <label className="field">
          <span>{t("settings.contentLanguage")}</span>
          <Select value={settings.content} onChange={(e) => update({ content: e.target.value })}>
            <option value="auto">{t("settings.sameAsUi")}</option>
            {UI_LOCALES.map((l) => <option key={l} value={l}>{LOCALE_NAMES[l]}</option>)}
          </Select>
          <small>{t("settings.contentHint")}</small>
        </label>
        <label className="field">
          <span>{t("settings.unsupported")}</span>
          <Select value={settings.unsupported} onChange={(e) => update({ unsupported: e.target.value as "self_check" | "skip" })}>
            <option value="self_check">{t("settings.asSelfCheck")}</option>
            <option value="skip">{t("settings.skip")}</option>
          </Select>
        </label>
      </section>

      <section className="card block">
        <h2>{t("settings.place")}</h2>
        <div className="actions">
          <button className="button" disabled={!remembered} onClick={() => { forgetPlace(); forgetHome(); setRemembered(false); setCleared(true); }}>{t("settings.placeReset")}</button>
        </div>
        {cleared && <p className="hint" role="status">{t("settings.placeDone")}</p>}
      </section>

      <section className="card block">
        <h2>{t("settings.progress")}</h2>
        <p className="meta">{t("settings.events")}: {events.length}</p>
        <div className="actions">
          <button className="button" onClick={save}>{t("settings.export")}</button>
          <button className="button" onClick={() => file.current!.click()}>{t("settings.import")}</button>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => load(e.target.files?.[0])} />
        </div>
        {message && <p className="hint" role="status">{message}</p>}
        {index && <p className="meta">{t("settings.content")}: {index.version}</p>}
      </section>

      <UpdateCard />
      <DownloadCard />
      <WipeData />
    </div>
  );
}
