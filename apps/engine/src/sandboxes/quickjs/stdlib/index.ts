// Loader for the sk-Stdlib source. Imports `stdlib.js` as text so the
// content is bundled into the `bun build --compile` single-file binary.
// Reading via `readFileSync(import.meta.dir + "/stdlib.js")` worked under
// `bun run` but silently failed once the binary is shipped — Bun only
// embeds assets that the bundler can see as imports.
//
// Also exposes STDLIB_VERSION parsed from the source so callers do not
// have to boot QuickJS just to learn the stdlib version.

import stdlibSource from "./stdlib.js" with { type: "text" };

// stdlib.js is evaluated afresh on every runJs call (QuickJS shares no
// bytecode across contexts), so every byte of the source is re-parsed
// per transform/hook invocation. Full-line comments are ~a quarter of
// the file and exist for humans, not the VM — strip them once at module
// load so the documented source stays readable while the evaluated text
// stays lean. Line-based on purpose: it can only mis-strip if a
// MULTILINE template literal had a line starting with `//`, and the
// stdlib has none (all template literals are single-line — the size
// tripwire's parse check would catch a violation anyway).
export const STDLIB_SOURCE: string = (stdlibSource as unknown as string)
  .split("\n")
  .filter((line) => !/^\s*\/\//.test(line))
  .join("\n");

// Extracted at load time so callers do not have to boot QuickJS just
// to learn the stdlib version. Keep the regex aligned with stdlib.js.
const versionMatch = STDLIB_SOURCE.match(/version:\s*"([^"]+)"/);
if (!versionMatch) {
  throw new Error("sk-stdlib: could not extract version from stdlib.js");
}

export const STDLIB_VERSION: string = versionMatch[1] ?? "0.0.0";
