// Only a text with a `$` can reach the KaTeX rule of the renderer, so only such a text needs the formula chunk.
export const needsMath = (text: string): boolean => text.includes("$");
