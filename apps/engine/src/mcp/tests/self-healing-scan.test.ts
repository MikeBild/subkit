import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  auditLog,
  patchCandidates,
  schemaVersions,
  selfHealingScans,
} from "../../db/schema/index.ts";
import {
  createSelfHealingCtx,
  SEED_STEP_ID,
  type SelfHealingTestCtx,
} from "../../self-healing/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { handleSelfHealingScan } from "../tools/self-healing-scan.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let prevMode: string | undefined;

beforeAll(async () => {
  prevMode = testEnv.SUBKIT_MCP_MODE;
  testEnv.SUBKIT_MCP_MODE = "admin";
  suite = await startMcpTestSuite("self-healing-scan");
});

afterAll(async () => {
  await suite.cleanup();
  if (prevMode === undefined) delete testEnv.SUBKIT_MCP_MODE;
  else testEnv.SUBKIT_MCP_MODE = prevMode;
});

describe("mcp self_healing_scan tool", () => {
  test("appears in tools/list under admin mode", async () => {
    const client = await suite.connect();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("self_healing_scan");
  });

  test("tools/call runs a scan and persists the self_healing_scans row", async () => {
    const client = await suite.connect();
    const callResult = await client.callTool({
      name: "self_healing_scan",
      arguments: {},
    });
    expect(callResult.isError ?? false).toBe(false);
    const content = callResult.content as Array<{ type: string; text: string }>;
    expect(Array.isArray(content)).toBe(true);
    const payload = JSON.parse(content[0]?.text ?? "{}") as {
      scan_id: string;
      signals_detected: number;
      candidates_created: number;
      unanchored_detected: number;
      candidates: unknown[];
      unanchored: unknown[];
    };
    expect(payload.scan_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.signals_detected).toBe(0);
    expect(payload.candidates_created).toBe(0);
    expect(payload.unanchored_detected).toBe(0);
    expect(payload.candidates).toEqual([]);
    expect(payload.unanchored).toEqual([]);

    const rows = await suite.http.db
      .select()
      .from(selfHealingScans)
      .where(eq(selfHealingScans.id, payload.scan_id));
    expect(rows.length).toBe(1);
    expect(rows[0]?.source).toBe("mcp");
    expect(rows[0]?.status).toBe("succeeded");
    expect(rows[0]?.tenant_id).toBe(suite.http.tenantId);
    const audits = await suite.http.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.resource_id, payload.scan_id)),
      );
    const scanAudits = audits.filter(
      (row) =>
        row.action === AuditAction.SELF_HEALING_SCAN_TRIGGERED ||
        row.action === AuditAction.SELF_HEALING_SCAN_COMPLETED,
    );
    expect(scanAudits).toHaveLength(2);
    expect(
      scanAudits.every((row) => row.actor_type === "user" && row.actor_id === suite.http.userId),
    ).toBe(true);
  });

  test("system-account tool caller stays system_account in scan audit", async () => {
    const key = await suite.issueSystemAccountApiKey(["*"], { roleName: "admin" });
    const client = await suite.connectWithApiKey(key.plaintext);
    const result = await client.callTool({ name: "self_healing_scan", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]?.text ?? "{}") as { scan_id: string };
    const audits = await suite.http.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, suite.http.tenantId), eq(auditLog.resource_id, payload.scan_id)),
      );
    const scanAudits = audits.filter(
      (row) =>
        row.action === AuditAction.SELF_HEALING_SCAN_TRIGGERED ||
        row.action === AuditAction.SELF_HEALING_SCAN_COMPLETED,
    );
    expect(scanAudits).toHaveLength(2);
    expect(
      scanAudits.every(
        (row) => row.actor_type === "system_account" && row.actor_id === key.system_account_id,
      ),
    ).toBe(true);
  });
});

describe("handleSelfHealingScan on the shared scan", () => {
  let shCtx: SelfHealingTestCtx;

  beforeAll(async () => {
    shCtx = await createSelfHealingCtx("mcp_scan_shared");
    const now = getTestNow();
    await shCtx.testDb.db.insert(schemaVersions).values([
      {
        tenant_id: shCtx.tenant_id,
        connector_id: shCtx.connector_id,
        workflow_id: shCtx.workflow_id,
        step_id: SEED_STEP_ID,
        endpoint_key: "GET /users/1",
        schema: { type: "object", properties: { data: { type: "object", properties: {} } } },
        seen_at: new Date(now - 60_000),
      },
      {
        tenant_id: shCtx.tenant_id,
        connector_id: shCtx.connector_id,
        workflow_id: shCtx.workflow_id,
        step_id: SEED_STEP_ID,
        endpoint_key: "GET /users/1",
        schema: { type: "object", properties: { data: { type: "string" } } },
        seen_at: new Date(now),
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await shCtx.cleanup();
  }, 30_000);

  function admin(): ResolvedPrincipal {
    return {
      provider: "test",
      kind: "user",
      id: "0d15a503-ce35-460b-a03c-3f0b15bb8be5",
      tenant_id: shCtx.tenant_id,
      roles: ["admin"],
    };
  }

  test("a non-admin caller is refused before any scan row is written", async () => {
    const result = await handleSelfHealingScan(
      { db: shCtx.testDb.db, principal: { ...admin(), roles: ["viewer"] } },
      {},
    );
    expect(result).toEqual({
      ok: false,
      data: {
        error: "admin role required to trigger a self-healing scan",
        reason: "admin_required",
      },
    });
    const rows = await shCtx.testDb.db
      .select()
      .from(selfHealingScans)
      .where(eq(selfHealingScans.tenant_id, shCtx.tenant_id));
    expect(rows).toHaveLength(0);
  });

  test("a schema drift candidate keeps its workflow_step_id anchor and the mcp source", async () => {
    const result = await handleSelfHealingScan({ db: shCtx.testDb.db, principal: admin() }, {});
    if (!result.ok) throw new Error(`scan failed: ${result.data.reason}`);
    expect(result.data.candidates_created).toBeGreaterThan(0);
    expect("error" in result.data).toBe(false);
    const candidateId = result.data.candidates[0]?.id;
    if (!candidateId) throw new Error("no candidate");

    const [candidate] = await shCtx.testDb.db
      .select({ diff: patchCandidates.diff })
      .from(patchCandidates)
      .where(
        and(eq(patchCandidates.tenant_id, shCtx.tenant_id), eq(patchCandidates.id, candidateId)),
      );
    const diff = candidate?.diff as Record<string, unknown> | undefined;
    expect(diff?.workflow_step_id).toBe(SEED_STEP_ID);

    const [scan] = await shCtx.testDb.db
      .select()
      .from(selfHealingScans)
      .where(
        and(
          eq(selfHealingScans.tenant_id, shCtx.tenant_id),
          eq(selfHealingScans.id, result.data.scan_id),
        ),
      );
    expect(scan?.source).toBe("mcp");
    expect(scan?.status).toBe("succeeded");
    expect(scan?.idempotency_key).toBeNull();
    expect(scan?.candidates_created).toBe(result.data.candidates_created);
  }, 90_000);

  test("repeated calls never replay: each call writes its own scan row", async () => {
    const first = await handleSelfHealingScan({ db: shCtx.testDb.db, principal: admin() }, {});
    const second = await handleSelfHealingScan({ db: shCtx.testDb.db, principal: admin() }, {});
    if (!first.ok || !second.ok) throw new Error("scan failed");
    expect(second.data.scan_id).not.toBe(first.data.scan_id);
    expect("idempotent_replay" in second.data).toBe(false);
  }, 90_000);
});
