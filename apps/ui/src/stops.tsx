import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { NodeManifest } from "@exam/core";
import type { Station } from "./lib.ts";

/** One stop on the way down: a single level is a small dot, a real choice is a link, the current place is large. */
export interface Stop { id: string; name?: string; href?: string; kind: "skip" | "fork" | "cur" }

/**
 * Stops for a chain of folders; the last folder is the current place. On a bank page `bankId` adds the bank as the current stop,
 * so every folder that was a choice, the last one too, links back to the page that lists its neighbours.
 */
export function stopsOf(stations: Station[], title: (node: NodeManifest) => string, bankId?: string): Stop[] {
  const folders = stations.map((s, i): Stop => {
    const current = !bankId && i === stations.length - 1;
    return { id: s.node.id, name: title(s.node), href: s.fork && !current ? `#/n/${s.parent}` : undefined, kind: current ? "cur" : s.fork ? "fork" : "skip" };
  });
  if (bankId) return [...folders, { id: bankId, kind: "cur" }];
  return folders.length ? folders : [{ id: "", kind: "cur" }];
}

/** The chain of stops. Only a link is a control; with no link at all the chain is a picture and stays out of the landmarks. */
export function Stops({ stops }: { stops: Stop[] }) {
  const { t } = useTranslation();
  const list = (
    <ol>
      {stops.map((s, i) => (
        <li key={s.id} className={s.kind} style={{ "--k": i } as CSSProperties} aria-hidden={s.href ? undefined : true}>
          {s.href ? <a className="dot" href={s.href} aria-label={t("catalog.changeTo", { name: s.name })} title={s.name} /> : <span className="dot" title={s.name} />}
          {i < stops.length - 1 && <span className="seg" aria-hidden />}
        </li>
      ))}
    </ol>
  );
  return stops.some((s) => s.href)
    ? <nav className="stops" aria-label={t("catalog.path")}>{list}</nav>
    : <div className="stops" aria-hidden>{list}</div>;
}
