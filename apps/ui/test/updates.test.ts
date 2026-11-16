import { describe, expect, test } from "vitest";
import { KEYS, UPDATE_CHECK_EVERY, isCheckDone, isUpdateDue, readUpdateState } from "../src/lib.ts";

describe("readUpdateState", () => {
  test("takes the Android shell's JSON text and the desktop's objects alike", () => {
    const report = { phase: "downloading", current: "0.1.0", version: "0.2.0", size: 9_000_000, received: 262_144 };
    expect(readUpdateState(JSON.stringify(report))).toEqual(report);
    expect(readUpdateState(report)).toEqual(report);
  });

  test("an unknown or broken report turns updates off instead of showing a wrong button", () => {
    expect(readUpdateState({ phase: "explode" })).toEqual({ phase: "off" });
    expect(readUpdateState("{not json")).toEqual({ phase: "off" });
    expect(readUpdateState(null)).toEqual({ phase: "off" });
    expect(readUpdateState(42)).toEqual({ phase: "off" });
  });

  test("fields of the wrong type or with impossible values are dropped", () => {
    expect(readUpdateState({ phase: "available", version: 2, size: -1, received: Number.NaN, reason: {}, extra: "x" })).toEqual({ phase: "available" });
  });
});

describe("daily update check", () => {
  const now = Date.UTC(2026, 10, 17, 12);

  test("runs on the first launch and again a day after the last finished check", () => {
    expect(isUpdateDue(undefined, now)).toBe(true);
    expect(isUpdateDue(Number.NaN, now)).toBe(true);
    expect(isUpdateDue(now - UPDATE_CHECK_EVERY + 1, now)).toBe(false);
    expect(isUpdateDue(now - UPDATE_CHECK_EVERY, now)).toBe(true);
  });

  test("a check time in the future (clock set back) does not block checks", () => {
    expect(isUpdateDue(now + 60_000, now)).toBe(true);
  });

  test("only a check that found nothing new restarts the wait, so a found update is offered again at the next launch", () => {
    expect(isCheckDone("latest")).toBe(true);
    expect(["available", "ready", "failed", "checking", "idle", "off"].some((phase) => isCheckDone(phase as never))).toBe(false);
  });

  test("the time of the last check is one of the app's own keys, so deleting all data clears it", () => {
    expect(Object.values(KEYS)).toContain("updateCheck");
  });
});
