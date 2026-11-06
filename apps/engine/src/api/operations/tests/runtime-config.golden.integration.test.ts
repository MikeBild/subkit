import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, like, or } from "drizzle-orm";
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
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: parseBody(text) };
}

function auditRows(where: ReturnType<typeof eq | typeof or>) {
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
  previousMasterKey = process.env.MASTER_KEY;
  process.env.MASTER_KEY = "66".repeat(32);
  process.env.NODE_ENV = "test";
  configDir = mkdtempSync(join(tmpdir(), "sk-runtime-golden-"));
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
  if (previousMasterKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = previousMasterKey;
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

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
