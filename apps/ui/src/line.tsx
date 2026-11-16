import type { CSSProperties } from "react";

interface LineProps {
  /** Stations on the line. */
  count: number;
  /** How many are lit counted from the start, or exactly which ones. */
  lit: number | boolean[];
  /** Station that is the current one, if any. */
  current?: number;
  /** Stations that were answered wrong, drawn in the error colour. */
  bad?: boolean[];
  /** Start offset of the lighting-up animation, in ms. */
  delay?: number;
}

/** A subject line: stations joined by a bar, lit ones are filled. Decorative; the numbers beside it say the same. */
export function Line({ count, lit, current, bad, delay = 0 }: LineProps) {
  const dot = count <= 12 ? 10 : count <= 24 ? 8 : 6;
  const ring = count <= 24 ? 2.5 : 1.5;
  const on = (k: number) => (typeof lit === "number" ? k < lit : lit[k] === true);
  return (
    <span className="line" aria-hidden style={{ "--dot": `${dot}px`, "--ring": `${ring}px`, "--d": `${delay}ms` } as CSSProperties}>
      {Array.from({ length: count }, (_, k) => (
        <span className="stop" key={k} style={{ "--k": k } as CSSProperties}>
          <i className={[on(k) ? "on" : "", bad?.[k] ? "bad" : "", k === current ? "cur" : ""].filter(Boolean).join(" ")} />
          {k < count - 1 && <b className={on(k) && on(k + 1) ? "on" : ""} />}
        </span>
      ))}
    </span>
  );
}
