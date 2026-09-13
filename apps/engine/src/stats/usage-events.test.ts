import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { _resetConfigForTests, loadConfig, setConfigKey } from "../config/loader.ts";
import type { Executor } from "../db/client.ts";
import {
  appendUsageEvent,
  resetUsageWriterForTests,
  trafficClassFromHeader,
  usageHmac,
} from "./usage-events.ts";

let configDir = "";

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "subkit-usage-test-"));
  _resetConfigForTests();
  resetUsageWriterForTests();
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/usage", NODE_ENV: "test" },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
});

afterEach(() => {
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

describe("privacy-safe usage writer", () => {
  test("HMACs are stable, tenant-scoped, and domain-separated", () => {
    const secret = "s".repeat(32);
    const actor = usageHmac(secret, "tenant-a", "actor", "identity-1");
    expect(actor).toHaveLength(64);
    expect(actor).toBe(usageHmac(secret, "tenant-a", "actor", "identity-1"));
    expect(actor).not.toBe(usageHmac(secret, "tenant-b", "actor", "identity-1"));
    expect(actor).not.toBe(usageHmac(secret, "tenant-a", "session", "identity-1"));
    expect(actor).not.toContain("identity-1");
  });

  test("disabled-by-default performs no database write", async () => {
    let inserts = 0;
    const db = {
      insert: () => ({ values: async () => inserts++ }),
      delete: () => ({ where: async () => undefined }),
    } as unknown as Executor;
    const written = await appendUsageEvent(db, {
      tenantId: "00000000-0000-4000-8000-000000000001",
      surface: "http",
      operation: "/v1/workflows",
      outcome: "success",
      requestSource: "api",
    });
    expect(written).toBe(false);
    expect(inserts).toBe(0);
  });

  test("persists classifiers and HMACs but never raw dynamic identifiers", async () => {
    await setConfigKey("observability.usage.hmac_secret", "h".repeat(32), { force: true });
    await setConfigKey("observability.usage.enabled", true, { force: true });
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: async (value: Record<string, unknown>) => {
          inserted.push(value);
        },
      }),
      delete: () => ({ where: async () => undefined }),
    } as unknown as Executor;
    const actorId = "raw-actor-that-must-not-persist";
    const sessionId = "raw-session-that-must-not-persist";
    const written = await appendUsageEvent(db, {
      tenantId: "00000000-0000-4000-8000-000000000001",
      surface: "http",
      operation: "/v1/workflows/5d97a64e-55ad-4e55-9c1e-55b112ce4a92?secret=no",
      method: "POST",
      outcome: "arbitrary-user-text",
      requestSource: "arbitrary-source",
      actorId,
      sessionId,
      requestBytes: 12,
      responseBytes: 34,
    });
    expect(written).toBe(true);
    expect(inserted).toHaveLength(1);
    const row = inserted[0]!;
    expect(row.operation).toBe("unmatched");
    expect(row.outcome).toBe("unknown");
    expect(row.request_source).toBe("api");
    expect(row.actor_hmac).not.toBe(actorId);
    expect(row.session_hmac).not.toBe(sessionId);
    expect(JSON.stringify(row)).not.toContain(actorId);
    expect(JSON.stringify(row)).not.toContain(sessionId);
    expect(row).not.toHaveProperty("payload");
    expect(row).not.toHaveProperty("message");
    expect(row).not.toHaveProperty("url");
  });

  test("traffic class accepts only the closed reporting vocabulary", () => {
    expect(trafficClassFromHeader("synthetic")).toBe("synthetic");
    expect(trafficClassFromHeader("internal")).toBe("internal");
    expect(trafficClassFromHeader("user-supplied-class")).toBe("organic");
  });

  test("conversation cross-surface operations stay closed and payload-free", async () => {
    await setConfigKey("observability.usage.hmac_secret", "h".repeat(32), { force: true });
    await setConfigKey("observability.usage.enabled", true, { force: true });
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({
        values: async (value: Record<string, unknown>) => inserted.push(value),
      }),
      delete: () => ({ where: async () => undefined }),
    } as unknown as Executor;

    await appendUsageEvent(db, {
      tenantId: "00000000-0000-4000-8000-000000000001",
      surface: "conversations",
      operation: "mcp/turn",
      outcome: "success",
      requestSource: "mcp",
      sessionId: "raw-conversation-id",
      taskPhase: "completed",
    });
    await appendUsageEvent(db, {
      tenantId: "00000000-0000-4000-8000-000000000001",
      surface: "conversations",
      operation: "user-controlled-operation?prompt=secret",
      outcome: "success",
      requestSource: "mcp",
    });

    expect(inserted[0]?.operation).toBe("mcp/turn");
    expect(inserted[0]?.task_phase).toBe("completed");
    expect(JSON.stringify(inserted[0])).not.toContain("raw-conversation-id");
    expect(inserted[1]?.operation).toBe("unmatched");
  });
});
