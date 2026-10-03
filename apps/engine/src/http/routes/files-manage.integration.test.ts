// Managing a stored file in place: rename, replace under the same id, and
// who uses it. Real Postgres via createHttpTestServer; in-memory object store.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { parseFileIdOrThrow } from "../../api/files-schemas.ts";
import {
  apiKeys,
  auditLog,
  conversations,
  fileLinks,
  roles,
  users,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";

const nextHex = createDeterministicHexFactory(0xf11e3a);

let srv: HttpTestServer;
let portalKey: string;

function request(method: string, path: string, bearer: string, body?: unknown) {
  return fetch(`${srv.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function upload(text: string, filename: string): Promise<{ id: string }> {
  const response = await request("POST", "/v1/files/inline", srv.apiKey, {
    filename,
    content_type: "text/plain",
    content_base64: Buffer.from(text).toString("base64"),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

beforeAll(async () => {
  srv = await createHttpTestServer("files-manage-http");
  const [portalRole] = await srv.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, "portal_token_user")))
    .limit(1);
  if (!portalRole) throw new Error("portal_token_user role not seeded");
  const [portalUser] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "portal@files-manage.local",
      role: "enduser",
      role_id: portalRole.id,
    })
    .returning();
  if (!portalUser) throw new Error("seed portal user");
  const token = `wf_live_${Buffer.from(nextHex(24), "hex").toString("base64url").slice(0, 32)}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: portalUser.id,
    prefix: token.slice(0, 12),
    token_sha256: createHash("sha256").update(token).digest("hex"),
    scopes: ["*"],
  });
  portalKey = token;
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("PATCH /v1/files/{id}", () => {
  test("renames the file and keeps its id", async () => {
    const file = await upload("rename me", "alt.txt");
    const response = await request("PATCH", `/v1/files/${file.id}`, srv.apiKey, {
      filename: "neu.txt",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; filename: string };
    expect(body).toMatchObject({ id: file.id, filename: "neu.txt" });
    const rows = await srv.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.resource_id, parseFileIdOrThrow(file.id)));
    expect(rows.map((row) => row.action)).toContain("file.renamed");
  });

  test("refuses an empty name", async () => {
    const file = await upload("empty name", "x.txt");
    const response = await request("PATCH", `/v1/files/${file.id}`, srv.apiKey, {
      filename: "  ",
    });
    expect(response.status).toBe(400);
  });

  test("needs file:write", async () => {
    const file = await upload("not yours to rename", "y.txt");
    const response = await request("PATCH", `/v1/files/${file.id}`, portalKey, {
      filename: "z.txt",
    });
    expect(response.status).toBe(403);
  });
});

describe("POST /v1/files/{id}/replace", () => {
  test("stores new content under the same id", async () => {
    const file = await upload("version one", "report.txt");
    const response = await request("POST", `/v1/files/${file.id}/replace`, srv.apiKey, {
      filename: "report.txt",
      content_type: "text/plain",
      content_base64: Buffer.from("version two").toString("base64"),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { id: string }).id).toBe(file.id);
    const content = await request("GET", `/v1/files/${file.id}/content`, srv.apiKey);
    expect(await content.text()).toBe("version two");
  });

  test("refuses content another file already holds", async () => {
    await upload("taken content", "first.txt");
    const second = await upload("other content", "second.txt");
    const response = await request("POST", `/v1/files/${second.id}/replace`, srv.apiKey, {
      filename: "second.txt",
      content_base64: Buffer.from("taken content").toString("base64"),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("duplicate_content");
  });

  test("needs file:write", async () => {
    const file = await upload("guarded", "guarded.txt");
    const response = await request("POST", `/v1/files/${file.id}/replace`, portalKey, {
      filename: "guarded.txt",
      content_base64: Buffer.from("intruder").toString("base64"),
    });
    expect(response.status).toBe(403);
  });
});

describe("GET /v1/files/{id}/usage", () => {
  test("names the workflows and conversations that use the file", async () => {
    const file = await upload("used content", "used.csv");
    const [workflow] = await srv.db
      .insert(workflows)
      .values({
        tenant_id: srv.tenantId,
        slug: "uses-file",
        name: "Uses file",
        lifecycle: "active",
      })
      .returning();
    if (!workflow) throw new Error("seed workflow");
    const [version] = await srv.db
      .insert(workflowVersions)
      .values({
        tenant_id: srv.tenantId,
        workflow_id: workflow.id,
        version: 1,
        dag: { steps: [{ id: "read", input: { sheet: { $file: file.id } } }] },
      })
      .returning();
    if (!version) throw new Error("seed version");
    await srv.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, workflow.id));
    const [conversation] = await srv.db
      .insert(conversations)
      .values({ tenant_id: srv.tenantId, status: "active", title: "Monatsbericht" })
      .returning();
    if (!conversation) throw new Error("seed conversation");
    await srv.db.insert(fileLinks).values({
      tenant_id: srv.tenantId,
      file_id: parseFileIdOrThrow(file.id),
      resource_type: "conversation",
      resource_id: conversation.id,
      slug: "used",
    });

    const response = await request("GET", `/v1/files/${file.id}/usage`, srv.apiKey);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workflows: [{ id: workflow.id, name: "Uses file" }],
      conversations: [{ id: conversation.id, title: "Monatsbericht" }],
      other: 0,
    });
  });

  test("is empty for a file nobody uses", async () => {
    const file = await upload("lonely content", "lonely.txt");
    const response = await request("GET", `/v1/files/${file.id}/usage`, srv.apiKey);
    expect(await response.json()).toEqual({ workflows: [], conversations: [], other: 0 });
  });

  test("needs file:read", async () => {
    const file = await upload("private usage", "private.txt");
    const response = await request("GET", `/v1/files/${file.id}/usage`, portalKey);
    expect(response.status).toBe(403);
  });
});
