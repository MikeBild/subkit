import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { runCommand } from "citty";
import { auditLogQuery } from "../../commands/audit.ts";
import { AUDIT_EVENT_COLUMNS, auditEventsQuery, eventsCommand } from "../../commands/events.ts";
import { hooksCommand } from "../../commands/hooks.ts";
import {
  buildCreateChannelBody,
  buildCreateRuleBody,
  buildInboxQuery,
  NOTIFICATION_CHANNEL_COLUMNS,
  notificationSeverity,
  notificationsCommand,
} from "../../commands/notifications.ts";
import { PATCH_CANDIDATE_COLUMNS } from "../../commands/patch-candidates.ts";
import { scanListQuery } from "../../commands/self-healing.ts";
import { workflowDefinition } from "../../commands/workflows.ts";
import type { AuditLogQuery } from "../../engine-client/diagnostics.ts";
import type { NotificationInboxQuery } from "../../engine-client/events.ts";
import { EngineClient, type FetchLike } from "../../engine-client.ts";

type Schemas = components["schemas"];

const ENV_KEYS = ["SUBKIT_ENGINE_URL", "SUBKIT_API_KEY", "SUBKIT_TENANT"] as const;

interface Captured {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

const TENANT = "22222222-2222-4222-8222-222222222222";
const TS = "2026-11-06T10:00:00.000Z";

const auditEntry = {
  id: "33333333-3333-4333-8333-333333333333",
  ts: TS,
  tenant_id: TENANT,
  actor_type: "user",
  actor_id: "44444444-4444-4444-8444-444444444444",
  api_key_id: null,
  session_id: null,
  recorded_api_key_id: null,
  recorded_session_id: null,
  access_type: "api_key",
  oauth_client_id: null,
  credential_origin: null,
  request_source: "cli",
  origin_source: "cli",
  execution_source: "api",
  execution_id: null,
  conversation_id: null,
  workflow_id: null,
  changed_fields: [],
  changes: [],
  action: "workflow.create",
  resource_type: "workflow",
  resource_id: null,
  resource_name: null,
  task_id: null,
  task_run_id: null,
  result: "success",
  trace_id: null,
  correlation_id: null,
  ip: null,
  user_agent: null,
  reason: null,
  reason_redacted: false,
  details: {},
  metadata: {},
} satisfies Schemas["AuditEntry"];

const notificationChannel = {
  id: "ch-1",
  tenant_id: TENANT,
  workspace_id: "T0123456",
  channel_id: "C0ALERTS",
  platform: "slack",
  default_severity: "info",
  rate_limit_per_minute: 60,
  circuit_state: "closed",
  circuit_open_until: null,
  consecutive_failures: 0,
  active: true,
  created_at: TS,
  updated_at: TS,
} satisfies Schemas["NotificationChannel"];

const patchCandidate = {
  id: "55555555-5555-4555-8555-555555555555",
  tenant_id: TENANT,
  workflow_id: "66666666-6666-4666-8666-666666666666",
  workflow_name: "Daily digest",
  connector_id: null,
  endpoint_key: null,
  classification: "safe",
  status: "proposed",
  fixture_id: null,
  closed_reason: null,
  closed_against_version_id: null,
  closed_at: null,
  created_at: TS,
  updated_at: TS,
} satisfies Schemas["PatchCandidate"];

const webhookInbound = {
  id: "77777777-7777-4777-8777-777777777777",
  tenant_id: TENANT,
  slug: "orders",
  workflow_id: "66666666-6666-4666-8666-666666666666",
  verifier: "github",
  active: true,
  origin: "crud",
  created_at: TS,
  updated_at: TS,
} satisfies Schemas["WebhookInbound"];

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;
let origFetch: typeof globalThis.fetch;
let origStdout: typeof process.stdout.write;
let origStderr: typeof process.stderr.write;
let stdout: string;
let calls: Captured[];
let reply: unknown;

function capture(input: RequestInfo | URL, init?: RequestInit): Captured {
  const url = new URL(String(input));
  const raw = typeof init?.body === "string" ? init.body : undefined;
  return {
    method: init?.method ?? "GET",
    path: url.pathname,
    search: url.searchParams,
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: raw ? JSON.parse(raw) : undefined,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientReplying(body: unknown, seen: Captured[]): EngineClient {
  const fetchImpl: FetchLike = async (input, init) => {
    seen.push(capture(input, init));
    return json(body);
  };
  return new EngineClient({ engine_url: "http://engine.test", api_key: "k", fetchImpl });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-ops-contract-"));
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SUBKIT_ENGINE_URL = "http://engine.test";
  process.env.SUBKIT_API_KEY = "wf_live_test_key_xxxxxxxxxxxxxxxxxxxxx";
  calls = [];
  reply = {};
  origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(capture(input, init));
    return json(reply);
  }) as typeof globalThis.fetch;
  stdout = "";
  origStdout = process.stdout.write.bind(process.stdout);
  origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("sk events list reads the audit log", () => {
  test("since and action become the audit-log ts_from and action filters", () => {
    const expected = {
      limit: 5,
      ts_from: TS,
      action: "workflow.create",
    } satisfies AuditLogQuery;
    expect(auditEventsQuery({ limit: "5", since: TS, action: "workflow.create" })).toEqual(
      expected,
    );
    expect(auditEventsQuery({})).toEqual({});
  });

  test("the command calls GET /v1/audit-log and prints audit columns", async () => {
    reply = { items: [auditEntry], next_cursor: null } satisfies Schemas["AuditLogListResponse"];
    await runCommand(eventsCommand, {
      rawArgs: ["list", "--limit", "5", "--since", TS, "--action", "workflow.create"],
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/audit-log"]);
    expect(Object.fromEntries(calls[0]?.search ?? [])).toEqual({
      limit: "5",
      ts_from: TS,
      action: "workflow.create",
    });
    for (const column of AUDIT_EVENT_COLUMNS) expect(auditEntry).toHaveProperty(column);
    expect(stdout).toContain("workflow.create");
    expect(stdout).toContain(auditEntry.actor_id);
  });
});

describe("sk notifications against the contract", () => {
  test("channel list columns exist on NotificationChannel", async () => {
    for (const column of NOTIFICATION_CHANNEL_COLUMNS) {
      expect(notificationChannel).toHaveProperty(column);
    }
    reply = { items: [notificationChannel] } satisfies Schemas["NotificationChannelListResponse"];
    await runCommand(notificationsCommand, { rawArgs: ["channels", "list"] });
    expect(stdout).toContain("C0ALERTS");
    expect(stdout).toContain("slack");
  });

  test("channel create posts the CreateNotificationChannelBody", async () => {
    reply = notificationChannel;
    await runCommand(notificationsCommand, {
      rawArgs: [
        "channels",
        "create",
        "--platform",
        "slack",
        "--workspace-id",
        "T0123456",
        "--channel-id",
        "C0ALERTS",
        "--severity",
        "warn",
        "--rate-limit",
        "30",
      ],
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/notifications/channels"]);
    expect(calls[0]?.body).toEqual({
      platform: "slack",
      workspace_id: "T0123456",
      channel_id: "C0ALERTS",
      default_severity: "warn",
      rate_limit_per_minute: 30,
    } satisfies Schemas["CreateNotificationChannelBody"]);
  });

  test("rule create builds the CreateNotificationRuleBody", () => {
    expect(
      buildCreateRuleBody({
        event: "execution.*",
        "workspace-id": "T1",
        "channel-id": "C1",
        severity: "error",
      }),
    ).toEqual({
      name: "execution.*",
      event_pattern: "execution.*",
      target_workspace_id: "T1",
      target_channel_id: "C1",
      severity: "error",
    } satisfies Schemas["CreateNotificationRuleBody"]);
  });

  test("a severity outside the contract enum is refused before sending", () => {
    expect(notificationSeverity("critical")).toBe("critical");
    expect(() => notificationSeverity("loud")).toThrow(
      "--severity must be one of debug, info, warn, error, critical",
    );
    expect(() =>
      buildCreateChannelBody({
        platform: "slack",
        "workspace-id": "T1",
        "channel-id": "C1",
        severity: "loud",
      }),
    ).toThrow("--severity");
  });

  test('inbox flags are sent as the contract\'s "true" strings', async () => {
    const query = buildInboxQuery({ all: true, unread: true, actionable: true, limit: "10" });
    expect(query).toEqual({
      limit: 10,
      unread_only: "true",
      actionable_only: "true",
    } satisfies NotificationInboxQuery);
    const seen: Captured[] = [];
    const client = clientReplying(
      { items: [], cursor: 0, unread_count: 0, actionable_unread_count: 0 },
      seen,
    );
    await client.getNotificationInbox(query);
    expect(seen[0]?.path).toBe("/v1/notifications/inbox");
    expect(Object.fromEntries(seen[0]?.search ?? [])).toEqual({
      limit: "10",
      unread_only: "true",
      actionable_only: "true",
    });
  });
});

describe("sk hooks create against the contract", () => {
  test("posts the CreateWebhookInboundBody with the secret read from the file", async () => {
    const secretFile = join(tmpDir, "secret.txt");
    writeFileSync(secretFile, "s3cret\n");
    reply = webhookInbound;
    await runCommand(hooksCommand, {
      rawArgs: [
        "create",
        "--slug",
        "orders",
        "--workflow-id",
        webhookInbound.workflow_id,
        "--verifier",
        "github",
        "--secret-file",
        secretFile,
      ],
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/webhooks/inbound"]);
    expect(calls[0]?.body).toEqual({
      slug: "orders",
      workflow_id: webhookInbound.workflow_id,
      verifier: "github",
      secret: "s3cret",
    } satisfies Schemas["CreateWebhookInboundBody"]);
  });
});

describe("patch candidates and self-healing against the contract", () => {
  test("list columns exist on PatchCandidate", () => {
    for (const column of PATCH_CANDIDATE_COLUMNS) expect(patchCandidate).toHaveProperty(column);
    expect(PATCH_CANDIDATE_COLUMNS).not.toContain("summary");
  });

  test("preview reads the typed preview route", async () => {
    const seen: Captured[] = [];
    await clientReplying({}, seen).previewPatchCandidate(patchCandidate.id);
    expect(seen.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v1/patch-candidates/${patchCandidate.id}/preview`,
    ]);
  });

  test("scan list filters stay inside the contract enums", () => {
    expect(scanListQuery({ limit: "20", status: "failed", source: "mcp" })).toEqual({
      limit: 20,
      status: "failed",
      source: "mcp",
    });
    expect(() => scanListQuery({ limit: "20", source: "cron" })).toThrow(
      "--source must be one of scheduler, admin_http, mcp",
    );
  });

  test("a scan keeps its idempotency-key header and sends the SelfHealingScanRequest", async () => {
    const seen: Captured[] = [];
    const client = clientReplying(
      {
        scan_id: "scan-1",
        signals_detected: 0,
        candidates_created: 0,
        unanchored_detected: 0,
        duration_ms: 3,
        candidates: [],
        unanchored: [],
      } satisfies Schemas["SelfHealingScanResponse"],
      seen,
    );
    await client.triggerSelfHealingScan({ workflow_id: "wf-1" }, { idempotencyKey: "key-1" });
    expect(seen[0]?.path).toBe("/v1/self-healing/scans");
    expect(seen[0]?.headers["idempotency-key"]).toBe("key-1");
    expect(seen[0]?.body).toEqual({
      workflow_id: "wf-1",
    } satisfies Schemas["SelfHealingScanRequest"]);
  });
});

describe("audit and workflow bodies against the contract", () => {
  test("audit filters map onto the typed audit-log query", () => {
    expect(
      auditLogQuery({ action: "workflow.create", actor_type: "user", result: "denied" }),
    ).toEqual({
      action: "workflow.create",
      actor_type: "user",
      result: "denied",
    } satisfies AuditLogQuery);
    expect(() => auditLogQuery({ result: "maybe" })).toThrow(
      "--result must be one of success, denied, error",
    );
  });

  test("a workflow file needs the name and steps the contract requires", () => {
    const body = { name: "Digest", steps: [{ id: "a", kind: "http" }] };
    expect(workflowDefinition(body)).toBe(body);
    expect(() => workflowDefinition({ steps: [] })).toThrow("needs a name and a steps array");
    expect(() => workflowDefinition({ name: "x" })).toThrow("needs a name and a steps array");
  });

  test("restore posts to the typed restore route", async () => {
    const seen: Captured[] = [];
    await clientReplying({}, seen).restoreWorkflowVersion("wf/1", 3);
    expect(seen.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/workflows/wf%2F1/restore/3",
    ]);
  });
});
