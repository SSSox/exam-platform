import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { safeStyle } from "./lib.ts";

// Lazy chunk (see rich.tsx): markdown-it and DOMPurify are only needed once a question text is drawn.
// Content comes from third-party repositories: raw HTML is off and every result goes through the one DOMPurify call below.
export type MathFn = (tex: string, displayMode: boolean) => string;

const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
// Set for the duration of one synchronous render; the formula chunk is not part of this module.
let math: MathFn | undefined;

md.inline.ruler.before("escape", "math", (state, silent) => {
  if (state.src[state.pos] !== "$") return false;
  const display = state.src[state.pos + 1] === "$";
  const open = state.pos + (display ? 2 : 1);
  const close = state.src.indexOf(display ? "$$" : "$", open);
  if (close <= open || /^\s|\s$/.test(state.src.slice(open, close))) return false;
  if (!silent) {
    const token = state.push("math", "", 0);
    token.content = state.src.slice(open, close);
    token.meta = display;
  }
  state.pos = close + (display ? 2 : 1);
  return true;
});
// Without the formula chunk the TeX source is shown as plain escaped text.
md.renderer.rules.math = (tokens, i) => math ? math(tokens[i]!.content, tokens[i]!.meta) : md.utils.escapeHtml(`$${tokens[i]!.content}$`);
md.renderer.rules.image = (tokens, i) => {
  const src = tokens[i]!.attrGet("src") ?? "";
  // Only pictures shipped with the content; never a remote tracker.
  return /^[\w./-]+$/.test(src) && !src.includes("..") ? `<img src="./content/assets/${src}" alt="${md.utils.escapeHtml(tokens[i]!.content)}">` : "";
};

// KaTeX lays a formula out with inline styles (the height of a numerator, the width of a rule), and raw HTML is off, so a style attribute can only come from it.
// It stays on elements inside `.katex`, cut down to harmless layout declarations; anywhere else it goes. Registered once, when the module loads.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeType !== 1 || !node.hasAttribute("style")) return;
  const style = node.closest(".katex") ? safeStyle(node.getAttribute("style") ?? "") : "";
  if (style) node.setAttribute("style", style);
  else node.removeAttribute("style");
});

export function renderRich(text: string, inline: boolean, formula?: MathFn): string {
  math = formula;
  try {
    return DOMPurify.sanitize(inline ? md.renderInline(text) : md.render(text), { FORBID_TAGS: ["a", "style"] });
  } finally {
    math = undefined;
  }
}
