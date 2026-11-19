import { memo, useEffect, useMemo, useSyncExternalStore } from "react";
import { needsMath } from "./formula.ts";
import { plainText } from "./lib.ts";
import type { MathFn } from "./render.ts";

// The markdown renderer (markdown-it, DOMPurify) and KaTeX are lazy chunks. Until they arrive a text is shown without its marks (`plainText`), as a React text node
// (never through innerHTML), and every mounted Rich re-renders when the store below changes.
type Render = typeof import("./render.ts").renderRich;
let render: Render | undefined;
let formula: MathFn | undefined;
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

let rendering: Promise<void> | undefined;
function loadRenderer(): Promise<void> {
  rendering ??= import("./render.ts").then((m) => { render = m.renderRich; bump(); }, (e) => { rendering = undefined; throw e; });
  return rendering;
}

let formulas: Promise<void> | undefined;
function loadMath(): Promise<void> {
  // Both the script and the stylesheet must be in before a formula is shown, so it is never unstyled.
  formulas ??= Promise.all([import("./math.ts"), import("katex/dist/katex.min.css")]).then(([m]) => { formula = m.renderMath; bump(); }, (e) => { formulas = undefined; throw e; });
  return formulas;
}

// Warm the renderer in idle time after the first screen; Safari has no requestIdleCallback. A Rich that mounts earlier loads it itself.
export function preloadRenderer(): void {
  const go = () => { loadRenderer().catch(() => {}); };
  if (typeof requestIdleCallback === "function") requestIdleCallback(go, { timeout: 2000 });
  else setTimeout(go, 1000);
}

export const Rich = memo(function Rich({ text, inline = false }: { text: string; inline?: boolean }) {
  useSyncExternalStore(subscribe, () => version);
  const math = needsMath(text);
  useEffect(() => {
    // A failed load keeps the raw text on screen; the next mount tries again.
    loadRenderer().catch(() => {});
    if (math) loadMath().catch(() => {});
  }, [math]);
  const ready = render !== undefined && (!math || formula !== undefined);
  const html = useMemo(() => ready ? render!(text, inline, formula) : "", [ready, text, inline]);
  const Tag = inline ? "span" : "div";
  // Not ready (the chunk is on its way, or it or the formulas failed to load): the text without its marks, as a text node.
  return ready ? <Tag className="rich" dangerouslySetInnerHTML={{ __html: html }} /> : <Tag className="rich">{plainText(text)}</Tag>;
});
