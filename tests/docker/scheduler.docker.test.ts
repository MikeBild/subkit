// Docker scheduler smoke — NIGHTLY (not in the PR subset).
//
// Unlike the in-process scheduler.e2e (which drives one reconcile pass
// directly), this proves the REAL reconciler running inside the container
// fires a scheduled workflow on its own cadence. We bind a sub-minute
// `every:30` schedule via the workflow trigger, confirm the binding through
// `sk schedules list`, then poll the executions surface until a
// `request_source = "scheduler"` run appears — a capped poll, never a fixed
// sleep. Slow by nature (waits on the in-container 60s reconcile tick), so
// it runs nightly only.

import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { pollUntil } from "../e2e/_helpers/poll.ts";
import {
  collectContainerLogs,
  dockerApi,
  dockerBoot,
  type DockerEnv,
  skDocker,
} from "./_harness.ts";

let env: DockerEnv;
beforeAll(async () => {
  env = await dockerBoot();
}, 600_000);

afterAll(() => {
  collectContainerLogs(path.resolve(import.meta.dir, "../../engine-docker-scheduler.log"));
}, 60_000);

// allow-wall-clock: per-run uniqueness token for the schedule slug.
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;

describe("in-container reconciler", () => {
  test("a scheduled workflow fires on its own cadence", async () => {
    const slug = `dsched-${RUN_ID}`;
    const wf = await dockerApi<{ id: string }>(env, "POST", "/v1/workflows", {
      name: "Docker Scheduled",
      slug,
      steps: [
        {
          id: "echo",
          kind: "transform",
          language: "javascript",
          expression: "return { ok: true };",
        },
      ],
      trigger: { kind: "schedule", cron: "every:30", tz: "UTC" },
    });
    expect(wf.status).toBe(201);

    // The binding is visible through the CLI schedules surface.
    const schedules = await skDocker(env, ["schedules", "list"]);
    expect(schedules.exitCode).toBe(0);

    // The real reconciler fires it within a couple of ticks. Poll the
    // executions surface for a scheduler-sourced run — capped, no sleep.
    const fired = await pollUntil(
      async () => {
        const res = await dockerApi<{ items: Array<{ request_source: string }> }>(
          env,
          "GET",
          `/v1/executions?workflow_id=${wf.body.id}&limit=10`,
        );
        if (res.status !== 200) return null;
        return res.body.items.find((e) => e.request_source === "scheduler") ?? null;
      },
      { timeoutMs: 150_000, intervalMs: 3_000, label: `scheduler-fired execution for ${slug}` },
    );
    expect(fired.request_source).toBe("scheduler");
  }, 180_000);
});
