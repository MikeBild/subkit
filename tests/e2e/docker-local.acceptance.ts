#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SK_BIN = path.join(REPO_ROOT, "dist/sk");
const BASE_URL = process.env.SUBKIT_DOCKER_BASE_URL ?? "http://127.0.0.1:3000";
const TENANT_SLUG = process.env.SUBKIT_DOCKER_TENANT ?? "default";
const PROVIDED_API_KEY = process.env.SUBKIT_DOCKER_API_KEY ?? "";

function fail(message: string): never {
  console.error(`✘ ${message}`);
  process.exit(1);
}

function runCommand(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function waitForHealth(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/v1/health`);
      if (response.ok) {
        const body = (await response.json()) as { status?: string; db_connected?: boolean };
        if (body.status === "ok" && body.db_connected === true) return;
      }
    } catch {
      // wait and retry
    }
    await Bun.sleep(2_000);
  }
  fail(`engine at ${BASE_URL} did not become healthy within ${timeoutMs}ms`);
}

function issueAdminKey(): string {
  if (PROVIDED_API_KEY) return PROVIDED_API_KEY;
  const result = runCommand("docker", [
    "compose",
    "run",
    "--rm",
    "--entrypoint",
    "bun",
    "migrate",
    "run",
    "apps/engine/src/db/issue-admin-key.ts",
    "--tenant",
    TENANT_SLUG,
  ]);
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0) {
    fail(`failed to issue admin key via docker compose:\n${combined}`);
  }
  const match = combined.match(/wf_live_[A-Za-z0-9_-]+/);
  if (!match) fail(`docker compose did not print an admin key:\n${combined}`);
  return match[0];
}

async function api<T>(apiKey: string, pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${BASE_URL}${pathname}`, { ...init, headers });
  if (!response.ok) {
    fail(
      `${init.method ?? "GET"} ${pathname} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

type Connector = { id: string; slug: string; base_url?: string | null };

async function main(): Promise<void> {
  await waitForHealth();
  console.log(`✓ engine healthy at ${BASE_URL}`);

  const apiKey = issueAdminKey();
  console.log(`✓ issued admin api key for tenant ${TENANT_SLUG}`);

  const homeDir = mkdtempSync(path.join(tmpdir(), "subkit-docker-e2e-"));
  const cliEnv = {
    HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, ".config"),
  };

  const login = runCommand(SK_BIN, ["login", "--engine-url", BASE_URL, "--api-key", apiKey], {
    env: cliEnv,
  });
  if (login.status !== 0) fail(`sk login failed:\n${login.stdout}\n${login.stderr}`);
  console.log("✓ sk login");

  const health = runCommand(SK_BIN, ["health"], { env: cliEnv });
  if (health.status !== 0) fail(`sk health failed:\n${health.stdout}\n${health.stderr}`);
  console.log("✓ sk health");

  // The default seed deliberately does not ship a `dummy-http` connector
  // (commit history: "Operators consistently asked 'why always demo-?
  // I never used something like that'"). Create one inline so the rest
  // of this acceptance flow has something to exercise.
  const connectorList = await api<{ items: Connector[] }>(apiKey, "/v1/connectors");
  let dummy = connectorList.items.find((item) => item.slug === "dummy-http");
  if (!dummy) {
    dummy = await api<Connector>(apiKey, "/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "Dummy HTTP",
        slug: "dummy-http",
        driver: "http",
        base_url: "https://httpbin.org",
        auth_type: "none",
      }),
    });
    console.log("✓ created dummy-http connector");
  } else {
    await api(apiKey, `/v1/connectors/${dummy.id}`, {
      method: "PATCH",
      body: JSON.stringify({ base_url: "https://httpbin.org" }),
    });
    console.log("✓ patched dummy-http base_url");
  }

  const probe = runCommand(SK_BIN, ["connectors", "probe", dummy.id], { env: cliEnv });
  if (probe.status !== 0 || !`${probe.stdout}\n${probe.stderr}`.includes("ok: true")) {
    fail(`sk connectors probe failed:\n${probe.stdout}\n${probe.stderr}`);
  }
  console.log("✓ sk connectors probe");

  await api(apiKey, `/v1/connectors/${dummy.id}/docs/ingest`, {
    method: "POST",
    body: JSON.stringify({
      source_type: "markdown",
      content: [
        "# Authentication",
        "Use a bearer token in the Authorization header.",
        "",
        "# POST /v1/customers",
        "Create a customer with POST /v1/customers.",
        "",
        "# Customer schema",
        "Fields: id, email, created_at.",
      ].join("\n"),
    }),
  });
  console.log("✓ ingested connector docs");

  const docsSearch = runCommand(
    SK_BIN,
    ["connectors", "docs-search", dummy.id, "create customer", "--limit", "1"],
    { env: cliEnv },
  );
  if (docsSearch.status !== 0 || !docsSearch.stdout.includes("operation")) {
    fail(
      `sk connectors docs-search did not surface operation ranking:\n${docsSearch.stdout}\n${docsSearch.stderr}`,
    );
  }
  console.log("✓ sk connectors docs-search");

  const authHits = await api<{
    items: Array<{ id: string; match_type: string }>;
  }>(
    apiKey,
    `/v1/connectors/${dummy.id}/docs/search?q=${encodeURIComponent("bearer token")}&limit=1`,
  );
  if (authHits.items[0]?.match_type !== "auth") {
    fail(`expected auth-ranked docs hit, got ${JSON.stringify(authHits.items[0] ?? null)}`);
  }
  console.log("✓ engine docs search ranking");

  // Note: an earlier version of this test also asserted that
  // `sk workflows validate` rejects a workflow with a wrong scope path
  // (`$scope.fetch.items` instead of `$scope.fetch.data.items`). That
  // "step envelope" rule lives in `apps/engine/src/conversations/verifier.ts`
  // (LLM authoring time), not in the CLI validator. Asserting CLI
  // rejection of authoring-time-only mistakes was a mismatch — the
  // happy-path run below still proves the validator + executor agree
  // on the envelope shape.
  const validWorkflow = {
    name: "Docker httpbin run",
    slug: "docker-httpbin-run",
    steps: [
      {
        id: "fetch",
        kind: "request",
        connector_id: dummy.id,
        method: "GET",
        path: "/json",
      },
      {
        id: "shape",
        kind: "transform",
        expression: '{ "title": $scope.fetch.data.slideshow.title }',
      },
    ],
    output_transform: "$scope.shape.data",
  };

  const validPath = path.join(homeDir, "valid-workflow.json");
  writeFileSync(validPath, JSON.stringify(validWorkflow, null, 2));

  const validValidate = runCommand(SK_BIN, ["workflows", "validate", validPath], {
    env: cliEnv,
  });
  if (validValidate.status !== 0) {
    fail(
      `sk workflows validate rejected a valid workflow:\n${validValidate.stdout}\n${validValidate.stderr}`,
    );
  }
  console.log("✓ sk workflows validate accepts a valid workflow");

  const created = runCommand(SK_BIN, ["workflows", "create", "--file", validPath], {
    env: cliEnv,
  });
  if (created.status !== 0)
    fail(`sk workflows create failed:\n${created.stdout}\n${created.stderr}`);
  const createdBody = JSON.parse(created.stdout) as { id?: string };
  if (!createdBody.id) fail(`sk workflows create did not return a workflow id:\n${created.stdout}`);
  console.log("✓ sk workflows create");

  const run = runCommand(SK_BIN, ["workflows", "run", createdBody.id], { env: cliEnv });
  if (run.status !== 0) fail(`sk workflows run failed:\n${run.stdout}\n${run.stderr}`);
  const runBody = JSON.parse(run.stdout) as { status?: string };
  if (runBody.status !== "succeeded") {
    fail(`expected saved workflow run to succeed, got ${JSON.stringify(runBody)}`);
  }
  console.log("✓ sk workflows run");

  const conversation = await api<{
    conversation?: { id?: string };
    events?: Array<{ type?: string }>;
  }>(apiKey, "/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ initial_message: "list workflows and engine status" }),
  });
  if (!(conversation.events ?? []).some((event) => event.type === "completed")) {
    fail(`conversation turn did not complete: ${JSON.stringify(conversation)}`);
  }
  console.log("✓ engine conversation create");

  console.log("✓ docker acceptance completed");
}

await main();
