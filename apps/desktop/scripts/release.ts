/**
 * Prepares a release in `release/`: the Windows installer and the Android APK under the names the download links use,
 * a minisign signature of each (made with the updater key) and `latest.json` for the apps' updaters.
 * Uploading stays a separate step: the script prints the `gh release create` line.
 *
 *   npm run release                    the Windows installer and the Android APK
 *   npm run release -- --notes="..."   text of the release in latest.json
 *   npm run release -- --windows=...   the installer built and code-signed by GitHub Actions instead of the local build
 *   npm run release -- --windows=... --unsigned   the same installer before SignPath signs it
 *
 * The updater signature is made here, after the code signature: it covers the final bytes of the installer.
 * A release always carries both files: `releases/latest/download` serves every download link and every app from the one
 * newest release, so a release without one platform would turn that platform's link into a 404.
 * The key comes from TAURI_SIGNING_PRIVATE_KEY_PATH (or TAURI_SIGNING_PRIVATE_KEY) and TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildManifest, checkInstaller, parseReleaseArgs, releaseBase, type AndroidFile, type InstallerInfo, type Signed } from "./manifest.ts";

const root = resolve(import.meta.dirname, "../../..");
const tauri = join(root, "apps/desktop/src-tauri");
const out = join(root, "release");
const NAMES = { windows: "exam-trainer-windows-setup.exe", android: "exam-trainer-android.apk" };

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

let options: ReturnType<typeof parseReleaseArgs> = {};
try {
  options = parseReleaseArgs(process.argv.slice(2));
} catch (error) {
  fail((error as Error).message);
}
const { notes } = options;

const config = JSON.parse(readFileSync(join(tauri, "tauri.conf.json"), "utf8"));
const version: string = config.version;
const updater = config.plugins?.updater ?? {};
if (!String(updater.pubkey ?? "").trim()) fail("plugins.updater.pubkey in tauri.conf.json is empty: generate the updater key first (docs/PUBLISHING.md)");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) fail("set TAURI_SIGNING_PRIVATE_KEY_PATH to the updater's private key");
let base = "";
try {
  base = releaseBase(updater.endpoints?.[0] ?? "", version);
} catch (error) {
  fail((error as Error).message);
}

/** The newest file in a folder whose name matches, so a forgotten installer of an older version is not picked up. */
function newest(dir: string, match: (name: string) => boolean): string | undefined {
  if (!existsSync(dir)) return undefined;
  return readdirSync(dir).filter(match).map((name) => join(dir, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** `tauri signer sign` writes `<file>.sig`; `--app-version` puts the version into the signed comment (requireSignedVersion checks it). */
function sign(file: string): string {
  const cli = join(root, "node_modules/@tauri-apps/cli/tauri.js");
  const run = spawnSync(process.execPath, [cli, "signer", "sign", "--app-version", version, file], { stdio: "inherit" });
  if (run.status !== 0) fail(`signing ${file} failed`);
  return readFileSync(`${file}.sig`, "utf8");
}

/** ProductVersion and the Authenticode check of an installer, read by Windows itself. */
function inspect(file: string): InstallerInfo {
  const script = "$i = Get-Item -LiteralPath $env:INSTALLER; $s = Get-AuthenticodeSignature -LiteralPath $env:INSTALLER; " +
    "@{ version = [string]$i.VersionInfo.ProductVersion; status = [string]$s.Status; signer = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress";
  // Windows PowerShell 5.1 started from PowerShell 7 inherits its PSModulePath and then cannot load Get-AuthenticodeSignature.
  const { PSModulePath: _, ...env } = process.env;
  const run = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...env, INSTALLER: file }, encoding: "utf8" });
  // A cmdlet that fails still exits 0, so any error output counts: an empty status must not pass for a reason to warn.
  if (run.status !== 0 || run.stderr.trim()) fail(`cannot read ${file}: ${run.stderr.trim()}`);
  // Every NSIS installer carries this marker of its data block; the app binary does not.
  return { ...JSON.parse(run.stdout), nsis: readFileSync(file).includes("NullsoftInst") } as InstallerInfo;
}

let installer: string | undefined;
if (options.windows) {
  // The installer built and signed by GitHub Actions (.github/workflows/release.yml), downloaded from the run's artifact.
  installer = resolve(options.windows);
  if (process.platform !== "win32") fail("--windows needs Windows: the installer's version and signature are read with PowerShell");
  if (!existsSync(installer)) fail(`no file ${installer}`);
  const info = inspect(installer);
  const verdict = checkInstaller(info, version, options.unsigned);
  if (verdict.error) fail(verdict.error);
  if (verdict.warning) console.warn(`release: ${verdict.warning}`);
  else console.log(`release: the installer is signed by ${info.signer}`);
} else {
  installer = newest(join(tauri, "target/release/bundle/nsis"), (name) => name.endsWith(`_${version}_x64-setup.exe`));
  if (!installer) fail(`no installer of version ${version}: run npx tauri build in apps/desktop, or pass --windows=<the installer signed in GitHub Actions>`);
}

const properties = join(tauri, "gen/android/app/tauri.properties");
if (!existsSync(properties)) fail("the Android project has not been built yet: build the APK (README, Build)");
const built = readFileSync(properties, "utf8").match(/^tauri\.android\.versionName=(.*)$/m)?.[1]?.trim();
if (built !== version) fail(`the Android project was last built as ${built ?? "unknown"}, not ${version}: rebuild the APK`);
const apk = join(tauri, "gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk");
if (!existsSync(apk)) fail("no signed release APK: build it with keystore.properties in place (README, Build)");
// The build rewrites tauri.properties only when the version changes, before Gradle runs: an APK older than it is
// left over from the previous version (that build stopped early), and the phones would reject it as not the announced one.
if (statSync(apk).mtimeMs < statSync(properties).mtimeMs) fail(`the release APK is older than the ${version} build: rebuild the APK`);

mkdirSync(out, { recursive: true });
const exe = join(out, NAMES.windows);
copyFileSync(installer, exe);
const windows: Signed = { file: NAMES.windows, signature: sign(exe) };
const target = join(out, NAMES.android);
copyFileSync(apk, target);
const bytes = readFileSync(target);
const android: AndroidFile = { file: NAMES.android, signature: sign(target), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };

const manifest = buildManifest({ version, base, date: new Date(), notes, windows, android });
writeFileSync(join(out, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");

const files = [NAMES.windows, NAMES.android, "latest.json"].map((name) => `release/${name}`);
// SignPath Foundation asks every release page to link the code signing policy.
const policy = `${base.replace(/\/releases\/download\/.*$/, "")}/blob/main/README.en.md#code-signing-policy`;
console.log(`\nrelease/latest.json is ready for v${version}. Publish the release with:\n\n  gh release create v${version} ${files.join(" ")} --title v${version} --notes "Code signing policy: ${policy}"\n`);
console.log("The tag must be exactly v" + version + ": the manifest points at files under it.");
