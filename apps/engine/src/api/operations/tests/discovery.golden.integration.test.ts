import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { auditLog, discoveryArtifacts, discoveryRuns, users } from "../../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../../http/tests/setup.ts";
import { createRole, grantPermissionToRole } from "../../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/discovery.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let deniedKey: string;
let readerKey: string;
let runId: string;
let connectorId: string;
let skillId: string;
let gapId: string;

function uuidName(uuid: string): string {
  if (uuid === MISSING) return "<missing>";
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function scrub(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"');
}

function record(name: string, value: unknown): void {
  actual[name] = scrub(value).replace(UUID, uuidName);
  expect(actual[name]).toBe(golden[name] as string);
}

function recordRows(name: string, rows: readonly unknown[]): void {
  actual[name] = JSON.stringify(rows.map((row) => scrub(row).replace(UUID, "<id>")).sort());
  expect(actual[name]).toBe(golden[name] as string);
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  key = ctx.apiKey,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: parseBody(await res.text()) };
}

async function upload(path: string, form: FormData, key = ctx.apiKey) {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  return { status: res.status, body: parseBody(await res.text()) };
}

function auditRows(where: ReturnType<typeof eq>) {
  return ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, ctx.tenantId), where));
}

async function mintKey(user_id: string, seed: number): Promise<string> {
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  await ctx.testDb.pool.query(
    "INSERT INTO subkit.api_keys (tenant_id, user_id, prefix, token_sha256, scopes) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [
      ctx.tenantId,
      user_id,
      key.slice(0, 12),
      createHash("sha256").update(key).digest("hex"),
      JSON.stringify(["*"]),
    ],
  );
  return key;
}

async function seedUser(email: string, role_id: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({ tenant_id: ctx.tenantId, email, role_id })
    .returning();
  if (!row) throw new Error("user insert returned no row");
  return row.id;
}

