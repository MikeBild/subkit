// Docker REPL smoke — NIGHTLY (not in the PR subset).
//
// Drives the host-built `sk` REPL over a PTY against the production
// container: boots to the quick-start banner and exits cleanly. Proves the
// compiled binary + Ink/readline wiring + network auth work against the
// packaged image (vs the in-process repl-conversational e2e). Nightly
// because it spawns a real pseudo-terminal and is slower / more exotic than
// the HTTP smoke.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { runPtyScenario, SKIP_PTY_WHEN_NO_EXPECT } from "../e2e/_helpers/pty.ts";
import { exit, quickStartReady } from "../e2e/_helpers/pty-steps.ts";
import { collectContainerLogs, type DockerEnv, dockerBoot } from "./_harness.ts";

let env: DockerEnv;
beforeAll(async () => {
  env = await dockerBoot();
}, 600_000);

afterAll(() => {
  collectContainerLogs(path.resolve(import.meta.dir, "../../engine-docker-repl.log"));
}, 60_000);

const HOME = path.resolve(import.meta.dir, "../../.docker-repl-home");

describe("sk REPL against the container", () => {
  // Skip only when `expect` is missing AND not in CI; in CI a missing
  // `expect` fails loudly instead of dropping coverage. See
  // SKIP_PTY_WHEN_NO_EXPECT in _helpers/pty.ts.
  test.skipIf(SKIP_PTY_WHEN_NO_EXPECT)(
    "boots to the quick-start banner over a PTY and exits cleanly",
    async () => {
      const result = await runPtyScenario([quickStartReady(), exit()], {
        engineUrl: env.baseUrl,
        env: {
          SUBKIT_API_KEY: env.adminKey,
          SUBKIT_ENGINE_URL: env.baseUrl,
          HOME,
          XDG_CONFIG_HOME: HOME,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.visible).not.toContain("HTTP 500");
      expect(result.visible).not.toContain("internal_error");
    },
    60_000,
  );
});
