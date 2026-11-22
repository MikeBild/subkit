import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, like, notInArray, or } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { _resetConfigForTests, getConfig, loadConfig } from "../../config/loader.ts";
import { auditLog, runtimeConfigRevisions } from "../../db/schema/index.ts";
import {
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
  type SecondaryTenant,
} from "../../http/tests/setup.ts";
import { RuntimeConfigCoordinator } from "../../runtime-config/coordinator.ts";
import { getRuntimeConfigState, initializeRuntimeConfig } from "../../runtime-config/service.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { handleSubkitUpdateSetting } from "../tools/settings.ts";

const GOLDEN_PATH = new URL("./fixtures/settings-write.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;

let ctx: HttpTestServer;
let coordinator: RuntimeConfigCoordinator;
let secondary: SecondaryTenant;
let configDir: string;
let previousMasterKey: string | undefined;

type Write = [name: string, principal: ResolvedPrincipal, args: Record<string, unknown>];

function scrub(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll(ctx.tenantId, "<tenant>")
    .replaceAll(secondary.tenantId, "<secondary-tenant>")
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(UUID, "<id>");
}

function record(name: string, value: unknown): void {
  actual[name] = scrub(value);
  expect(actual[name]).toBe(golden[name] as string);
}

function recordRows(name: string, rows: readonly unknown[]): void {
  actual[name] = JSON.stringify(rows.map((row) => scrub(row)).sort());
  expect(actual[name]).toBe(golden[name] as string);
}

function principal(id: string, tenant_id: string): ResolvedPrincipal {
  return { provider: "api_key", kind: "user", id, tenant_id, roles: ["admin"], scopes: ["*"] };
}

const tenantRows = () => inArray(auditLog.tenant_id, [ctx.tenantId, secondary.tenantId]);

async function auditIds(): Promise<string[]> {
  const rows = await ctx.db.select({ id: auditLog.id }).from(auditLog).where(tenantRows());
  return rows.map((row) => row.id);
}

function changesSince(seen: string[]) {
  return ctx.db
    .select({
      tenant_id: auditLog.tenant_id,
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(
      and(
        tenantRows(),
        seen.length > 0 ? notInArray(auditLog.id, seen) : undefined,
        or(like(auditLog.action, "settings.%"), like(auditLog.action, "secret.%")),
      ),
    );
}

async function outcome(who: ResolvedPrincipal, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await handleSubkitUpdateSetting({ db: ctx.db, principal: who }, args);
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

async function runWrites(prefix: string, writes: readonly Write[]): Promise<void> {
  for (const [name, who, args] of writes) record(`${prefix}.${name}`, await outcome(who, args));
}

beforeAll(async () => {
  previousMasterKey = testEnv.MASTER_KEY;
  testEnv.MASTER_KEY = "67".repeat(32);
  testEnv.NODE_ENV = "test";
  configDir = mkdtempSync(join(tmpdir(), "subkit-mcp-settings-golden-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/mcp-settings-golden", NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  ctx = await createHttpTestServer("mcp_settings_write_golden");
  await initializeRuntimeConfig(ctx.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(ctx.db, "test", "mcp-golden-replica");
  await coordinator.start();
  secondary = await createSecondaryTenant(ctx, "mcp-settings-golden");
}, 60_000);

afterAll(async () => {
  await coordinator?.stop();
  await ctx?.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  if (previousMasterKey === undefined) delete testEnv.MASTER_KEY;
  else testEnv.MASTER_KEY = previousMasterKey;
}, 30_000);

describe("subkit_update_setting results and audit rows", () => {
  test("in-process writes and refusals", async () => {
    const seen = await auditIds();
    const operator = principal(ctx.userId, ctx.tenantId);
    const admin = principal(secondary.admin.userId, secondary.tenantId);
    const own = secondary.tenantId;
    await runWrites("mcp.put", [
      ["operator", operator, { path: "log.level", value: "warn" }],
      ["operator.tenant", operator, { path: "llm.model", value: "mcp-model", tenant_id: own }],
      ["unknown", operator, { path: "no.such.leaf", value: 1 }],
      ["database-url", operator, { path: "database.url", value: "postgres://x/y" }],
      ["invalid", operator, { path: "log.level", value: 42 }],
      ["invalid-arguments", operator, { path: "", value: 1 }],
      ["tenant-admin.global", admin, { path: "log.level", value: "debug" }],
      ["tenant-admin.without-tenant", admin, { path: "llm.model", value: "admin-model" }],
      ["tenant-admin.cross", admin, { path: "llm.model", value: "x", tenant_id: ctx.tenantId }],
      ["tenant-admin.own", admin, { path: "llm.model", value: "admin-model", tenant_id: own }],
    ]);
    recordRows("mcp.audit", await changesSince(seen));
  });

  test("production writes through the revision service", async () => {
    const seen = await auditIds();
    const operator = principal(ctx.userId, ctx.tenantId);
    const admin = principal(secondary.admin.userId, secondary.tenantId);
    const own = secondary.tenantId;
    const previousNodeEnv = testEnv.NODE_ENV;
    testEnv.NODE_ENV = "production";
    try {
      await runWrites("mcp.put.production", [
        ["secret", operator, { path: "mcp.api_key", value: "golden-mcp-secret" }],
        ["secret-reference", operator, { path: "mcp.api_key", value: "secret://golden.key/1" }],
        ["invalid", operator, { path: "log.level", value: 42 }],
        ["tenant-admin.own", admin, { path: "llm.model", value: "prod-model", tenant_id: own }],
        ["restart", operator, { path: "server.port", value: 4111 }],
        ["tenant-admin.pending", admin, { path: "llm.model", value: "pending", tenant_id: own }],
        ["restart-force", operator, { path: "server.port", value: 4112, force: true }],
        ["secret.pending", operator, { path: "mcp.api_key", value: "golden-mcp-pending" }],
        [
          "secret.pending-force",
          operator,
          { path: "mcp.api_key", value: "golden-mcp-forced", force: true },
        ],
        ["operator.tenant", operator, { path: "llm.model", value: "operator", tenant_id: own }],
      ]);
    } finally {
      if (previousNodeEnv === undefined) delete testEnv.NODE_ENV;
      else testEnv.NODE_ENV = previousNodeEnv;
    }
    recordRows("mcp.production.audit", await changesSince(seen));
  });

  test("a refused restart write reports the revision it saved", async () => {
    const seen = await auditIds();
    const operator = principal(ctx.userId, ctx.tenantId);
    const previousNodeEnv = testEnv.NODE_ENV;
    testEnv.NODE_ENV = "production";
    let result: Awaited<ReturnType<typeof handleSubkitUpdateSetting>>;
    try {
      result = await handleSubkitUpdateSetting(
        { db: ctx.db, principal: operator },
        { path: "server.port", value: 4113 },
      );
    } finally {
      if (previousNodeEnv === undefined) delete testEnv.NODE_ENV;
      else testEnv.NODE_ENV = previousNodeEnv;
    }
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const data = result.data;
    expect(data.error_code).toBe("restart_required");
    expect(data.write_applied).toBe(true);
    expect(data.activation).toBe("restart_required");
    expect(data.pending_restart_keys).toEqual(["server.port"]);
    const revision = data.saved_revision as number;
    expect(Number.isInteger(revision)).toBe(true);
    expect(data.message).toContain(`was saved as revision ${revision} `);
    expect(data.hint).toContain(`Revision ${revision} is saved`);

    const [row] = await ctx.db
      .select({
        document: runtimeConfigRevisions.document,
        status: runtimeConfigRevisions.status,
        pending_restart_fields: runtimeConfigRevisions.pending_restart_fields,
      })
      .from(runtimeConfigRevisions)
      .where(eq(runtimeConfigRevisions.revision, revision));
    if (!row) throw new Error(`revision ${revision} is not stored`);
    expect(row.status).toBe("restart_required");
    expect(row.pending_restart_fields).toEqual(["server.port"]);
    expect((row.document as { server?: { port?: unknown } }).server?.port).toBe(4113);

    const state = await getRuntimeConfigState(ctx.db);
    expect(state.saved_revision).toBe(revision);
    expect(state.active_revision).not.toBe(revision);

    const rows = await changesSince(seen);
    const revisionActions = rows
      .filter((entry) => entry.resource_id === String(revision))
      .map((entry) => entry.action)
      .sort();
    expect(revisionActions).toEqual([
      "settings.revision_restart_required",
      "settings.revision_saved",
    ]);
    expect(rows.some((entry) => entry.action === "settings.changed")).toBe(false);
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