async function seedArtifact(values: Omit<typeof discoveryArtifacts.$inferInsert, "tenant_id">) {
  const [row] = await ctx.db
    .insert(discoveryArtifacts)
    .values({ tenant_id: ctx.tenantId, ...values })
    .returning({ id: discoveryArtifacts.id });
  if (!row) throw new Error("artifact insert returned no row");
  return row.id;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("operations_discovery_golden");
  deniedKey = await mintKey(
    await seedUser(
      "denied-discovery-operations@test.local",
      await emptyRoleId(ctx.db, ctx.tenantId),
    ),
    0x4d_01,
  );
  const readerRole = await createRole(ctx.db, ctx.tenantId, "discovery-reader");
  await grantPermissionToRole(ctx.db, ctx.tenantId, readerRole.id, "discovery:read");
  readerKey = await mintKey(
    await seedUser("reader-discovery-operations@test.local", readerRole.id),
    0x4d_02,
  );
  const [run] = await ctx.db
    .insert(discoveryRuns)
    .values({ tenant_id: ctx.tenantId, label: "Golden run", status: "completed", file_count: 2 })
    .returning({ id: discoveryRuns.id });
  if (!run) throw new Error("run insert returned no row");
  runId = run.id;
  await ctx.db
    .insert(discoveryRuns)
    .values({ tenant_id: ctx.tenantId, label: "Pending run", status: "pending" });
  connectorId = await seedArtifact({
    run_id: runId,
    kind: "connector",
    title: "Widgets API",
    description: "REST connector for Widgets",
    draft: { name: "Widgets", driver: "http", base_url: "https://api.widgets.test" },
    evidence: {
      file_ids: [],
      excerpts: [{ file_id: "", filename: "spec.json", text: "openapi 3.0" }],
    },
    confidence: 90,
  });
  skillId = await seedArtifact({
    run_id: runId,
    kind: "skill",
    title: "Idempotency Rule",
    draft: { scope: "global", title: "Idempotency", body: "Always include header" },
    evidence: { file_ids: [], excerpts: [] },
    confidence: 70,
  });
  gapId = await seedArtifact({
    run_id: runId,
    kind: "capability_gap",
    title: "Switch authoring mode",
    draft: {
      requested: "Switch from connector to workflow authoring",
      missing_capability: "surface.authoring_mode_switch",
      suggested_kind: "unknown",
      fingerprint: "golden-gap",
      occurrences: 3,
      conversation_id: null,
    },
    evidence: { file_ids: [], excerpts: [] },
  });
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("discovery operations keep their HTTP responses byte for byte", () => {
  test("runs", async () => {
    record("http.runs.list", await http("GET", "/v1/discovery/runs"));
    record("http.runs.list.status", await http("GET", "/v1/discovery/runs?status=completed"));
    record("http.runs.list.page", await http("GET", "/v1/discovery/runs?limit=1&offset=1"));
    record("http.runs.list.invalid", await http("GET", "/v1/discovery/runs?limit=0&status=x"));
    record("http.runs.get", await http("GET", `/v1/discovery/runs/${runId}`));
    record("http.runs.get.missing", await http("GET", `/v1/discovery/runs/${MISSING}`));
    record("http.runs.get.invalid", await http("GET", "/v1/discovery/runs/nope"));
  });

  test("artifacts", async () => {
    record("http.artifacts.list", await http("GET", `/v1/discovery/runs/${runId}/artifacts`));
    record(
      "http.artifacts.list.filter",
      await http("GET", `/v1/discovery/runs/${runId}/artifacts?kind=skill&status=proposed`),
    );
    record(
      "http.artifacts.list.page",
      await http("GET", `/v1/discovery/runs/${runId}/artifacts?limit=1&offset=1`),
    );
    record(
      "http.artifacts.list.missing",
      await http("GET", `/v1/discovery/runs/${MISSING}/artifacts`),
    );
    record(
      "http.artifacts.list.invalid",
      await http("GET", `/v1/discovery/runs/${runId}/artifacts?kind=nope`),
    );
    record("http.artifacts.get", await http("GET", `/v1/discovery/artifacts/${connectorId}`));
    record("http.artifacts.get.missing", await http("GET", `/v1/discovery/artifacts/${MISSING}`));
    record("http.artifacts.get.invalid", await http("GET", "/v1/discovery/artifacts/nope"));
  });

  test("approve and reject", async () => {
    record("http.approve", await http("POST", `/v1/discovery/artifacts/${connectorId}/approve`));
    record(
      "http.approve.again",
      await http("POST", `/v1/discovery/artifacts/${connectorId}/approve`),
    );
    record(
      "http.approve.missing",
      await http("POST", `/v1/discovery/artifacts/${MISSING}/approve`),
    );
    record("http.approve.invalid", await http("POST", "/v1/discovery/artifacts/nope/approve"));
    record(
      "http.reject",
      await http("POST", `/v1/discovery/artifacts/${skillId}/reject`, {
        reason: "Already covered by existing skill",
      }),
    );
    record(
      "http.reject.again",
      await http("POST", `/v1/discovery/artifacts/${skillId}/reject`, {}),
    );
    record(
      "http.reject.missing",
      await http("POST", `/v1/discovery/artifacts/${MISSING}/reject`, {}),
    );
    record(
      "http.reject.invalid",
      await http("POST", `/v1/discovery/artifacts/${MISSING}/reject`, { reason: 7 }),
    );
    record("http.reject.get", await http("GET", `/v1/discovery/artifacts/${skillId}`));
  });

  test("capability gaps", async () => {
    record("http.gaps.list", await http("GET", "/v1/discovery/capability-gaps"));
    record(
      "http.gaps.list.status",
      await http("GET", "/v1/discovery/capability-gaps?status=proposed&limit=5"),
    );
    record("http.gaps.list.invalid", await http("GET", "/v1/discovery/capability-gaps?limit=999"));
    record(
      "http.gaps.resolve.empty",
      await http("POST", `/v1/discovery/capability-gaps/${gapId}/resolve`, { note: "  " }),
    );
    record(
      "http.gaps.resolve",
      await http("POST", `/v1/discovery/capability-gaps/${gapId}/resolve`, {
        note: "Mode switch shipped.",
      }),
    );
    record(
      "http.gaps.resolve.again",
      await http("POST", `/v1/discovery/capability-gaps/${gapId}/resolve`, { note: "again" }),
    );
    record(
      "http.gaps.resolve.missing",
      await http("POST", `/v1/discovery/capability-gaps/${MISSING}/resolve`, { note: "x" }),
    );
  });

  test("raw upload routes keep their gate and validation", async () => {
    const empty = new FormData();
    empty.append("label", "Empty");
    record("http.upload.files.empty", await upload("/v1/discovery/runs", empty));
    const noArchive = new FormData();
    noArchive.append("label", "No archive");
    record(
      "http.upload.archive.missing",
      await upload("/v1/discovery/runs/from-archive", noArchive),
    );
    for (const [who, key] of [
      ["denied", deniedKey],
      ["reader", readerKey],
    ] as const) {
      record(`http.${who}.upload.files`, await upload("/v1/discovery/runs", new FormData(), key));
      record(
        `http.${who}.upload.archive`,
        await upload("/v1/discovery/runs/from-archive", new FormData(), key),
      );
    }
  });

  test("permissions are checked", async () => {
    const probes: [string, string, string, unknown?][] = [
      ["runs.list", "GET", "/v1/discovery/runs"],
      ["runs.get", "GET", `/v1/discovery/runs/${runId}`],
      ["artifacts.list", "GET", `/v1/discovery/runs/${runId}/artifacts`],
      ["artifacts.get", "GET", `/v1/discovery/artifacts/${connectorId}`],
      ["approve", "POST", `/v1/discovery/artifacts/${MISSING}/approve`],
      ["reject", "POST", `/v1/discovery/artifacts/${MISSING}/reject`, {}],
      ["gaps.list", "GET", "/v1/discovery/capability-gaps"],
      ["gaps.resolve", "POST", `/v1/discovery/capability-gaps/${MISSING}/resolve`, { note: "x" }],
      ["head.runs", "HEAD", "/v1/discovery/runs"],
      ["head.artifact", "HEAD", `/v1/discovery/artifacts/${connectorId}`],
      ["other-method.runs", "PUT", "/v1/discovery/runs", {}],
      ["other-method.artifact", "PUT", `/v1/discovery/artifacts/${connectorId}`, {}],
    ];
    for (const [who, key] of [
      ["denied", deniedKey],
      ["reader", readerKey],
    ] as const) {
      for (const [name, method, path, body] of probes)
        record(`http.${who}.${name}`, await http(method, path, body, key));
    }
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("audit trail of the written artifacts", async () => {
    recordRows(
      "http.audit",
      await auditRows(inArray(auditLog.resource_id, [connectorId, skillId, gapId])),
    );
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
