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

import { afterAll } from "bun:test";
import {
  claimIsolatedTestHome,
  createIsolatedTestHome,
  removeIsolatedTestHome,
} from "./isolated-test-home";

const registeredPath = process.env.SUBKIT_TEST_HOME;
const registeredToken = process.env.SUBKIT_TEST_HOME_TOKEN;
if ((registeredPath === undefined) !== (registeredToken === undefined)) {
  throw new Error("incomplete registered test home");
}
const ownedHome = registeredPath === undefined ? createIsolatedTestHome() : undefined;
const home = ownedHome?.path ?? claimIsolatedTestHome(registeredPath!, registeredToken!);
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.SUBKIT_TEST_HOME;
delete process.env.SUBKIT_TEST_HOME_TOKEN;

if (ownedHome) {
  let removed = false;
  const removeHome = () => {
    if (!removed) {
      removed = true;
      removeIsolatedTestHome(ownedHome);
    }
  };
  afterAll(removeHome);
  process.on("exit", removeHome);
}
