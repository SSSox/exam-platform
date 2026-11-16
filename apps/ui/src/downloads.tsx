import { useTranslation } from "react-i18next";
import { Monitor, Smartphone } from "lucide-react";
import { appLinks, type AppLink } from "./lib.ts";
import { inShell } from "./platform.ts";

/** The links of this page: none inside the apps themselves or when the build sets no address. */
const links = (): AppLink[] => appLinks(__DOWNLOADS__, inShell(), navigator.userAgent);

const OsIcon = ({ os }: { os: AppLink["os"] }) => {
  const Icon = os === "windows" ? Monitor : Smartphone;
  return <Icon size={18} strokeWidth={1.5} aria-hidden />;
};

/** Settings card of the web page: the apps open without the internet, and progress moves to them as a file. */
export function DownloadCard() {
  const { t } = useTranslation();
  const shown = links();
  if (!shown.length) return null;
  return (
    <section className="card block">
      <h2>{t("download.title")}</h2>
      <p className="hint">{t("download.hint")}</p>
      <div className="actions">
        {shown.map((l) => (
          <a key={l.os} className="button" href={l.href}><OsIcon os={l.os} />{t(`download.${l.os}`)}</a>
        ))}
      </div>
    </section>
  );
}

/** A quiet line under the subjects, so the apps are found without opening the settings. */
export function DownloadLine() {
  const { t } = useTranslation();
  const shown = links();
  if (!shown.length) return null;
  return (
    <p className="get-app">
      <span>{t("download.line")}</span>
      <span className="get-app-links">
        {shown.map((l) => (
          <a key={l.os} className="button quiet" href={l.href} aria-label={t(`download.${l.os}`)}><OsIcon os={l.os} />{l.os === "windows" ? "Windows" : "Android"}</a>
        ))}
      </span>
    </p>
  );
}
