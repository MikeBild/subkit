// Docker bootstrap smoke — gate-critical (runs on every PR).
//
// Proves the production image boots against external PostgreSQL, migrates, passes
// its own healthcheck, completes first-run onboarding (POST /v1/setup), and
// answers both `sk` and HTTP over the published port. Catches Dockerfile /
// entrypoint / binary-packaging / PostgreSQL-connectivity / binding regressions
// the in-process e2e track structurally cannot see.

import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  collectContainerLogs,
  dockerApi,
  dockerBoot,
  type DockerEnv,
  issueAdminKeyViaExec,
  skDocker,
} from "./_harness.ts";

let env: DockerEnv;
beforeAll(async () => {
  env = await dockerBoot();
}, 600_000); // image build + PostgreSQL startup on a cold runner.

// Container teardown is owned by the CI job (`compose:test:down`, if:always)
// so it survives across both docker test files in one run. We only snapshot
// the engine's ndjson log here for the failure artifact.
afterAll(() => {
  collectContainerLogs(path.resolve(import.meta.dir, "../../engine-docker.log"));
}, 60_000);

describe("container bootstrap", () => {
  test("health and readiness implement the family contract", async () => {
    const res = await dockerApi<{ status: string; service: string; version: string }>(
      env,
      "GET",
      "/health",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", service: "subkit" });
    const ready = await dockerApi<{ status: string; checks: { database: string } }>(
      env,
      "GET",
      "/ready",
    );
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "ready", checks: { database: "pass" } });
  });

  test("first-run onboarding minted a wf_live_ admin key", () => {
    expect(env.adminKey).toMatch(/^wf_live_/);
  });

  test("sk health + sk status answer against the container", async () => {
    const health = await skDocker(env, ["health"]);
    expect(health.exitCode).toBe(0);
    const status = await skDocker(env, ["status"]);
    expect(status.exitCode).toBe(0);
  }, 60_000);

  test("diagnostics version endpoint responds to the admin key", async () => {
    const res = await dockerApi(env, "GET", "/v1/diagnostics/version");
    expect(res.status).toBe(200);
  });

  test("the operator engine --issue-admin-key path mints an additional key", () => {
    const issued = issueAdminKeyViaExec("default");
    expect(issued.status).toBe(0);
    expect(`${issued.stdout}\n${issued.stderr}`).toMatch(/wf_live_[A-Za-z0-9_-]+/);
  }, 60_000);
});
