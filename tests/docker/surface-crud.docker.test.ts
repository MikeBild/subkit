// Docker surface CRUD smoke — gate-critical (runs on every PR).
//
// Exercises the core author→connect→verify→execute surfaces over the wire
// against the production container: connector create+probe+call, workflow
// save+version, knowledge inline ingest+search, and a deterministic saved
// execution. Outcome-based (the container runs the mock provider and Track B
// cannot pin tool sequences). Shares the container with bootstrap.docker via
// the idempotent dockerBoot (POST /v1/setup → 410 → issue-admin-key path).

import { beforeAll, describe, expect, test } from "bun:test";
import { pollUntil } from "../e2e/_helpers/poll.ts";
import { type DockerEnv, dockerApi, dockerBoot, skDocker } from "./_harness.ts";

let env: DockerEnv;
beforeAll(async () => {
  env = await dockerBoot();
}, 600_000);

// Teardown is owned by the CI job (`compose:test:down`, if:always) so the
// container is shared across both docker test files in one run.

// Unique per run so re-runs against a persistent container volume (local
// dev without a teardown between runs) never collide on slugs. CI always
// starts from a fresh `compose:test:up`, but self-idempotence is cheap.
// allow-wall-clock: per-run uniqueness token for slugs against a persistent volume.
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
let suffix = 0;
function uniq(prefix: string): string {
  suffix += 1;
  return `${prefix}-${RUN_ID}-${suffix}`;
}

describe("connectors over the wire", () => {
  test("create → /test probe → /call against the container's own health", async () => {
    const slug = uniq("dconn");
    const created = await dockerApi<{ id: string }>(env, "POST", "/v1/connectors", {
      name: "Docker Self",
      slug,
      driver: "http",
      auth_type: "none",
      // Probe + call run INSIDE the engine, so target the in-container URL.
      base_url: "http://127.0.0.1:3000",
    });
    expect(created.status).toBe(201);

    const probe = await dockerApi<{ ok: boolean; latency_ms: number }>(
      env,
      "POST",
      `/v1/connectors/${created.body.id}/test`,
    );
    expect(probe.status).toBe(200);
    expect(typeof probe.body.ok).toBe("boolean");

    // /call routing + auth + driver wiring is exercised; the production
    // egress guard blocks calling the engine's own loopback address (an
    // SSRF protection), so a structured 422 is as valid as a 200 here. The
    // deeper "call returns upstream 200" assertion lives in the in-process
    // connectors-surface e2e where loopback is permitted.
    const call = await dockerApi<{ status?: number }>(
      env,
      "POST",
      `/v1/connectors/${created.body.id}/call`,
      {
        method: "GET",
        path: "/health",
      },
    );
    expect([200, 422]).toContain(call.status);
  }, 60_000);
});

describe("workflows over the wire", () => {
  test("save → history shows a version → sk workflows list sees it", async () => {
    const slug = uniq("dwf");
    const created = await dockerApi<{ id: string }>(env, "POST", "/v1/workflows", {
      name: "Docker WF",
      slug,
      steps: [
        {
          id: "echo",
          kind: "transform",
          language: "javascript",
          expression: "return { ok: true };",
        },
      ],
    });
    expect(created.status).toBe(201);

    const hist = await dockerApi<{ items?: unknown[] } | unknown[]>(
      env,
      "GET",
      `/v1/workflows/${created.body.id}/history`,
    );
    expect(hist.status).toBe(200);

    // The CLI list renders a table keyed by id + name (not slug), so assert
    // the created workflow's id appears — proving the host `sk` binary read
    // it back from the container over the wire.
    const list = await skDocker(env, ["workflows", "list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain(created.body.id);
  }, 60_000);
});

describe("knowledge sources over the wire", () => {
  test("inline ingest → search finds the chunk", async () => {
    const slug = uniq("dkb");
    const token = `dzmark${slug.replace(/[^a-z0-9]/g, "")}`;
    const created = await dockerApi<{ id: string }>(env, "POST", "/v1/knowledge-sources/inline", {
      name: `Docker KB ${slug}`,
      tags: ["docker", "smoke"],
      content: `# Docker runbook\n\nThe marker is ${token}.`,
    });
    expect(created.status).toBe(201);

    const hit = await pollUntil(
      async () => {
        const res = await dockerApi<{ hits: Array<{ knowledge_source_id: string }> }>(
          env,
          "GET",
          `/v1/knowledge-sources/search?q=${token}&limit=10`,
        );
        if (res.status !== 200) return null;
        return res.body.hits.find((h) => h.knowledge_source_id === created.body.id) ?? null;
      },
      { timeoutMs: 30_000, label: `docker knowledge search ${token}` },
    );
    expect(hit.knowledge_source_id).toBe(created.body.id);
  }, 60_000);
});

describe("executions over the wire", () => {
  test("saved transform workflow runs to a terminal status", async () => {
    const slug = uniq("dexec");
    const wf = await dockerApi<{ id: string }>(env, "POST", "/v1/workflows", {
      name: "Docker Exec",
      slug,
      steps: [
        {
          id: "echo",
          kind: "transform",
          language: "javascript",
          expression: "return { ok: true, value: input.input ?? null };",
        },
      ],
    });
    expect(wf.status).toBe(201);

    const run = await dockerApi<{
      execution_id: string;
      status: string;
      output?: { ok?: boolean };
    }>(env, "POST", "/v1/executions", {
      source: "saved",
      workflow_id: wf.body.id,
      input: { ping: 1 },
    });
    expect([200, 201]).toContain(run.status);
    expect(run.body.output?.ok).toBe(true);
  }, 60_000);
});
