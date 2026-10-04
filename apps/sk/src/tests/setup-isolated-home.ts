// that legitimately needs HOME must add `// homedir-allowed: <reason>`
// AND consider whether the preload still covers its test surface.
// Note: this preload also affects `packages/*` test runs. If a future
// `packages/*` adds production code reading HOME, audit-invariants
// won't catch it (engine-only scan) — extend the scan or split the
// bunfig preload at that point.
// `apps/sk` is the consumer that needs it — its tests transitively load
// `usage-stats.ts` (via the slash dispatcher), `settings.ts`, `config.ts`,
// `sessions.ts`, all of which resolve on-disk paths from `homedir()`.
// Without isolation, parallel CI runners stomp the developer's (or CI
// runner's) real `~/.sk/prefs.json`, leading to race-condition test
// failures that don't reproduce locally.
//
// Bun's `bunfig.toml [test].preload` array runs this once per test
// process before any test imports the production modules — so HOME is
// already redirected by the time the slash registry loads.
//
// We deliberately do NOT clean up on process exit. The tempdir lives in
// `os.tmpdir()`, gets gc'd by the OS, and the lifecycle invariant we
// care about is "tests in this process never write to the real HOME".

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SK_HOME = mkdtempSync(join(tmpdir(), "sk-test-home-"));
process.env.HOME = SK_HOME;
process.env.USERPROFILE = SK_HOME;
