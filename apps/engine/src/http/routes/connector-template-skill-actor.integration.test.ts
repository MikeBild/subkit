import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectorTemplates } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let server: HttpTestServer;

beforeAll(async () => {
  server = await createHttpTestServer("connector-template-skill-actor");
});

afterAll(async () => {
  await server.cleanup();
});

test("connector template default skill audit retains the authenticated user", async () => {
  await server.db.insert(connectorTemplates).values({
    tenant_id: server.tenantId,
    slug: "actor-test-template",
    name: "Actor Test Template",
    driver: "http",
    base_url: "https://api.example.test",
    auth_type: "none",
    default_skill: "stripe-basics",
    ingestion_source: "unsupported",
  });

  const response = await fetch(
    `${server.baseUrl}/v1/connectors/from-template/actor-test-template`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ingest_now: false }),
    },
  );

  expect(response.status).toBe(201);
  const skillAudit = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, server.tenantId), eq(auditLog.action, "skill.created")));

  expect(skillAudit).toEqual([{ actor_type: "user", actor_id: server.userId }]);
});
