const OSES = ["windows", "android"] as const;

/**
 * An https address with a real host, in plain printable ASCII: nothing invisible, look-alike or quoted can ride along into the page
 * (the URL parser would quietly drop a tab or a zero-width space and keep the address working). A domain in another script goes in punycode.
 */
function isHttpsAddress(value: string): boolean {
  if (!/^https:\/\/(?![/?#\\])[\x21-\x7e]+$/i.test(value) || /["'<>]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /[a-z0-9]/i.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The addresses of the installable apps for one build, read by `vite.config.ts`. `file` is the text of `downloads.json`
 * (undefined when there is no such file: then only the variables give links); `env` holds `VITE_DOWNLOAD_WINDOWS` and `VITE_DOWNLOAD_ANDROID`,
 * which win over the file. `none` in any case hides a link, and so does an empty value (a Windows shell cannot pass an empty variable, so there it is `none`).
 * Anything else that is not an https address stops the build, and so does a key other than `windows` and `android` (a misspelt key would hide a link unnoticed);
 * the message names where the value came from.
 */
export function parseDownloads(file: string | undefined, env: { windows?: string; android?: string }): { windows?: string; android?: string } {
  let data: Record<string, unknown> = {};
  if (file != null) {
    // Windows PowerShell 5 writes UTF-16 with `>` and `Out-File`; read as UTF-8 it is full of NUL characters.
    if (file.includes("\u0000")) throw new Error("downloads.json: save the file as UTF-8");
    let parsed: unknown;
    try {
      // `Set-Content -Encoding UTF8` in Windows PowerShell 5 adds a byte order mark, which JSON.parse rejects.
      parsed = JSON.parse(file.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`downloads.json: ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("downloads.json: expected an object with `windows` and `android`");
    data = parsed as Record<string, unknown>;
    const unknown = Object.keys(data).filter((key) => !(OSES as readonly string[]).includes(key));
    if (unknown.length) throw new Error(`downloads.json: unknown key ${unknown.map((k) => `\`${k}\``).join(", ")}, expected \`windows\` and \`android\``);
  }
  const pick = (os: (typeof OSES)[number]) => {
    const fromEnv = env[os] !== undefined;
    const where = fromEnv ? `VITE_DOWNLOAD_${os.toUpperCase()}` : `downloads.json: \`${os}\``;
    const raw = fromEnv ? env[os] : (data[os] ?? "");
    if (typeof raw !== "string") throw new Error(`${where} must be a string, got ${JSON.stringify(raw)}`);
    const value = raw.trim();
    if (!value || value.toLowerCase() === "none") return undefined;
    if (!isHttpsAddress(value)) throw new Error(`${where} must be an https address, got ${JSON.stringify(value)}`);
    return value;
  };
  const windows = pick("windows");
  const android = pick("android");
  return { ...(windows && { windows }), ...(android && { android }) };
}
