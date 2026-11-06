import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import {
  docsIngestBody,
  importConnectorBody,
  probeFailureDetail,
  probeSummary,
} from "../commands/connectors.ts";
import type {
  ConnectorDocsIngestBody,
  ConnectorFromTemplateBody,
  ImportConnectorBody,
  UpdateConnectorBody,
} from "../engine-client/connectors.ts";

type Schemas = components["schemas"];

const TENANT_ID = "5eed0001-0000-4000-8000-000000000001";
const CONNECTOR_ID = "5eed0003-0000-4000-8000-000000000001";
const DOC_ID = "5eed0004-0000-4000-8000-000000000001";
const STAMP = "2026-11-06T00:00:00.000Z";

const connector = {
  id: CONNECTOR_ID,
  tenant_id: TENANT_ID,
  slug: "stripe",
  display_name: "Stripe",
  description: "Stripe payments",
  description_source: "human",
  category: "payments",
  category_source: "human",
  driver: "http",
  environment: "dev",
  auth_type: "bearer",
  base_url: "https://api.stripe.com",
  dsn: null,
  config: {},
  operator_quirks: {},
  template_slug: "stripe",
  template_name: "Stripe",
  template_source: "builtin",
  template_version: 1,
  template_snapshot: null,
  enabled: true,
  last_error: null,
  health_state: "ok",
  health_reason: null,
  health_error_code: null,
  circuit_state: "closed",
  circuit_opened_at: null,
  circuit_failure_count: 0,
  needs_reauth: false,
  auth_failed_at: null,
  auth_failed_reason: null,
  sign_in: null,
  created_at: STAMP,
  updated_at: STAMP,
  last_tested_at: null,
  tools_count: null,
} satisfies Schemas["Connector"];

const fromTemplate = {
  id: CONNECTOR_ID,
  tenant_id: TENANT_ID,
  slug: "stripe",
  display_name: "Stripe",
  driver: "http",
  environment: "dev",
  auth_type: "bearer",
  base_url: "https://api.stripe.com",
  dsn: null,
  config: {},
  template_slug: "stripe",
  template_name: "Stripe",
  template_source: "builtin",
  template_version: 1,
  template_snapshot: null,
  created_at: STAMP,
  updated_at: STAMP,
} satisfies Schemas["ConnectorFromTemplateResponse"];

const failedProbe = {
  ok: false,
  latency_ms: 42,
  status: 401,
  detail: "token rejected by upstream",
  error_code: "credential_invalid",
} satisfies Schemas["ConnectorProbeResult"];

const docsList = {
  items: [
    {
      id: DOC_ID,
      source_type: "openapi",
      source_uri: "https://docs.stripe.com/openapi.json",
      version: "1",
      bytes_total: 1024,
      chunk_count: 3,
      created_at: STAMP,
      updated_at: STAMP,
    },
  ],
} satisfies Schemas["ConnectorDocsListResponse"];

const ingested = {
  document_id: DOC_ID,
  ingested_count: 3,
  skipped_count: 0,
  total_bytes: 1024,
  budget_exceeded: false,
  source_type: "openapi",
  source_uri: "https://docs.stripe.com/openapi.json",
} satisfies Schemas["ConnectorDocsIngestResponse"];

interface Seen {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

let server: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.text();
      seen.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        body: text ? JSON.parse(text) : undefined,
      });
      const route = `${request.method} ${url.pathname}`;
      if (route === `POST /v1/connectors/${CONNECTOR_ID}/docs/ingest`)
        return Response.json(ingested);
      if (route === `GET /v1/connectors/${CONNECTOR_ID}/docs`) return Response.json(docsList);
      if (route === "POST /v1/connectors/from-template/stripe")
        return Response.json(fromTemplate, { status: 201 });
      if (route === `POST /v1/connectors/${CONNECTOR_ID}/test`) return Response.json(failedProbe);
      if (route === "POST /v1/connectors/import")
        return Response.json({ draft: { name: "Petstore", driver: "http" } });
      if (route === `PATCH /v1/connectors/${CONNECTOR_ID}`) return Response.json(connector);
      if (route === `GET /v1/connectors/${CONNECTOR_ID}`)
        return Response.json({ ...connector, config: { retries: 2, oauth: { scope: "read" } } });
      if (route === "POST /v1/connectors/validate")
        return Response.json({
          ok: true,
          issues: [],
        } satisfies Schemas["ValidateConnectorResponse"]);
      if (route === "GET /v1/connectors")
        return Response.json({
          items: [connector],
          total: 1,
          categories: [{ category: "payments", count: 1 }],
        } satisfies Schemas["ConnectorListResponse"]);
      return Response.json({ code: "not_found", message: "no route" }, { status: 404 });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

async function sk(args: string[]) {
  seen = [];
  const commandPath = new URL("../commands/connectors.ts", import.meta.url).pathname;
  const script = `import { runCommand } from "citty"; import { connectorsCommand } from ${JSON.stringify(commandPath)}; await runCommand(connectorsCommand, { rawArgs: ${JSON.stringify(args)} });`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      SUBKIT_ENGINE_URL: `http://127.0.0.1:${server.port}`,
      SUBKIT_API_KEY: "synthetic-cli-key",
      SUBKIT_TENANT: TENANT_ID,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      COLUMNS: "160",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr, seen };
}

