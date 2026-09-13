// Shared browser-launch helper.
//
// Argv-style browser launch — never `exec` with string interpolation.
// Even though launched URLs originate from the engine (not user TTY
// input), the AGENTS.md threat-model treats anything launched by the
// CLI as a boundary. `spawn(bin, [arg], { shell: false })` makes shell
// metacharacters (`$`, `;`, `|`, backticks, …) inert by passing argv
// through directly to the OS — there is no shell to interpret them.
//
// Windows special case: the canonical `start` is a `cmd.exe` builtin,
// not a binary, so we go through `cmd.exe /c start "" <url>` and pass
// the URL as a separate argv slot. `windowsVerbatimArguments: false`
// (the default) lets Node escape it correctly.
//
// Extracted from `domain/connectors/OAuthWaitView.tsx` so the OAuth
// elicitation path in the REPL can reuse the exact same launch logic.

import { spawn } from "node:child_process";

import { z } from "zod";

/**
 * Validate a URL before launching it via `spawn(bin, [url])`. The
 * `shell: false` guard prevents shell-injection but does NOT prevent
 * URL-scheme abuse — `xdg-open file:///etc/passwd` would still launch
 * a file reader. Restrict to plain `http(s)://`.
 */
export const BrowserUrlSchema = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), {
    // The `^https?://` allowlist is a positive control: it admits only
    // http(s) and rejects EVERYTHING else (file:, javascript:, data:,
    // scheme-less, …). The message names what the schema enforces — the
    // allowlist — rather than enumerating a blocklist it does not have.
    message: "URL must be an http(s) URL",
  });

/**
 * Validate `url` against `BrowserUrlSchema` (plain http(s) only) and
 * return the validated string. Throws an `Error` carrying the schema's
 * own message when the URL is not a launchable http(s) URL.
 *
 * Single validated entry point for callers that need to assert a URL is
 * safe to launch before handing it to `defaultOpenBrowser` or any other
 * launch path — keeps the http(s)-only policy in one place.
 */
export function assertHttpsUrl(url: string): string {
  const parsed = BrowserUrlSchema.safeParse(url);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "invalid URL");
  }
  return parsed.data;
}

/**
 * Open `url` in the operator's default browser. Resolves once the
 * launch is dispatched (the browser, by design, outlives the REPL);
 * rejects if `spawn` errors or the URL is not a plain http(s) URL.
 */
export function defaultOpenBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let validated: string;
    try {
      validated = assertHttpsUrl(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("invalid URL"));
      return;
    }
    const platform = process.platform;
    const [bin, args] =
      platform === "darwin"
        ? (["open", [validated]] as const)
        : platform === "win32"
          ? (["cmd.exe", ["/c", "start", "", validated]] as const)
          : (["xdg-open", [validated]] as const);
    const child = spawn(bin, [...args], {
      shell: false,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    // Don't keep the parent process alive waiting on the child to exit —
    // the browser, by design, outlives this REPL.
    child.unref();
    resolve();
  });
}
