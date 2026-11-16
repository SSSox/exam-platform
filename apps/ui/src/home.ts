import { useSyncExternalStore } from "react";

/**
 * Where the address "#/" leads right now, once a screen has worked it out. The header links point there directly:
 * following "#/" on the page it resolves to would add a history entry that the home screen then replaces with a copy of the page.
 */
let home = "#/";
const listeners = new Set<() => void>();

export function rememberHome(hash: string): void {
  if (hash === home) return;
  home = hash;
  listeners.forEach((listener) => listener());
}

/** Nothing is known: "#/" is the way in, and the home screen resolves it. */
export const forgetHome = () => rememberHome("#/");

export const useHome = () =>
  useSyncExternalStore((listener) => { listeners.add(listener); return () => void listeners.delete(listener); }, () => home);
