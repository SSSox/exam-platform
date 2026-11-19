import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { descend, entriesOf, placeOf, project, restore, rootEntries, walk, type Entry, type NodeManifest, type NodeRef, type Target } from "@exam/core";
import { client, forgetPlace, inShell, lastBackup, loadPlace, storePlace } from "./platform.ts";
import { Status, useApp, useAsync } from "./app.tsx";
import { Line } from "./line.tsx";
import { forgetHome, rememberHome } from "./home.ts";
import { Stops, stopsOf } from "./stops.tsx";
import { DownloadLine } from "./downloads.tsx";
import { UpdateLine } from "./updates.tsx";
import { STATIONS, backupDue, bankProgress, changeTarget, dueCount, homeOf, lineOf, namesLine, pathNames, sharedKind, shortTitle, stationsOf, type Station } from "./lib.ts";

export const load = (ref: NodeRef) => client.node(ref.hash);

/** Where a navigation target lives in the address bar. */
export const hashOf = (target: Target) => (target.type === "bank" ? `#/bank?node=${target.node}&id=${target.id}` : `#/n/${target.id}`);

/** Opens the remembered place, or follows single folders from the top down to the first choice. One replace, whatever the depth. */
export function HomeScreen() {
  const { index } = useApp();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    (async () => {
      const roots = index!.roots;
      const saved = loadPlace();
      const place = await restore(roots, saved, load);
      if (saved && !place) {
        forgetPlace();
        forgetHome();
      }
      const { target } = await descend(place ? entriesOf(place) : rootEntries(roots), place?.id ?? "", load);
      if (!live) return;
      rememberHome(hashOf(target));
      location.replace(hashOf(target));
    })().catch((e) => live && setError(e));
    return () => void (live = false);
  }, [index, tick]);

  return <Status error={error} reload={() => { setError(undefined); setTick((n) => n + 1); }} />;
}

export function NodeScreen({ path }: { path: string }) {
  const { t } = useTranslation();
  const { index, text, settings } = useApp();
  const view = useAsync(async () => {
    const roots = index!.roots;
    const chain = await walk(roots, path, load);
    if (path && chain.at(-1)?.id !== path) throw new Error(`no such section: ${path}`);
    const entries = path ? entriesOf(chain.at(-1)!) : rootEntries(roots);
    // A folder with one entry is not a page: go on to the first real choice. The root list (empty id) always stays.
    const away = path && entries.length === 1 ? hashOf((await descend(entries, path, load)).target) : undefined;
    return { chain, entries, away };
  }, [path, index?.version]);

  const { data } = view;
  useEffect(() => {
    if (!data) return;
    if (data.away) {
      location.replace(data.away);
      return;
    }
    const place = placeOf(data.chain, index!.kinds);
    if (!place) return;
    storePlace(place);
    rememberHome(hashOf(homeOf(data.chain, place)));
  }, [data, index]);

  if (!data || data.away) return <Status error={view.error} reload={view.reload} />;

  const { chain, entries } = data;
  const node = chain.at(-1);
  const stations = stationsOf(index!.roots, chain);
  const kind = sharedKind(entries);
  const kindName = kind ? text(index!.kinds[kind]?.title ?? kind).toLocaleLowerCase(settings.ui) : "";
  const heading = kind ? t("catalog.choose", { kind: kindName }) : node ? text(node.title) : t("catalog.title");
  const isPlace = node != null && placeOf(chain, index!.kinds) === node.id;

  return (
    <div className="catalog">
      <Where stations={stations} heading={heading} own={!kind && node != null} />
      <div className="list">
        {isPlace && <h2 className="sec">{t("catalog.title")}</h2>}
        {entries.length ? <Rows entries={entries} node={node} /> : <p className="muted">{t("state.empty")}</p>}
        <UpdateLine />
        <BackupLine />
        <DownloadLine />
      </div>
    </div>
  );
}

