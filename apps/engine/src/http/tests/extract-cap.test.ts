import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { apiKeys, auditLog } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { EXTRACT_BODY_CAP_BYTES } from "../routes/ai/extract.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let systemAccountKey: string;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  srv = await createHttpTestServer("extract-cap");
  systemAccountKey = "wf_live_0123456789abcdef0123456789abcdef";
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: srv.systemAccountId,
    prefix: systemAccountKey.slice(0, 12),
    token_sha256: createHash("sha256").update(systemAccountKey).digest("hex"),
    scopes: ["*"],
  });
});

afterAll(async () => {
  await srv.cleanup();
});

describe("http /v1/ai/extract body cap", () => {
  test("a 1 KB body passes the cap middleware", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/ai/extract`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${srv.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sample: "id,name\n1,alice\n2,bob\n" }),
    });
    expect(res.status).not.toBe(413);
  });

  test("a body above 100 MB is rejected with 413", async () => {
    const overhead = '{"sample":""}'.length;
    const padding = "a".repeat(EXTRACT_BODY_CAP_BYTES + 1 - overhead);
    const body = JSON.stringify({ sample: padding });
    expect(body.length).toBeGreaterThan(EXTRACT_BODY_CAP_BYTES);

    const res = await fetch(`${srv.baseUrl}/v1/ai/extract`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${systemAccountKey}`,
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    });
    expect(res.status).toBe(413);
    const envelope = (await res.json()) as { code: string };
    expect(envelope.code).toBe("payload_too_large");
    await _drainAuditWritesForTests(srv.db);
    const [entry] = await srv.db
      .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "data.exported"),
          eq(auditLog.reason, "extract_too_large"),
        ),
      )
      .limit(1);
    expect(entry).toEqual({ actor_type: "system_account", actor_id: srv.systemAccountId });
  }, 30000);
});
