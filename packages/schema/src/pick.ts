import type { Localized } from "./index.ts";

/**
 * Resolve localized text along a fallback chain; returns the locale actually used.
 * Lives apart from the schemas so that an app showing text does not have to carry the validator: import it as `@exam/schema/pick`.
 */
export function pick(value: Localized, chain: string[], bankLanguage: string): { text: string; locale: string } {
  if (typeof value === "string") return { text: value, locale: bankLanguage };
  // Only the object's own texts count: a language named like an inherited property ("constructor", "toString") would otherwise give a function.
  for (const locale of [...chain, bankLanguage]) {
    const text = Object.hasOwn(value, locale) ? value[locale] : undefined;
    if (typeof text === "string" && text) return { text, locale };
  }
  // A broken mirror can deliver an empty object; the index is cached, so throwing here would break every later offline start.
  const first = Object.entries(value).find((entry) => typeof entry[1] === "string");
  return first ? { text: first[1], locale: first[0] } : { text: "", locale: bankLanguage };
}
