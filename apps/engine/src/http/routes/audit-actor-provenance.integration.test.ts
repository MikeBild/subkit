import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, connectors } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../tests/setup.ts";

let server: HttpTestServer;
let connectorId: string;

beforeAll(async () => {
  server = await createHttpTestServer("actor-provenance");
  const [connector] = await server.db
    .insert(connectors)
    .values({
      tenant_id: server.tenantId,
      slug: "actor-provenance-docs",
      display_name: "Actor provenance docs",
      driver: "http",
      auth_type: "none",
      environment: "dev",
      base_url: "http://127.0.0.1",
    })
    .returning();
  if (!connector) throw new Error("connector seed failed");
  connectorId = connector.id;
}, 60_000);

afterAll(async () => {
  if (server?.cleanup) await server.cleanup();
}, 30_000);

test("HTTP discovery run audit records the authenticated actor type and ID", async () => {
  const form = new FormData();
  form.append("files", new File(["# Discovery source\n\nSafe local content."], "source.md"));
  const response = await fetch(`${server.baseUrl}/v1/discovery/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.apiKey}` },
    body: form,
  });
  expect(response.status).toBe(202);
  const run = (await response.json()) as { id: string };
  const [audit] = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(and(eq(auditLog.resource_id, run.id), eq(auditLog.action, "discovery.run_created")));
  expect(audit).toEqual({ actor_type: "user", actor_id: server.userId });
});

test("HTTP docs ingestion audit records the authenticated actor type and ID", async () => {
  const response = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/docs/ingest`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${server.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source_type: "markdown",
      content: "# HTTP docs\n\nAuthenticated actor provenance.",
    }),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as { document_id: string };
  const [audit] = await server.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.resource_id, connectorId),
        eq(auditLog.action, "connector.docs_ingested"),
        sql`${auditLog.metadata}->>'document_id' = ${result.document_id}`,
      ),
    );
  expect(result.document_id).toBeString();
  expect(audit).toEqual({ actor_type: "user", actor_id: server.userId });
});
