import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, like, or, type SQL, sql } from "drizzle-orm";
import { _resetConfigForTests, getConfig, loadConfig } from "../../../config/loader.ts";
import { apiKeys, auditLog, users } from "../../../db/schema/index.ts";
import {
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
  type SecondaryTenant,
} from "../../../http/tests/setup.ts";
import { RuntimeConfigCoordinator } from "../../../runtime-config/coordinator.ts";
import { initializeRuntimeConfig } from "../../../runtime-config/service.ts";
import { testEnv } from "../../../test-helpers/determinism/env.ts";
import { createDeterministicHexFactory } from "../../../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";

const GOLDEN_PATH = new URL("./fixtures/runtime-config.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let ctx: HttpTestServer;
let coordinator: RuntimeConfigCoordinator;
let secondary: SecondaryTenant;
let configDir: string;
let previousMasterKey: string | undefined;
let deniedKey: string;
let readOnlyKey: string;
let writeOnlyKey: string;

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
    .replaceAll(secondary.tenantId, "<secondary-tenant>")
    .replaceAll(configDir, "<config-dir>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"digest":"[0-9a-f]{64}"/g, '"digest":"<sha256>"')
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
  key: string | null = ctx.apiKey,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: parseBody(text) };
}

function digest(value: unknown): string {
  return createHash("sha256").update(scrub(value)).digest("hex");
}

function settingsSummary(res: { status: number; body: unknown }) {
  if (res.status !== 200) return res;
  const { items, ...rest } = res.body as { items: unknown[] };
  return { status: res.status, ...rest, item_count: items.length, items_sha256: digest(items) };
}

function catalogSummary(res: { status: number; body: unknown }) {
  if (res.status !== 200) return res;
  const { models, ...rest } = res.body as { models: unknown[] };
  return { status: res.status, ...rest, model_count: models.length, models_sha256: digest(models) };
}

async function databaseNow(): Promise<string> {
  const result = (await ctx.db.execute(sql`select clock_timestamp()::text as now`)) as unknown as {
    rows: { now: string }[];
  };
  const now = result.rows[0]?.now;
  if (!now) throw new Error("clock_timestamp returned no row");
  return now;
}

function auditedSince(since: string): SQL {
  return sql`${auditLog.ts} > ${since}::timestamptz`;
}

function auditRows(where: ReturnType<typeof eq | typeof or> | SQL | undefined) {
  return ctx.db
    .select({
      tenant_id: auditLog.tenant_id,
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
    .where(and(inArray(auditLog.tenant_id, [ctx.tenantId, secondary.tenantId]), where));
}

async function mintKey(seed: number, scopes: string[], role_id?: string): Promise<string> {
  const key = `wf_live_${createDeterministicHexFactory(seed)(16)}`;
  let user_id = ctx.userId;
  if (role_id) {
    const [user] = await ctx.db
      .insert(users)
      .values({ tenant_id: ctx.tenantId, email: `runtime-golden-${seed}@test.local`, role_id })
      .returning();
    if (!user) throw new Error("user insert returned no row");
    user_id = user.id;
  }
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id,
    prefix: key.slice(0, 12),
    token_sha256: createHash("sha256").update(key).digest("hex"),
    scopes,
  });
  return key;
}

beforeAll(async () => {
  previousMasterKey = testEnv.MASTER_KEY;
  testEnv.MASTER_KEY = "66".repeat(32);
  testEnv.NODE_ENV = "test";
  configDir = mkdtempSync(join(tmpdir(), "subkit-runtime-golden-"));
  _resetConfigForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/runtime-golden", NODE_ENV: "test" },
    configPathOverride: join(configDir, "seed.json"),
  });
  ctx = await createHttpTestServer("operations_runtime_config_golden");
  await initializeRuntimeConfig(ctx.db, getConfig());
  coordinator = new RuntimeConfigCoordinator(ctx.db, "test", "golden-replica");
  await coordinator.start();
  secondary = await createSecondaryTenant(ctx, "runtime-golden");
  deniedKey = await mintKey(0x6c_31, ["*"], await emptyRoleId(ctx.db, ctx.tenantId));
  readOnlyKey = await mintKey(0x6c_32, ["settings:read", "settings:read:global"]);
  writeOnlyKey = await mintKey(0x6c_33, ["settings:write:global"]);
}, 60_000);

