import { describe, expect, test } from "vitest";
import { KEYS, UPDATE_CHECK_EVERY, isCheckDone, isUpdateDue, readUpdateState, updateCheckStamp, updateOffer, updatesPaused, type UpdateState } from "../src/lib.ts";

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

  test("a found version wipes an older \"nothing new\" time, so after Later the next launch offers it again", () => {
    expect(updateCheckStamp("latest", now)).toBe(String(now));
    expect(updateCheckStamp("available", now)).toBeNull();
    expect(updateCheckStamp("ready", now)).toBeNull();
    // The stamp went away, so the startup check is due again whatever the day.
    expect(isUpdateDue(Number(localStorageAfter(["latest", "available"]) ?? undefined), now + 60_000)).toBe(true);
  });

  test("checking, failing, downloading and the rest leave the time as it was", () => {
    for (const phase of ["off", "idle", "checking", "downloading", "installing", "permission", "failed"] as const) expect(updateCheckStamp(phase, now)).toBeUndefined();
    expect(localStorageAfter(["latest", "checking", "failed"])).toBe(String(now));
  });

  test("the time of the last check is one of the app's own keys, so deleting all data clears it", () => {
    expect(Object.values(KEYS)).toContain("updateCheck");
  });
});

/** What the stored time is after the states arrive one by one, applied the way `set` in updates.tsx applies them. */
function localStorageAfter(phases: Parameters<typeof updateCheckStamp>[0][]): string | null {
  let stored: string | null = null;
  for (const phase of phases) {
    const stamp = updateCheckStamp(phase, Date.UTC(2026, 10, 17, 12));
    if (stamp !== undefined) stored = stamp;
  }
  return stored;
}

describe("what the app does about a found version", () => {
  const found: UpdateState = { phase: "available", current: "0.2.0", version: "0.3.0" };
  const ask = { auto: false };

  test("asks by default, again at the next launch after Later, and installs by itself only with the setting on", () => {
    expect(updateOffer(found, ask)).toBe("ask");
    expect(updateOffer(found, { ...ask, answered: "0.3.0" })).toBeUndefined();
    expect(updateOffer({ ...found, phase: "ready" }, ask)).toBe("ask");
    expect(updateOffer(found, { auto: true })).toBe("install");
  });

  test("Don't show again covers only that version: the next one asks again", () => {
    expect(updateOffer(found, { ...ask, skipped: "0.3.0" })).toBeUndefined();
    expect(updateOffer({ ...found, version: "0.4.0" }, { ...ask, skipped: "0.3.0" })).toBe("ask");
  });

  test("installs by itself once a run: a cancelled Android installer that leaves the version ready is not opened again", () => {
    expect(updateOffer({ ...found, phase: "ready" }, { auto: true, tried: new Set(["0.3.0"]) })).toBeUndefined();
    expect(updateOffer({ ...found, version: "0.4.0" }, { auto: true, tried: new Set(["0.3.0"]) })).toBe("install");
  });

  test("a version that failed is not installed again after another one failed in between", () => {
    const tried = new Set(["0.3.0", "0.4.0"]);
    expect(updateOffer(found, { auto: true, tried })).toBeUndefined();
    expect(updateOffer({ ...found, version: "0.4.0" }, { auto: true, tried })).toBeUndefined();
    expect(updateOffer({ ...found, version: "0.5.0" }, { auto: true, tried })).toBe("install");
  });

  test("nothing while there is no version on offer", () => {
    for (const phase of ["off", "idle", "checking", "latest", "downloading", "installing", "permission", "failed"] as const) {
      expect(updateOffer({ phase, version: "0.3.0" }, ask)).toBeUndefined();
      expect(updateOffer({ phase, version: "0.3.0" }, { auto: true })).toBeUndefined();
    }
    expect(updateOffer({ phase: "available" }, ask)).toBeUndefined();
  });

  test("waits during a session, on the settings screen and while a kept exam is being restored", () => {
    expect(updatesPaused("session", false)).toBe(true);
    expect(updatesPaused("settings", false)).toBe(true);
    // At launch the address is still the home page until the kept exam's bank loads.
    expect(updatesPaused("", true)).toBe(true);
    expect(updatesPaused("bank", true)).toBe(true);
    // Restored (the session takes over) or given up: the home page and the bank page may offer it again.
    expect(updatesPaused("", false)).toBe(false);
    expect(updatesPaused("bank", false)).toBe(false);
  });

  test("the skipped version is one of the app's own keys, so deleting all data clears it", () => {
    expect(Object.values(KEYS)).toContain("updateSkip");
  });
});
