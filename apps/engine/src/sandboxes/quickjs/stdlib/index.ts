// Loader for the sk-Stdlib source. Imports `stdlib.js` as text so the
// content is bundled into the `bun build --compile` single-file binary.
// Reading via `readFileSync(import.meta.dir + "/stdlib.js")` worked under
// `bun run` but silently failed once the binary is shipped — Bun only
// embeds assets that the bundler can see as imports.
//
// Also exposes STDLIB_VERSION parsed from the source so callers do not
// have to boot QuickJS just to learn the stdlib version.

import stdlibSource from "./stdlib.js" with { type: "text" };

export const STDLIB_SOURCE: string = stdlibSource as unknown as string;

// Extracted at load time so callers do not have to boot QuickJS just
// to learn the stdlib version. Keep the regex aligned with stdlib.js.
const versionMatch = STDLIB_SOURCE.match(/version:\s*"([^"]+)"/);
if (!versionMatch) {
  throw new Error("sk-stdlib: could not extract version from stdlib.js");
}

export const STDLIB_VERSION: string = versionMatch[1] ?? "0.0.0";
