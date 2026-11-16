import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeBack } from "../src/back.ts";

describe("takeBack", () => {
  const shell = { setDark: vi.fn(), holdBack: vi.fn() };
  const gone: (() => void)[] = [];
  const take = (run: () => void) => {
    const give = takeBack(run);
    gone.push(give);
    return give;
  };

  beforeEach(() => {
    shell.holdBack.mockClear();
    vi.stubGlobal("window", { ExamSystemBars: shell });
  });
  afterEach(() => {
    gone.splice(0).forEach((give) => give());
    vi.unstubAllGlobals();
  });

  it("asks the shell for the Back button and passes the press to the taker", () => {
    const sheet = vi.fn();
    take(sheet);
    expect(shell.holdBack).toHaveBeenLastCalledWith(true);
    window.examBack!();
    expect(sheet).toHaveBeenCalledTimes(1);
  });

  it("hands the press to the newest taker, and to the one before once that one is gone", () => {
    const exam = vi.fn();
    const sheet = vi.fn();
    take(exam);
    const giveSheet = take(sheet);
    window.examBack!();
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(exam).not.toHaveBeenCalled();

    giveSheet();
    expect(shell.holdBack).toHaveBeenLastCalledWith(true);
    window.examBack!();
    expect(exam).toHaveBeenCalledTimes(1);
  });

  it("gives the button back to the history when the last taker is gone", () => {
    const give = take(vi.fn());
    give();
    give();
    expect(shell.holdBack).toHaveBeenLastCalledWith(false);
    expect(window.examBack).toBeUndefined();
  });

  it("works where there is no Android shell", () => {
    vi.stubGlobal("window", {});
    const sheet = vi.fn();
    take(sheet);
    window.examBack!();
    expect(sheet).toHaveBeenCalledTimes(1);
  });
});

describe("a fresh page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("gives back the Back button a page held before it reloaded", async () => {
    // The shell keeps the button for as long as it was last told to: a reload while a sheet held it (the data wipe) left Back dead.
    const shell = { setDark: vi.fn(), holdBack: vi.fn() };
    vi.stubGlobal("window", { ExamSystemBars: shell });
    vi.resetModules();
    await import("../src/back.ts");
    expect(shell.holdBack).toHaveBeenCalledExactlyOnceWith(false);
    expect(window.examBack).toBeUndefined();
  });
});
