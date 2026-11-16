import type { Status } from "@exam/core";

/** Question states in the order the legend lists them. */
export const STATUSES: Status[] = ["new", "learning", "weak", "choice", "typed"];

/** A swatch that tells states apart by shape as well as colour: outline, half, cross, dot, tick. */
export const StatusMark = ({ status, due }: { status: Status; due?: boolean }) => <i className={`cell cell-${status}${due ? " due" : ""}`} aria-hidden />;
