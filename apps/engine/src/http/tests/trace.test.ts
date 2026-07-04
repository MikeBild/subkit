import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("trace");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("trace propagation", () => {
  test("x-trace-id header matches the audit_log row written for the request", async () => {
    const headers = {
      authorization: `Bearer ${ctx.apiKey}`,
      "content-type": "application/json",
    };
    const res = await fetch(`${ctx.baseUrl}/v1/identity/system-accounts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "trace-bot", description: "for trace test" }),
    });
    expect(res.status).toBe(201);
    const traceId = res.headers.get("x-trace-id");
    expect(traceId).toBeTruthy();
    expect(traceId?.length ?? 0).toBeGreaterThan(8);
    const created = (await res.json()) as { id: string };

    // The audit row written inside the route handler must carry the same
    // trace_id from the async context.
    const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.resource_id, created.id));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const found = rows.find((r) => r.trace_id === traceId);
    expect(found).toBeDefined();
    expect(found?.action).toBe("system_account.created");
  });
});
