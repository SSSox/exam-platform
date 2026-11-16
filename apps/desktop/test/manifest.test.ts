import { describe, expect, test } from "vitest";
import { buildManifest, checkInstaller, parseReleaseArgs, releaseBase } from "../scripts/manifest.ts";

const endpoint = "https://github.com/owner/exam-platform/releases/latest/download/latest.json";
const base = "https://github.com/owner/exam-platform/releases/download/v0.2.0/";
const sha256 = "ab".repeat(32);

describe("releaseBase", () => {
  test("pins the files to the tag of the version", () => {
    expect(releaseBase(endpoint, "0.2.0")).toBe(base);
  });

  test("refuses an endpoint the apps would not accept and a version that is not major.minor.patch", () => {
    expect(() => releaseBase("https://example.com/latest.json", "0.2.0")).toThrow(/endpoints/);
    expect(() => releaseBase("", "0.2.0")).toThrow(/empty/);
    expect(() => releaseBase(endpoint, "0.2")).toThrow(/version/);
    expect(() => releaseBase(endpoint, "v0.2.0")).toThrow(/version/);
  });
});

describe("buildManifest", () => {
  const date = new Date(Date.UTC(2026, 10, 17));

  test("writes the Tauri static JSON with an Android entry the Android app checks", () => {
    const manifest = buildManifest({
      version: "0.2.0", base, date, notes: "Fixes",
      windows: { file: "exam-trainer-windows-setup.exe", signature: "c2lnLXdpbg==\n" },
      android: { file: "exam-trainer-android.apk", signature: "c2lnLWFwaw==", sha256, size: 17_000_000 },
    });
    expect(manifest).toEqual({
      version: "0.2.0",
      notes: "Fixes",
      pub_date: "2026-11-17T00:00:00.000Z",
      platforms: {
        "windows-x86_64": { url: `${base}exam-trainer-windows-setup.exe`, signature: "c2lnLXdpbg==" },
        android: { url: `${base}exam-trainer-android.apk`, signature: "c2lnLWFwaw==", sha256, size: 17_000_000 },
      },
    });
  });

  test("every platform entry has a url and a signature, or the desktop updater would reject the whole file", () => {
    const manifest = buildManifest({ version: "0.2.0", base, date, android: { file: "a.apk", signature: "s", sha256, size: 1 } });
    for (const entry of Object.values(manifest.platforms)) expect(entry).toMatchObject({ url: expect.stringMatching(/^https:/), signature: expect.any(String) });
  });

  test("refuses what would make an update fail or point elsewhere", () => {
    const android = { file: "a.apk", signature: "s", sha256, size: 1 };
    expect(() => buildManifest({ version: "0.2.0", base, date })).toThrow(/platform/);
    expect(() => buildManifest({ version: "0.2.0", base, date, android: { ...android, signature: " " } })).toThrow(/signature/);
    expect(() => buildManifest({ version: "0.2.0", base, date, android: { ...android, sha256: "AB".repeat(32) } })).toThrow(/sha256/);
    expect(() => buildManifest({ version: "0.2.0", base, date, android: { ...android, size: 0 } })).toThrow(/size/);
    expect(() => buildManifest({ version: "0.2.0", base, date, android: { ...android, file: "../a.apk" } })).toThrow(/file name/);
  });
});

describe("parseReleaseArgs", () => {
  test("takes the notes and the path of the installer signed in GitHub Actions", () => {
    expect(parseReleaseArgs([])).toEqual({});
    expect(parseReleaseArgs(["--notes=a=b", "--windows=C:/Downloads/exam-trainer-windows-setup.exe"])).toEqual({ notes: "a=b", windows: "C:/Downloads/exam-trainer-windows-setup.exe" });
  });

  test("stops on a typo or an empty path instead of releasing the local build", () => {
    expect(() => parseReleaseArgs(["--window=setup.exe"])).toThrow(/unknown argument/);
    expect(() => parseReleaseArgs(["--windows="])).toThrow(/unknown argument/);
    expect(() => parseReleaseArgs(["--only=android"])).toThrow(/unknown argument/);
    expect(() => parseReleaseArgs(["--unsigned"])).toThrow(/goes with --windows/);
    expect(parseReleaseArgs(["--windows=a.exe", "--unsigned"])).toEqual({ windows: "a.exe", unsigned: true });
  });
});

describe("checkInstaller", () => {
  const signed = { version: "0.2.0", status: "Valid", signer: "CN=SignPath Foundation", nsis: true };

  test("accepts a signed installer of the release version", () => {
    expect(checkInstaller(signed, "0.2.0")).toEqual({});
  });

  test("refuses an installer of another version: phones and PCs would get the old build under the new tag", () => {
    expect(checkInstaller(signed, "0.3.0").error).toMatch(/0.2.0, not 0.3.0/);
    expect(checkInstaller({ ...signed, version: "" }, "0.2.0").error).toMatch(/unknown/);
  });

  test("refuses the bare app, which has the same version and name as the installer", () => {
    expect(checkInstaller({ ...signed, nsis: false }, "0.2.0").error).toMatch(/not the NSIS installer/);
  });

  test("an unsigned installer needs --unsigned, and a broken signature is never accepted", () => {
    const bare = { ...signed, status: "NotSigned", signer: "" };
    expect(checkInstaller(bare, "0.2.0").error).toMatch(/--unsigned/);
    expect(checkInstaller(bare, "0.2.0", true)).toEqual({ warning: expect.stringMatching(/no code signature/) });
    expect(checkInstaller({ ...signed, status: "HashMismatch" }, "0.2.0", true).error).toMatch(/HashMismatch/);
    expect(checkInstaller({ ...signed, status: "UnknownError" }, "0.2.0", true).error).not.toMatch(/pass --unsigned/);
  });
});
