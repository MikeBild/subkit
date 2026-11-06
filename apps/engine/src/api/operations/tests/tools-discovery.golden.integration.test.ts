import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { getTool, type ToolContext } from "../../../conversations/tools/index.ts";
import type { Db } from "../../../db/client.ts";
import { auditLog, discoveryArtifacts, discoveryRuns, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { zodToJsonSchema7 } from "../../../mcp/json-schema.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { makeToolCtx, seedTenant } from "../../../test-helpers/seed.ts";
import { makeTestPrincipal } from "../../../tools/tests/_helpers.ts";

const GOLDEN_PATH = new URL("./fixtures/tools-discovery.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const TOOL_NAMES = [
  "list_discovery_artifacts",
  "get_discovery_artifact",
  "approve_discovery_artifact",
  "resolve_capability_gap",
  "list_capability_gaps",
] as const;

let tdb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;
let runId: string;
let connectorId: string;
let skillId: string;
let knowledgeId: string;
let gapId: string;
let declinedGapId: string;

function uuidName(uuid: string): string {
  if (uuid === MISSING) return "<missing>";
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function scrub(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replaceAll(tenantId, "<tenant>")
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

function tool(name: string) {
  const found = getTool(name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
}

function descriptor(name: string) {
  const t = tool(name);
  return {
    name: t.name,
    description: t.description,
    use_case: t.use_case ?? null,
    important_notes: t.important_notes ?? null,
    input: zodToJsonSchema7(t.inputSchema),
    category: t.category,
    strict: t.strict ?? null,
    requires_draft: t.requires_draft ?? null,
    precheck: typeof t.precheck === "function",
    permission: t.permission
      ? {
          action: t.permission.action,
          resourceType: t.permission.resourceType,
          resourceIdArg: t.permission.resourceIdArg ?? null,
          resolveResourceId: typeof t.permission.resolveResourceId === "function",
        }
      : null,
  };
}

function userCtx(): ToolContext {
  return makeToolCtx({
    db,
    tenant_id: tenantId,
    actor_id: userId,
    principal: makeTestPrincipal({ id: userId, tenant_id: tenantId, roles: ["admin"] }),
  });
}

function systemCtx(): ToolContext {
  return makeToolCtx({ db, tenant_id: tenantId });
}

async function seedArtifact(values: Omit<typeof discoveryArtifacts.$inferInsert, "tenant_id">) {
  const [row] = await db
    .insert(discoveryArtifacts)
    .values({ tenant_id: tenantId, ...values })
    .returning({ id: discoveryArtifacts.id });
  if (!row) throw new Error("artifact insert returned no row");
  return row.id;
}

function gapDraft(requested: string, fingerprint: string, occurrences: number) {
  return {
    requested,
    missing_capability: `surface.${fingerprint}`,
    suggested_kind: "connector",
    fingerprint,
    occurrences,
    conversation_id: null,
  };
}

function auditRows(ids: string[]) {
  return db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenantId), inArray(auditLog.resource_id, ids)));
}

beforeAll(async () => {
  tdb = await createTestDb("tools_discovery_golden");
  db = tdb.db as unknown as Db;
  tenantId = (await seedTenant(db, { slug: "tools-discovery-golden" })).id;
  const [user] = await db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "tools-discovery-golden@test.local",
      role_id: await builtinRoleId(db, "admin"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert returned no row");
  userId = user.id;
  const [run] = await db
    .insert(discoveryRuns)
    .values({ tenant_id: tenantId, label: "Golden run", status: "completed", file_count: 2 })
    .returning({ id: discoveryRuns.id });
  if (!run) throw new Error("run insert returned no row");
  runId = run.id;
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
    created_at: new Date("2026-10-01T08:00:00.000Z"),
  });
  skillId = await seedArtifact({
    run_id: runId,
    kind: "skill",
    title: "Idempotency Rule",
    draft: { scope: "global", title: "Idempotency", body: "Always include header" },
    evidence: { file_ids: [], excerpts: [] },
    confidence: 70,
    created_at: new Date("2026-10-02T08:00:00.000Z"),
  });
  knowledgeId = await seedArtifact({
    run_id: runId,
    kind: "knowledge_source",
    status: "approved",
    title: "Widgets handbook",
    draft: { name: "Widgets handbook" },
    evidence: { file_ids: [], excerpts: [] },
    confidence: 60,
    created_at: new Date("2026-10-03T08:00:00.000Z"),
  });
  gapId = await seedArtifact({
    run_id: runId,
    kind: "capability_gap",
    title: "Switch authoring mode",
    draft: gapDraft("Switch from connector to workflow authoring", "authoring_mode_switch", 3),
    evidence: { file_ids: [], excerpts: [] },
  });
  declinedGapId = await seedArtifact({
    run_id: runId,
    kind: "capability_gap",
    status: "rejected",
    title: "Fax sending",
    draft: gapDraft("Send a fax", "fax_send", 1),
    evidence: { file_ids: [], excerpts: [] },
  });
}, 60_000);

