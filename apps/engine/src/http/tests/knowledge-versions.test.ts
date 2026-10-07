import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { apiKeys, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let readerKey = "";
let sourceId = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function call(method: string, path: string, body?: unknown, key = srv.apiKey) {
  return fetch(`${srv.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  srv = await createHttpTestServer("kb-versions");
  const [reader] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "reader-versions@test.local",
      role_id: await builtinRoleId(srv.db, "enduser"),
    })
    .returning();
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
  readerKey = `wf_live_${rand}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: reader!.id,
    prefix: readerKey.slice(0, 12),
    token_sha256: sha256Hex(readerKey),
    scopes: ["*"],
  });

  const created = await call("POST", "/v1/knowledge-sources/inline", {
    name: "Escalation",
    content: "# Escalation\n\nCall the lead.",
  });
  expect(created.status).toBe(201);
  sourceId = ((await created.json()) as { id: string }).id;
  const content = (await (
    await call("GET", `/v1/knowledge-sources/${sourceId}/content`)
  ).json()) as {
    version: string;
    documents: { path: string }[];
  };
  const edited = await call("PUT", `/v1/knowledge-sources/${sourceId}/content`, {
    expected_version: content.version,
    path: content.documents[0]?.path,
    content: "# Escalation\n\nCall the lead after 15 minutes.",
  });
  expect(edited.status).toBe(200);
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 60_000);

describe("knowledge source versions over HTTP", () => {
  test("history lists versions newest first with author and current marker", async () => {
    const res = await call(
      "GET",
      `/v1/knowledge-sources/${sourceId}/history`,
      undefined,
      readerKey,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { version: number; current: boolean; author: { kind: string } | null }[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.items.map((v) => [v.version, v.current])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(body.items[0]?.author?.kind).toBe("user");
  });

  test("one version carries its documents", async () => {
    const res = await call(
      "GET",
      `/v1/knowledge-sources/${sourceId}/history/1`,
      undefined,
      readerKey,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { documents: { content: string }[] };
    expect(body.documents[0]?.content).toBe("# Escalation\n\nCall the lead.");
  });

  test("a reader without knowledge:write cannot restore", async () => {
    const res = await call(
      "POST",
      `/v1/knowledge-sources/${sourceId}/restore/1`,
      undefined,
      readerKey,
    );
    expect(res.status).toBe(403);
  });

  test("restore creates a new version and writes knowledge_source.restored", async () => {
    const res = await call("POST", `/v1/knowledge-sources/${sourceId}/restore/1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; knowledge_source: { id: string } };
    expect(body).toMatchObject({ version: 3, knowledge_source: { id: sourceId } });
    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.resource_id, sourceId),
          eq(auditLog.action, "knowledge_source.restored"),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  test("restoring the current content is a conflict, unknown versions and sources are 404", async () => {
    expect((await call("POST", `/v1/knowledge-sources/${sourceId}/restore/3`)).status).toBe(409);
    expect((await call("POST", `/v1/knowledge-sources/${sourceId}/restore/9`)).status).toBe(404);
    expect((await call("GET", `/v1/knowledge-sources/${sourceId}/history/9`)).status).toBe(404);
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await call("GET", `/v1/knowledge-sources/${unknown}/history`)).status).toBe(404);
  });
});
