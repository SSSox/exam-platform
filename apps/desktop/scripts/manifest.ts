/**
 * The update manifest (`latest.json`) both apps read from the newest GitHub release.
 * Its shape is the Tauri updater's static JSON: the desktop updater checks every platform entry, so each one carries
 * `url` and `signature`. The Android entry adds `sha256` and `size`, which AppUpdates.kt checks before installing.
 */

const ENDPOINT = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/latest\/download\/latest\.json$/;
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const FILE = /^[A-Za-z0-9_.-]+$/;

export type Signed = { file: string; signature: string };
export type AndroidFile = Signed & { sha256: string; size: number };
export type Manifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { url: string; signature: string; sha256?: string; size?: number }>;
};

/** The folder of the release `v<version>`: files are pinned to their tag, so the manifest cannot be paired with another release's files. */
export function releaseBase(endpoint: string, version: string): string {
  const match = ENDPOINT.exec(endpoint);
  if (!match) throw new Error(`plugins.updater.endpoints[0] must be https://github.com/<owner>/<repo>/releases/latest/download/latest.json, not ${endpoint || "empty"}`);
  if (!VERSION.test(version)) throw new Error(`version must be major.minor.patch, not ${version}`);
  return `https://github.com/${match[1]}/${match[2]}/releases/download/v${version}/`;
}

export type ReleaseOptions = { notes?: string; windows?: string; unsigned?: boolean };

/**
 * `npm run release` options: `--notes=<text>`, `--windows=<installer from GitHub Actions>` and `--unsigned`, which
 * allows that installer without a code signature (the releases before SignPath approves the project). Anything else is a typo.
 */
export function parseReleaseArgs(args: string[]): ReleaseOptions {
  const options: ReleaseOptions = {};
  for (const arg of args) {
    const [name, value] = [arg.slice(0, arg.indexOf("=") + 1), arg.slice(arg.indexOf("=") + 1)];
    if (arg === "--unsigned") options.unsigned = true;
    else if (name === "--notes=") options.notes = value;
    else if (name === "--windows=" && value.trim()) options.windows = value.trim();
    else throw new Error(`unknown argument ${arg}: the options are --notes="...", --windows=<path to the installer> and --unsigned`);
  }
  if (options.unsigned && !options.windows) throw new Error("--unsigned goes with --windows=<path to the installer>");
  return options;
}

/**
 * What Windows reports about a file: ProductVersion, the Authenticode check (`Get-AuthenticodeSignature`) and whether it
 * is an NSIS installer at all (the app itself carries the same version and name).
 */
export type InstallerInfo = { version: string; status: string; signer: string; nsis: boolean };

/**
 * Stops a release that would ship the wrong file: another version (the updater would offer the old build under the new
 * tag), the bare app instead of the installer, or a file without a valid code signature unless `--unsigned` says so.
 */
export function checkInstaller(info: InstallerInfo, version: string, unsigned = false): { error?: string; warning?: string } {
  if (!info.nsis) return { error: "this is not the NSIS installer: take exam-trainer-windows-setup.exe from the windows-installer artifact" };
  if (info.version.trim() !== version) return { error: `the installer is version ${info.version || "unknown"}, not ${version}: download the installer of this version` };
  if (info.status === "Valid") return {};
  if (info.status === "NotSigned" && unsigned) return { warning: "the installer has no code signature: Windows SmartScreen will warn about an unknown publisher" };
  const fix = unsigned ? "a test or broken signature is never released" : "or pass --unsigned for a release without a code signature";
  return { error: `the installer has no valid code signature (${info.status}): take it from the windows-installer artifact after SignPath signed it; ${fix}` };
}

export function buildManifest(options: { version: string; base: string; date: Date; notes?: string; windows?: Signed; android?: AndroidFile }): Manifest {
  const { version, base, windows, android } = options;
  if (!VERSION.test(version)) throw new Error(`version must be major.minor.patch, not ${version}`);
  if (!windows && !android) throw new Error("a release needs at least one platform");
  const entry = ({ file, signature }: Signed) => {
    if (!FILE.test(file)) throw new Error(`unsafe file name ${file}`);
    if (!signature.trim()) throw new Error(`no signature for ${file}`);
    return { url: base + file, signature: signature.trim() };
  };
  const platforms: Manifest["platforms"] = {};
  if (windows) platforms["windows-x86_64"] = entry(windows);
  if (android) {
    if (!/^[0-9a-f]{64}$/.test(android.sha256)) throw new Error("sha256 must be 64 lowercase hex digits");
    if (!Number.isSafeInteger(android.size) || android.size <= 0) throw new Error("size must be a positive whole number");
    platforms.android = { ...entry(android), sha256: android.sha256, size: android.size };
  }
  return { version, notes: options.notes ?? "", pub_date: options.date.toISOString(), platforms };
}
