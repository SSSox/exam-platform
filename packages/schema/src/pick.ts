import type { Localized } from "./index.ts";

/**
 * Resolve localized text along a fallback chain; returns the locale actually used.
 * Lives apart from the schemas so that an app showing text does not have to carry the validator: import it as `@exam/schema/pick`.
 */
export function pick(value: Localized, chain: string[], bankLanguage: string): { text: string; locale: string } {
  if (typeof value === "string") return { text: value, locale: bankLanguage };
  for (const locale of [...chain, bankLanguage]) {
    const text = value[locale];
    if (text) return { text, locale };
  }
  const [locale, text] = Object.entries(value)[0]!;
  return { text, locale };
}
