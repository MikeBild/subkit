import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ServerType, serve } from "@hono/node-server";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { engineSettings, tenants } from "../../db/schema/identity.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import * as bootstrap from "../../onboarding/bootstrap.ts";
import { _resetRateLimitForTests } from "../../onboarding/bootstrap.ts";

const clearCache = (): void => {};

import { buildDefaultRegistry, createApp } from "../server.ts";

interface Ctx {
  testDb: TestDb;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

let ctx: Ctx;

async function startServer(
  testDb: TestDb,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const registry = buildDefaultRegistry(testDb.db);
  const app = createApp({ db: testDb.db, registry });
  const server: ServerType = serve({
    fetch: app.fetch,
    port: 0,
    hostname: "127.0.0.1",
  });
  const addr = (server as unknown as { address: () => { port: number } | null }).address();
  if (!addr || typeof addr !== "object") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        (server as unknown as { close: (cb: () => void) => void }).close(() => resolve());
      }),
  };
}

beforeAll(async () => {
  const testDb = await createTestDb("http-setup");
  const { baseUrl, close } = await startServer(testDb);
  ctx = {
    testDb,
    baseUrl,
    cleanup: async () => {
      await close();
      await testDb.cleanup();
    },
  };
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(auditLog);
  await ctx.testDb.db.delete(engineSettings);
  await ctx.testDb.db.delete(tenants);
  _resetRateLimitForTests();
  clearCache();
});

async function mintToken(): Promise<string> {
  const result = await bootstrap.run(ctx.testDb.db, {
    stdout: { write: () => undefined },
  });
  if (result.status !== "minted" || !result.plaintext_token) {
    throw new Error("failed to mint token in test setup");
  }
  return result.plaintext_token;
}

describe("GET /v1/setup", () => {
  test("returns pending=true on a fresh install", async () => {
    const res = await fetch(`${ctx.baseUrl}/v1/setup`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: boolean };
    expect(body.pending).toBe(true);
  });

  test("returns pending=false after bootstrap completes", async () => {
    const token = await mintToken();
    await fetch(`${ctx.baseUrl}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      }),
    });
    const res = await fetch(`${ctx.baseUrl}/v1/setup`);
    const body = (await res.json()) as { pending: boolean };
    expect(body.pending).toBe(false);
  });
});

describe("common bootstrap aliases", () => {
  test("GET /v1/bootstrap/status reports pending and completed explicitly", async () => {
    const pending = await fetch(`${ctx.baseUrl}/v1/bootstrap/status`);
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({
      pending: true,
      completed: false,
      token_expired: false,
    });
  });

  test("POST /v1/bootstrap/complete consumes the same one-time bootstrap key", async () => {
    const token = await mintToken();
    const complete = await fetch(`${ctx.baseUrl}/v1/bootstrap/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        admin_email: "bootstrap@example.com",
        tenant_name: "Bootstrap Alias",
        llm_provider: "mock",
        llm_api_key: "mock",
      }),
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({
      api_key: expect.stringMatching(/^wf_live_/),
    });

    const status = await fetch(`${ctx.baseUrl}/v1/bootstrap/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      pending: false,
      completed: true,
    });
  });
});

describe("POST /v1/setup", () => {
  test("happy path returns 200 + admin api key + writes audit row", async () => {
    const token = await mintToken();
    const res = await fetch(`${ctx.baseUrl}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        admin_email: "ops@example.com",
        tenant_name: "Acme Corp",
        llm_provider: "anthropic",
        llm_api_key: "sk-ant-test",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenant_id: string;
      user_id: string;
      api_key: string;
      api_key_prefix: string;
    };
    expect(body.api_key).toMatch(/^wf_live_/);
    expect(body.api_key.startsWith(body.api_key_prefix)).toBe(true);

    const completed = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "setup.completed"));
    expect(completed.length).toBe(1);
  });

  test("second call returns 410 Gone", async () => {
    const token = await mintToken();
    await fetch(`${ctx.baseUrl}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      }),
    });
    _resetRateLimitForTests();
    const res = await fetch(`${ctx.baseUrl}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        admin_email: "ops2@example.com",
        tenant_name: "Acme2",
        llm_provider: "mock",
        llm_api_key: "y",
      }),
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("gone");
  });

  test("invalid token returns 401", async () => {
    await mintToken();
    const res = await fetch(`${ctx.baseUrl}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "0".repeat(64),
        admin_email: "ops@example.com",
        tenant_name: "Acme",
        llm_provider: "mock",
        llm_api_key: "x",
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_token");
  });

  test("malformed payload returns 400 from Zod's defaultHook", async () => {
    await mintToken();
    const res = await fetch(`${ctx.baseUrl}/v1/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "abc",
        admin_email: "not-an-email",
        tenant_name: "",
        llm_provider: "anthropic",
        llm_api_key: "",
      }),
    });
    expect(res.status).toBe(400);
  });
});
