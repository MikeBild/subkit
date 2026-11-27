import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, users } from "../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../http/tests/setup.ts";
import { __resetMcpClientPoolForTests } from "../mcp/client/pool.ts";
import { __setStdioHostForTests } from "../mcp/client/stdio-host.ts";
import { stopAllStdioServers } from "../mcp/client/stdio-supervisor.ts";
import { builtinRoleId } from "../rbac/roles.ts";
import { createDeterministicHexFactory } from "../test-helpers/determinism/ids.ts";
import { emptyRoleId } from "../test-helpers/roles.ts";

const FIXTURE = new URL("../mcp/client/tests/fixtures/stdio-echo-server.ts", import.meta.url)
  .pathname;

let ctx: HttpTestServer;
let secondAdminKey: string;
let secondAdminId: string;
let deniedKey: string;
const hex = createDeterministicHexFactory(0x51d10);

async function insertKey(user_id: string): Promise<string> {
  const key = `wf_live_${hex(16)}`;
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

async function call(
  method: string,
  path: string,
  body?: unknown,
  key = ctx.apiKey,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

function stdioConfig(extra: Record<string, unknown> = {}) {
  return {
    mcp: {
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      env: { FIXTURE_FLAG: "on" },
      auth: { kind: "none" },
      ...extra,
    },
  };
}

async function createStdio(slug: string, extra: Record<string, unknown> = {}) {
  const created = await call("POST", "/v1/connectors", {
    name: slug,
    slug,
    driver: "mcp",
    environment: "prod",
    auth_type: "none",
    config: stdioConfig(extra),
  });
  expect(created.status).toBe(201);
  return created.body as { id: string; config: { mcp: Record<string, unknown> } };
}

async function commandHashOf(id: string): Promise<string> {
  const refused = await call("POST", `/v1/connectors/${id}/mcp/confirm-command`, {
    command_hash: "0".repeat(64),
  });
  expect(refused.status).toBe(409);
  const details = refused.body.details as { command: { command_hash: string } };
  return details.command.command_hash;
}

beforeAll(async () => {
  ctx = await createHttpTestServer("local_command_confirm");
  const [second] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "second-admin@test.local",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!second) throw new Error("second admin insert returned no row");
  secondAdminId = second.id;
  secondAdminKey = await insertKey(second.id);
  const [denied] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "denied-confirm@test.local",
      role_id: await emptyRoleId(ctx.db, ctx.tenantId),
    })
    .returning();
  if (!denied) throw new Error("denied user insert returned no row");
  deniedKey = await insertKey(denied.id);
});