afterAll(async () => {
  await coordinator?.stop();
  await ctx?.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
  if (previousMasterKey === undefined) delete testEnv.MASTER_KEY;
  else testEnv.MASTER_KEY = previousMasterKey;
}, 30_000);

describe("runtime configuration routes keep their HTTP responses byte for byte", () => {
  test("read the runtime state and the revision history", async () => {
    const runtime = await http("GET", "/v1/settings/runtime");
    record("http.runtime.status", runtime.status);
    record("http.runtime.state", {
      ...(runtime.body as Record<string, unknown>),
      settings: "<doc>",
    });
    const revisions = await http("GET", "/v1/settings/revisions");
    record("http.revisions.status", revisions.status);
    record(
      "http.revisions.shape",
      (revisions.body as { items: Record<string, unknown>[] }).items.map((item) => ({
        ...item,
        document: "<doc>",
      })),
    );
    const one = await http("GET", "/v1/settings/revisions/1");
    record("http.revision.status", one.status);
    record("http.revision.missing", await http("GET", "/v1/settings/revisions/999"));
    record("http.revision.invalid", await http("GET", "/v1/settings/revisions/nope"));
  });

  test("save revisions with every scope and conflict rule", async () => {
    record(
      "http.patch.forbidden-field",
      await http("PATCH", "/v1/settings", {
        expected_revision: 1,
        changes: { "database.url": "postgres://other/runtime" },
        scope: "global",
      }),
    );
    record(
      "http.patch.tenant-without-id",
      await http("PATCH", "/v1/settings", {
        expected_revision: 1,
        changes: { "log.level": "debug" },
        scope: "tenant",
      }),
    );
    record(
      "http.patch.global-with-id",
      await http("PATCH", "/v1/settings", {
        expected_revision: 1,
        changes: { "log.level": "debug" },
        scope: "global",
        tenant_id: secondary.tenantId,
      }),
    );
    record(
      "http.patch.tenant",
      await http("PATCH", "/v1/settings", {
        expected_revision: 1,
        changes: { "log.level": "debug" },
        scope: "tenant",
        tenant_id: secondary.tenantId,
      }),
    );
    const state = (await http("GET", "/v1/settings/runtime")).body as { saved_revision: number };
    record(
      "http.patch.global",
      await http("PATCH", "/v1/settings", {
        expected_revision: state.saved_revision,
        changes: { "log.level": "warn" },
        scope: "global",
      }),
    );
    record(
      "http.patch.stale",
      await http("PATCH", "/v1/settings", {
        expected_revision: 1,
        changes: { "log.level": "info" },
        scope: "global",
      }),
    );
    record("http.patch.invalid", await http("PATCH", "/v1/settings", { changes: {} }));
  });

  test("activate revisions and inspect replicas", async () => {
    const state = (await http("GET", "/v1/settings/runtime")).body as { saved_revision: number };
    record(
      "http.activate",
      await http("POST", `/v1/settings/revisions/${state.saved_revision}/activate`),
    );
    record(
      "http.activations",
      await http("GET", `/v1/settings/activations/${state.saved_revision}`),
    );
    record("http.activate.missing", await http("POST", "/v1/settings/revisions/999/activate"));
    record("http.activate.invalid", await http("POST", "/v1/settings/revisions/0/activate"));
    record("http.activations.none", await http("GET", "/v1/settings/activations/999"));
    for (let attempt = 0; attempt < 200 && getConfig().log.level !== "warn"; attempt += 1)
      await Bun.sleep(25);
    record("http.activate.applied", getConfig().log.level);
  });

  test("secrets", async () => {
    const created = await http("POST", "/v1/secrets/golden.key/versions", {
      value: "golden-plain",
    });
    record("http.secret.create", created);
    record(
      "http.secret.create.second",
      await http("POST", "/v1/secrets/golden.key/versions", { value: "golden-plain-two" }),
    );
    record(
      "http.secret.create.invalid",
      await http("POST", "/v1/secrets/golden.key/versions", { value: "" }),
    );
    record(
      "http.secret.create.bad-name",
      await http("POST", "/v1/secrets/-bad/versions", { value: "x" }),
    );
    const state = (await http("GET", "/v1/settings/runtime")).body as { saved_revision: number };
    record(
      "http.patch.secret-ref",
      await http("PATCH", "/v1/settings", {
        expected_revision: state.saved_revision,
        changes: { "mcp.api_key": "secret://golden.key/1" },
        scope: "global",
      }),
    );
    record("http.secrets", await http("GET", "/v1/secrets"));
    record(
      "http.secret.revoke.in-use",
      await http("POST", "/v1/secrets/golden.key/versions/1/revoke"),
    );
    record("http.secret.revoke", await http("POST", "/v1/secrets/golden.key/versions/2/revoke"));
    record(
      "http.secret.revoke.again",
      await http("POST", "/v1/secrets/golden.key/versions/2/revoke"),
    );
    record(
      "http.secret.revoke.missing",
      await http("POST", "/v1/secrets/nothing/versions/1/revoke"),
    );
  });

  test("operator permissions gate every route", async () => {
    const paths: [string, string, unknown?][] = [
      ["GET", "/v1/settings/runtime"],
      ["PATCH", "/v1/settings", {}],
      ["GET", "/v1/settings/revisions"],
      ["GET", "/v1/settings/revisions/1"],
      ["POST", "/v1/settings/revisions/1/activate"],
      ["GET", "/v1/settings/activations/1"],
      ["GET", "/v1/secrets"],
      ["POST", "/v1/secrets/golden.key/versions", {}],
      ["POST", "/v1/secrets/golden.key/versions/1/revoke"],
      ["HEAD", "/v1/settings/runtime"],
      ["HEAD", "/v1/settings"],
      ["PUT", "/v1/settings", {}],
      ["DELETE", "/v1/settings/revisions/1"],
      ["GET", "/v1/settings/revisions/1/activate"],
      ["POST", "/v1/secrets", {}],
    ];
    for (const [label, key] of [
      ["denied", deniedKey],
      ["read-only", readOnlyKey],
      ["write-only", writeOnlyKey],
      ["tenant-admin", secondary.admin.apiKey],
      ["tenant-member", secondary.member.apiKey],
    ] as const) {
      for (const [method, path, body] of paths) {
        const res = await http(method, path, body, key);
        record(`http.gate.${label}.${method} ${path}`, {
          status: res.status,
          code: (res.body as { code?: string } | null)?.code ?? null,
          message: (res.body as { message?: string } | null)?.message ?? null,
        });
      }
    }
    record(
      "http.unauthenticated.runtime",
      await http("GET", "/v1/settings/runtime", undefined, null),
    );
    recordRows("http.denied.audit", await auditRows(eq(auditLog.result, "denied")));
  });

  test("audit trail of runtime configuration in both tenants", async () => {
    recordRows(
      "http.audit",
      await auditRows(or(like(auditLog.action, "settings.%"), like(auditLog.action, "secret.%"))),
    );
  });

  test("settings leaves: list, catalog and one leaf in every view", async () => {
    const tenant = secondary.tenantId;
    const admin = secondary.admin.apiKey;
    record("http.settings.list.operator", settingsSummary(await http("GET", "/v1/settings")));
    record(
      "http.settings.list.operator.tenant",
      settingsSummary(await http("GET", `/v1/settings?tenant=${tenant}`)),
    );
    record("http.settings.list.invalid-tenant", await http("GET", "/v1/settings?tenant=nope"));
    record(
      "http.settings.list.tenant-admin",
      settingsSummary(await http("GET", "/v1/settings", undefined, admin)),
    );
    record(
      "http.settings.list.tenant-admin.cross",
      await http("GET", `/v1/settings?tenant=${ctx.tenantId}`, undefined, admin),
    );
    record(
      "http.settings.catalog.operator",
      catalogSummary(await http("GET", "/v1/settings/catalog/models")),
    );
    record(
      "http.settings.catalog.operator.tenant",
      catalogSummary(await http("GET", `/v1/settings/catalog/models?tenant=${tenant}`)),
    );
    record(
      "http.settings.catalog.tenant-admin",
      catalogSummary(await http("GET", "/v1/settings/catalog/models", undefined, admin)),
    );
    record(
      "http.settings.catalog.tenant-admin.cross",
      await http("GET", `/v1/settings/catalog/models?tenant=${ctx.tenantId}`, undefined, admin),
    );
    record("http.settings.get.operator", await http("GET", "/v1/settings/log.level"));
    record(
      "http.settings.get.operator.tenant",
      await http("GET", `/v1/settings/llm.model?tenant=${tenant}`),
    );
    record("http.settings.get.unknown", await http("GET", "/v1/settings/no.such.leaf"));
    record(
      "http.settings.get.tenant-admin.engine-only",
      await http("GET", "/v1/settings/log.level", undefined, admin),
    );
    record(
      "http.settings.get.tenant-admin.tenant-leaf",
      await http("GET", "/v1/settings/llm.model", undefined, admin),
    );
    record(
      "http.settings.get.tenant-admin.unknown",
      await http("GET", "/v1/settings/no.such.leaf", undefined, admin),
    );
    record(
      "http.settings.get.tenant-admin.cross",
      await http("GET", `/v1/settings/llm.model?tenant=${ctx.tenantId}`, undefined, admin),
    );
  });

  test("settings leaves: writes, refusals and their audit rows", async () => {
    const since = await databaseNow();
    const tenant = secondary.tenantId;
    const admin = secondary.admin.apiKey;
    record(
      "http.settings.put.operator",
      await http("PUT", "/v1/settings/log.level", { value: "debug" }, ctx.apiKey, {
        "x-subkit-audit-source": "sk_cli",
        "x-subkit-deploy-version": "1.2.3",
      }),
    );
    record(
      "http.settings.put.operator.tenant",
      await http("PUT", `/v1/settings/llm.model?tenant=${tenant}`, { value: "golden-model" }),
    );
    record(
      "http.settings.put.unknown",
      await http("PUT", "/v1/settings/no.such.leaf", { value: 1 }),
    );
    record(
      "http.settings.put.database-url",
      await http("PUT", "/v1/settings/database.url", { value: "postgres://x/y" }),
    );
    record("http.settings.put.invalid", await http("PUT", "/v1/settings/log.level", { value: 42 }));
    record(
      "http.settings.put.bad-header",
      await http("PUT", "/v1/settings/log.level", { value: "info" }, ctx.apiKey, {
        "x-subkit-audit-source": "nope",
      }),
    );
    record(
      "http.settings.put.tenant-admin.global",
      await http("PUT", "/v1/settings/log.level", { value: "debug" }, admin),
    );
    record(
      "http.settings.put.tenant-admin.without-tenant",
      await http("PUT", "/v1/settings/llm.model", { value: "admin-model" }, admin),
    );
    record(
      "http.settings.put.tenant-admin.cross",
      await http("PUT", `/v1/settings/llm.model?tenant=${ctx.tenantId}`, { value: "x" }, admin),
    );
    record(
      "http.settings.put.tenant-admin.own",
      await http("PUT", `/v1/settings/llm.model?tenant=${tenant}`, { value: "admin-model" }, admin),
    );
    recordRows(
      "http.settings.audit",
      await auditRows(and(auditedSince(since), like(auditLog.action, "settings.%"))),
    );
  });

  test("settings, hosted and setup gates for every key", async () => {
    const since = await databaseNow();
    const tenant = secondary.tenantId;
    const paths: [string, string, unknown?][] = [
      ["GET", "/v1/settings"],
      ["GET", "/v1/settings/catalog/models"],
      ["HEAD", "/v1/settings/catalog/models"],
      ["GET", "/v1/settings/log.level"],
      ["HEAD", "/v1/settings/log.level"],
      ["PUT", "/v1/settings/log.level", { value: "info" }],
      ["POST", "/v1/settings/log.level", {}],
      ["DELETE", "/v1/settings/catalog/models"],
      ["GET", `/v1/settings/hosted-work/${tenant}`],
      ["POST", `/v1/settings/hosted-work/${tenant}`, {}],
      ["GET", `/v1/settings/hosted-storage/${tenant}`],
      ["POST", `/v1/settings/hosted-storage/${tenant}`, {}],
    ];
    for (const [label, key] of [
      ["denied", deniedKey],
      ["read-only", readOnlyKey],
      ["write-only", writeOnlyKey],
      ["tenant-admin", secondary.admin.apiKey],
      ["tenant-member", secondary.member.apiKey],
    ] as const) {
      for (const [method, path, body] of paths) {
        const res = await http(method, path, body, key);
        record(`http.settings.gate.${label}.${method} ${path.replace(tenant, "<tenant>")}`, {
          status: res.status,
          code: (res.body as { code?: string } | null)?.code ?? null,
          message: (res.body as { message?: string } | null)?.message ?? null,
        });
      }
    }
    record("http.settings.unauthenticated", await http("GET", "/v1/settings", undefined, null));
    recordRows(
      "http.settings.denied.audit",
      await auditRows(and(auditedSince(since), eq(auditLog.result, "denied"))),
    );
  });

  test("first-run setup routes after bootstrap", async () => {
    record("http.setup.status", await http("GET", "/v1/setup", undefined, null));
    record("http.bootstrap.status", await http("GET", "/v1/bootstrap/status", undefined, null));
    record("http.setup.invalid", await http("POST", "/v1/setup", {}, null));
    record(
      "http.setup.gone",
      await http(
        "POST",
        "/v1/setup",
        {
          token: "a".repeat(64),
          admin_email: "golden@test.local",
          tenant_name: "golden",
          llm_provider: "mock",
          llm_api_key: "golden-key",
        },
        null,
      ),
    );
  });

  test("settings leaves in production: secrets, restart, pending operator change and validation", async () => {
    const since = await databaseNow();
    const own = `/v1/settings/llm.model?tenant=${secondary.tenantId}`;
    const admin = secondary.admin.apiKey;
    const writes: [string, string, unknown, string][] = [
      ["secret", "/v1/settings/mcp.api_key", { value: "golden-leaf-secret" }, ctx.apiKey],
      [
        "secret-reference",
        "/v1/settings/mcp.api_key",
        { value: "secret://golden.key/1" },
        ctx.apiKey,
      ],
      ["invalid", "/v1/settings/log.level", { value: 42 }, ctx.apiKey],
      ["tenant-admin.own", own, { value: "prod-model" }, admin],
      ["restart", "/v1/settings/server.port", { value: 4101 }, ctx.apiKey],
      ["tenant-admin.pending", own, { value: "pending-model" }, admin],
      ["restart-force", "/v1/settings/server.port", { value: 4102, force: true }, ctx.apiKey],
      ["operator.tenant", own, { value: "operator-model" }, ctx.apiKey],
    ];
    const previousNodeEnv = testEnv.NODE_ENV;
    testEnv.NODE_ENV = "production";
    try {
      for (const [name, path, body, key] of writes)
        record(`http.settings.put.production.${name}`, await http("PUT", path, body, key));
    } finally {
      if (previousNodeEnv === undefined) delete testEnv.NODE_ENV;
      else testEnv.NODE_ENV = previousNodeEnv;
    }
    const changes = or(like(auditLog.action, "settings.%"), like(auditLog.action, "secret.%"));
    recordRows(
      "http.settings.production.audit",
      await auditRows(and(auditedSince(since), changes)),
    );
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
