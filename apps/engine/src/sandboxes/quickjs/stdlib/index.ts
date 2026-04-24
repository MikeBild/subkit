// Loader for the sk-Stdlib source. Reads `stdlib.js` at module
// initialization and exposes the string for injection into QuickJS
// contexts. Also exposes STDLIB_VERSION parsed from the source so
// callers can persist it into workflow manifests for drift detection.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_PATH = join(import.meta.dir, "stdlib.js");

export const STDLIB_SOURCE: string = readFileSync(SOURCE_PATH, "utf8");

// Extracted at load time so callers do not have to boot QuickJS just
// to learn the stdlib version. Keep the regex aligned with stdlib.js.
const versionMatch = STDLIB_SOURCE.match(/version:\s*"([^"]+)"/);
if (!versionMatch) {
  throw new Error("sk-stdlib: could not extract version from stdlib.js");
}

export const STDLIB_VERSION: string = versionMatch[1] ?? "0.0.0";
