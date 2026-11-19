import katex from "katex";

// Own lazy chunk: loaded only when a rendered text holds a formula. Options are fixed because the TeX is untrusted.
export const renderMath = (tex: string, displayMode: boolean): string =>
  katex.renderToString(tex, { displayMode, throwOnError: false, trust: false, strict: "ignore", maxSize: 100 });