afterAll(async () => {
  await tdb.cleanup();
}, 30_000);

describe("discovery conversation tools keep their descriptors and results", () => {
  test("descriptors", () => {
    for (const name of TOOL_NAMES) record(`descriptor.${name}`, descriptor(name));
  });

  test("list_discovery_artifacts", async () => {
    const list = tool("list_discovery_artifacts");
    record("list.all", await list.execute(systemCtx(), { run_id: runId }));
    record(
      "list.filtered",
      await list.execute(userCtx(), { run_id: runId, kind: "connector", status: "proposed" }),
    );
    record("list.page", await list.execute(systemCtx(), { run_id: runId, limit: 1, offset: 1 }));
    record("list.unknown_run", await list.execute(systemCtx(), { run_id: MISSING }));
  });

  test("get_discovery_artifact", async () => {
    const get = tool("get_discovery_artifact");
    record("get.connector", await get.execute(systemCtx(), { id: connectorId }));
    record("get.knowledge", await get.execute(userCtx(), { id: knowledgeId }));
    record("get.missing", await get.execute(systemCtx(), { id: MISSING }));
  });

  test("list_capability_gaps", async () => {
    const list = tool("list_capability_gaps");
    record("gaps.default", await list.execute(systemCtx(), {}));
    record("gaps.all", await list.execute(userCtx(), { status: "all" }));
    record("gaps.rejected", await list.execute(systemCtx(), { status: "rejected", limit: 1 }));
    record("gaps.limit", await list.execute(systemCtx(), { status: "all", limit: 1 }));
    await expect(list.execute(systemCtx(), { limit: 999 })).rejects.toThrow();
  });

  test("approve_discovery_artifact", async () => {
    const approve = tool("approve_discovery_artifact");
    record("approve.connector", await approve.execute(userCtx(), { id: connectorId }));
    record("approve.again", await approve.execute(userCtx(), { id: connectorId }));
    record("approve.missing", await approve.execute(userCtx(), { id: MISSING }));
    record("approve.system", await approve.execute(systemCtx(), { id: skillId }));
  });

  test("resolve_capability_gap", async () => {
    const resolve = tool("resolve_capability_gap");
    record(
      "resolve.gap",
      await resolve.execute(userCtx(), { id: gapId, note: "The workflow switch covers it." }),
    );
    record("resolve.again", await resolve.execute(userCtx(), { id: gapId, note: "Again." }));
    record(
      "resolve.declined",
      await resolve.execute(userCtx(), { id: declinedGapId, note: "Declined." }),
    );
    record(
      "gaps.after_resolve",
      await tool("list_capability_gaps").execute(systemCtx(), { status: "superseded" }),
    );
  });

  test("audit trail", async () => {
    recordRows(
      "audit",
      await auditRows([connectorId, skillId, knowledgeId, gapId, declinedGapId, MISSING]),
    );
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