describe("sk connectors request bodies match the engine contract", () => {
  test("docs-ingest sends the required source_type next to the url", async () => {
    const expected = {
      source_type: "openapi",
      url: "https://docs.stripe.com/openapi.json",
    } satisfies ConnectorDocsIngestBody;
    expect(docsIngestBody(expected.url, "openapi")).toEqual(expected);
    const run = await sk([
      "docs-ingest",
      CONNECTOR_ID,
      "--url",
      expected.url,
      "--source-type",
      "openapi",
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.seen).toEqual([
      {
        method: "POST",
        path: `/v1/connectors/${CONNECTOR_ID}/docs/ingest`,
        query: "",
        body: expected,
      },
    ]);
  });

  test("docs-ingest rejects a source type the contract does not know", () => {
    expect(() => docsIngestBody("https://x.test", "pdf")).toThrow(
      "--source-type must be one of: openapi | google_discovery | markdown | llms_txt",
    );
  });

  test("docs-list reads source_type and source_uri from the listed documents", async () => {
    const run = await sk(["docs-list", CONNECTOR_ID]);
    expect(run.exitCode).toBe(0);
    expect(run.seen.map((s) => `${s.method} ${s.path}${s.query}`)).toEqual([
      `GET /v1/connectors/${CONNECTOR_ID}/docs`,
    ]);
    expect(run.stdout).toContain("source_type");
    expect(run.stdout).toContain("source_uri");
    expect(run.stdout).toContain("https://docs.stripe.com/openapi.json");
  });

  test("create --template posts ConnectorFromTemplateBody and reports the probe's detail", async () => {
    const run = await sk(["create", "--template", "stripe", "--name", "Stripe"]);
    expect(run.exitCode).toBe(64);
    expect(run.seen.map((s) => ({ method: s.method, path: s.path, body: s.body }))).toEqual([
      {
        method: "POST",
        path: "/v1/connectors/from-template/stripe",
        body: { name: "Stripe" } satisfies ConnectorFromTemplateBody,
      },
      { method: "POST", path: `/v1/connectors/${CONNECTOR_ID}/test`, body: undefined },
    ]);
    expect(`${run.stdout}${run.stderr}`).toContain("token rejected by upstream");
  });

  test("import sends the contract environment explicitly", async () => {
    const expected = {
      source: "openapi",
      content: '{"openapi":"3.0.0"}',
      environment: "dev",
    } satisfies ImportConnectorBody;
    expect(importConnectorBody({ source: "openapi", content: expected.content })).toEqual(expected);
    const run = await sk([
      "import",
      "--spec",
      expected.content,
      "--source",
      "openapi",
      "--dry-run",
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.seen.map((s) => s.body)).toEqual([expected]);
  });

  test("import rejects a source the contract does not know", () => {
    expect(() => importConnectorBody({ source: "wsdl", content: "x" })).toThrow(
      "--source must be one of",
    );
    expect(() =>
      importConnectorBody({ source: "curl", content: "x", environment: "staging" }),
    ).toThrow("--environment must be dev or prod");
  });

  test("patch sends UpdateConnectorBody fields only", async () => {
    const run = await sk([
      "patch",
      CONNECTOR_ID,
      "--name",
      "Stripe Live",
      "--description",
      "Charges and refunds",
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.seen.map((s) => s.body)).toEqual([
      { description: "Charges and refunds", name: "Stripe Live" } satisfies UpdateConnectorBody,
    ]);
  });

  test("patch --file validates the whole definition and sends the merged UpdateConnectorBody", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-connector-patch-"));
    const file = join(dir, "patch.json");
    writeFileSync(
      file,
      JSON.stringify({ config: { oauth: { scope: "write" } } } satisfies UpdateConnectorBody),
    );
    try {
      const run = await sk(["patch", CONNECTOR_ID, "--file", file, "--json"]);
      expect(run.exitCode).toBe(0);
      expect(run.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
        `GET /v1/connectors/${CONNECTOR_ID}`,
        "POST /v1/connectors/validate",
        `PATCH /v1/connectors/${CONNECTOR_ID}`,
      ]);
      const config = { retries: 2, oauth: { scope: "write" } };
      expect(run.seen[1]?.body).toEqual({
        name: "Stripe",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        config,
        base_url: "https://api.stripe.com",
      } satisfies Schemas["CreateConnectorBody"]);
      expect(run.seen[2]?.body).toEqual({ config } satisfies UpdateConnectorBody);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sk connectors list reads the contract Connector", () => {
  test("the name column shows display_name", async () => {
    const run = await sk(["list", "--flat", "--limit", "5"]);
    expect(run.exitCode).toBe(0);
    expect(run.seen.map((s) => `${s.method} ${s.path}${s.query}`)).toEqual([
      "GET /v1/connectors?limit=5",
    ]);
    expect(run.stdout).toContain("Stripe");
    expect(run.stdout).toContain("1 connector total");
  });
});

describe("probe result mapping reads the contract fields", () => {
  test("status and latency_ms feed the summary", () => {
    expect(probeSummary(failedProbe)).toEqual({ ok: false, status_code: 401, duration_ms: 42 });
    expect(probeSummary({ ok: true, latency_ms: 5 })).toEqual({ ok: true, duration_ms: 5 });
  });

  test("the failure detail prefers detail, then error_code, then the status", () => {
    expect(probeFailureDetail(failedProbe)).toBe("token rejected by upstream");
    expect(probeFailureDetail({ ok: false, latency_ms: 1, error_code: "credential_missing" })).toBe(
      "credential_missing",
    );
    expect(probeFailureDetail({ ok: false, latency_ms: 1, status: 500 })).toBe("status=500");
    expect(probeFailureDetail({ ok: false, latency_ms: 1 })).toBe("status=?");
  });
});