/** The choices made so far: a short chain of stops, the heading, and the names of the folders on the way. */
function Where({ stations, heading, own }: { stations: Station[]; heading: string; own: boolean }) {
  const { t } = useTranslation();
  const { text } = useApp();
  const names = pathNames(stations.map((s) => text(s.node.title)), own);
  const change = changeTarget(stations);

  return (
    <section className="card where" aria-labelledby="page-title">
      <Stops stops={stopsOf(stations, (node) => text(node.title))} />
      <div className="where-body">
        <div>
          <h1 id="page-title">{heading}</h1>
          {names && <p className="names">{names}</p>}
        </div>
        {change !== undefined && <a className="pill" href={`#/n/${change}`}>{t("catalog.change")}</a>}
      </div>
    </section>
  );
}

/** A quiet reminder to save the progress to a file, on the web page only: the browser can clear what it keeps. */
function BackupLine() {
  const { t } = useTranslation();
  const { events } = useApp();
  if (!backupDue({ shell: inShell(), events: events.length, lastBackup: lastBackup(), now: Date.now() })) return null;
  return (
    <p className="get-app">
      <span>{t("backup.line")}</span>
      <span className="get-app-links"><a className="button quiet" href="#/settings">{t("backup.save")}</a></span>
    </p>
  );
}

const MAX_PEEK = 12;

function Rows({ entries, node }: { entries: Entry[]; node?: NodeManifest }) {
  const { t } = useTranslation();
  const { text, events } = useApp();
  const group = node ? text(node.title) : "";

  const progress = useMemo(() => {
    const now = Date.now();
    // One projection per bank serves both the mastery line and the count due for review.
    return new Map(entries.flatMap((e) => {
      if (e.type !== "bank") return [];
      const states = project(events, e.ref.id);
      return [[e.ref.id, { ...bankProgress(states, e.ref.questions, now, e.ref.retired), due: dueCount(states, now, e.ref.retired) }] as const];
    }));
  }, [entries, events]);

  // What a folder holds, as a hint under its name. Skipped for long lists: each folder is one more request.
  const peek = useAsync(async (): Promise<Record<string, NodeManifest>> => {
    const folders = entries.flatMap((e) => (e.type === "node" ? [e.ref] : []));
    if (!folders.length || folders.length > MAX_PEEK) return {};
    try {
      return Object.fromEntries((await Promise.all(folders.map(load))).map((m) => [m.id, m]));
    } catch {
      return {};
    }
  }, [entries]);

  const holds = (m: NodeManifest) =>
    namesLine(entriesOf(m).map((e) => (e.type === "node" ? text(e.ref.title) : shortTitle(text(e.ref.subject, e.ref.language), text(m.title)))));

  return (
    <ul className="rows">
      {entries.map((e, i) => {
        const at = Math.min(i, 8);
        const style = { "--i": at } as CSSProperties;
        if (e.type === "node") {
          const inside = peek.data?.[e.ref.id];
          return (
            <li key={e.ref.id}>
              <a className="card row" href={`#/n/${e.ref.id}`} data-l={lineOf(i)} style={style}>
                <span className="badge" aria-hidden>{i + 1}</span>
                <span className="row-main">
                  <strong className="row-title">{text(e.ref.title)}</strong>
                  <span className="row-sub">{inside ? holds(inside) : t("catalog.banks", { count: e.ref.banks })}</span>
                </span>
                <ChevronRight size={18} strokeWidth={1.5} aria-hidden />
              </a>
            </li>
          );
        }
        const p = progress.get(e.ref.id)!;
        return (
          <li key={e.ref.id}>
            <a className={p.due > 0 ? "card row bank has-due" : "card row bank"} href={`#/bank?node=${node!.id}&id=${e.ref.id}`} data-l={lineOf(i)} style={style}>
              <span className="badge" aria-hidden>{i + 1}</span>
              <strong className="row-title">{shortTitle(text(e.ref.subject, e.ref.language), group)}</strong>
              <span className="row-n">
                <span>{t("catalog.progress", { done: p.done, total: p.total })}</span>
                {p.due > 0 && <span className="row-due">{t("catalog.due", { n: p.due })}</span>}
              </span>
              <Line count={STATIONS} lit={p.lit} delay={100 + at * 40} />
              <ChevronRight size={18} strokeWidth={1.5} aria-hidden />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