afterEach(async () => {
  __setStdioHostForTests(null);
  __resetMcpClientPoolForTests();
  await stopAllStdioServers();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("stdio connector writes", () => {
  test("a stdio connector needs no base_url and refuses one", async () => {
    const refused = await call("POST", "/v1/connectors", {
      name: "with-url",
      driver: "mcp",
      base_url: "http://localhost:8931/mcp",
      config: stdioConfig(),
    });
    expect(refused.status).toBe(400);
    const created = await createStdio("stdio-no-url");
    expect(created.config.mcp.command_set_by).toBe(ctx.userId);
  });

  test("a client cannot write its own confirmation", async () => {
    const created = await createStdio("stdio-forged", {
      confirmed_command_hash: "a".repeat(64),
      confirmed_by: "someone",
    });
    expect(created.config.mcp.confirmed_command_hash).toBeUndefined();
    expect(created.config.mcp.confirmed_by).toBeUndefined();
  });

  test("tls is refused for a remote MCP address", async () => {
    const refused = await call("POST", "/v1/connectors", {
      name: "remote-tls",
      driver: "mcp",
      base_url: "https://mcp.example.com/mcp",
      config: { mcp: { transport: "http", tls: { skip_verify: true } } },
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("local addresses only");
    const local = await call("POST", "/v1/connectors", {
      name: "local-tls",
      driver: "mcp",
      base_url: "https://localhost:8443/mcp",
      config: { mcp: { transport: "http", tls: { skip_verify: true } } },
    });
    expect(local.status).toBe(201);
  });
});

describe("confirm-command", () => {
  test("needs connector:confirm_local_command", async () => {
    const { id } = await createStdio("stdio-denied");
    const denied = await call(
      "POST",
      `/v1/connectors/${id}/mcp/confirm-command`,
      { command_hash: "0".repeat(64) },
      deniedKey,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe("permission_denied:connector:confirm_local_command");
  });

  test("the person who entered the command cannot confirm it on a shared engine", async () => {
    const { id } = await createStdio("stdio-self");
    const hash = await commandHashOf(id);
    const self = await call("POST", `/v1/connectors/${id}/mcp/confirm-command`, {
      command_hash: hash,
    });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe("mcp_local_command_self_confirmation");
  });

  test("another admin confirms, an edit to the command clears it, a rename keeps it", async () => {
    const { id } = await createStdio("stdio-confirm");
    const hash = await commandHashOf(id);
    const confirmed = await call(
      "POST",
      `/v1/connectors/${id}/mcp/confirm-command`,
      { command_hash: hash },
      secondAdminKey,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({
      connector_id: id,
      confirmed_by: secondAdminId,
      already_confirmed: false,
      command: { command_hash: hash, env_names: ["FIXTURE_FLAG"] },
    });
    const audit = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenantId),
          eq(auditLog.action, "connector.local_command_confirmed"),
          eq(auditLog.resource_id, id),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ command_hash: hash });

    const renamed = await call("PATCH", `/v1/connectors/${id}`, {
      name: "renamed",
      config: stdioConfig(),
    });
    expect(renamed.status).toBe(200);
    expect((renamed.body.config as { mcp: Record<string, unknown> }).mcp).toMatchObject({
      confirmed_command_hash: hash,
      confirmed_by: secondAdminId,
    });

    const changed = await call("PATCH", `/v1/connectors/${id}`, {
      config: stdioConfig({ args: [FIXTURE, "--verbose"] }),
    });
    expect(changed.status).toBe(200);
    const mcp = (changed.body.config as { mcp: Record<string, unknown> }).mcp;
    expect(mcp.confirmed_command_hash).toBeUndefined();
    expect(mcp.command_set_by).toBe(ctx.userId);
  });

  test("switching a stdio connector to an address is refused", async () => {
    const { id } = await createStdio("stdio-switch");
    const refused = await call("PATCH", `/v1/connectors/${id}`, {
      base_url: "http://localhost:8931/mcp",
      config: { mcp: { transport: "http" } },
    });
    expect(refused.status).toBe(400);
  });
});

describe("stdio probe", () => {
  test("refuses before confirmation and starts the server after it", async () => {
    __setStdioHostForTests({ setting: "on", container: false });
    const { id } = await createStdio("stdio-probe");
    const before = await call("POST", `/v1/connectors/${id}/test`, {});
    expect(before.body).toMatchObject({ ok: false, error_code: "mcp_local_command_unconfirmed" });
    expect(String(before.body.detail)).toContain(FIXTURE);

    const hash = await commandHashOf(id);
    const confirmed = await call(
      "POST",
      `/v1/connectors/${id}/mcp/confirm-command`,
      { command_hash: hash },
      secondAdminKey,
    );
    expect(confirmed.status).toBe(200);
    const after = await call("POST", `/v1/connectors/${id}/test`, {});
    expect(after.body).toMatchObject({ ok: true });
    expect(String(after.body.detail)).toContain("2 tool(s)");
  });

  test("a container engine refuses stdio with the host.docker.internal hint", async () => {
    __setStdioHostForTests({ setting: "on", container: true });
    const { id } = await createStdio("stdio-container");
    const res = await call("POST", `/v1/connectors/${id}/test`, {});
    expect(res.body).toMatchObject({
      ok: false,
      error_code: "mcp_stdio_unavailable_in_container",
    });
    expect(String(res.body.detail)).toContain("host.docker.internal");
  });

  test("off refuses stdio", async () => {
    __setStdioHostForTests({ setting: "off", container: false });
    const { id } = await createStdio("stdio-off");
    const res = await call("POST", `/v1/connectors/${id}/test`, {});
    expect(res.body).toMatchObject({ ok: false, error_code: "mcp_stdio_disabled" });
  });
});
