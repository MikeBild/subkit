import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { issueBrowserSession } from "../../auth/browser-session.ts";
import { auditLog } from "../../db/schema/audit.ts";
import { apiKeys, files, tenants, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let readerKey = "";
let otherTenantKey = "";
let readScopeKey = "";
let writeScopeKey = "";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function call(method: string, path: string, body?: unknown, key = srv.apiKey): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createBundle(name: string, files: { path: string; content: string }[]) {
  const response = await call("POST", "/v1/knowledge-sources/bundle", { name, files });
  expect(response.status).toBe(200);
  return (await response.json()) as { knowledge_source: { id: string; version: string } };
}

async function readContent(id: string) {
  const response = await call("GET", `/v1/knowledge-sources/${id}/content`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    version: string;
    documents: { path: string; content: string }[];
  };
}

beforeAll(async () => {
  srv = await createHttpTestServer("knowledge-documents");
  const readerToken = "wf_live_rdr_documents_token";
  const otherTenantToken = "wf_live_oth_documents_token";
  const [reader] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "reader-documents@test.local",
      role_id: await builtinRoleId(srv.db, "enduser"),
    })
    .returning();
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: reader!.id,
    prefix: readerToken.slice(0, 12),
    token_sha256: sha256Hex(readerToken),
    scopes: ["*"],
  });
  readerKey = readerToken;

  const [otherTenant] = await srv.db
    .insert(tenants)
    .values({ slug: "t-knowledge-documents-other", display_name: "Other tenant" })
    .returning();
  const [otherUser] = await srv.db
    .insert(users)
    .values({
      tenant_id: otherTenant!.id,
      email: "admin-documents-other@test.local",
      role_id: await builtinRoleId(srv.db, "admin"),
    })
    .returning();
  await srv.db.insert(apiKeys).values({
    tenant_id: otherTenant!.id,
    user_id: otherUser!.id,
    prefix: otherTenantToken.slice(0, 12),
    token_sha256: sha256Hex(otherTenantToken),
    scopes: ["*"],
  });
  otherTenantKey = otherTenantToken;

  const readScopeToken = "wf_live_rd_knowledge_scope";
  const writeScopeToken = "wf_live_wr_knowledge_scope";
  await srv.db.insert(apiKeys).values([
    {
      tenant_id: srv.tenantId,
      user_id: srv.userId,
      prefix: readScopeToken.slice(0, 12),
      token_sha256: sha256Hex(readScopeToken),
      scopes: ["knowledge:read"],
    },
    {
      tenant_id: srv.tenantId,
      user_id: srv.userId,
      prefix: writeScopeToken.slice(0, 12),
      token_sha256: sha256Hex(writeScopeToken),
      scopes: ["knowledge:write"],
    },
  ]);
  readScopeKey = readScopeToken;
  writeScopeKey = writeScopeToken;
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 60_000);

describe("POST /v1/knowledge-sources/{id}/documents", () => {
  test("enforces knowledge read and write API-key scopes", async () => {
    const created = await createBundle("Scope collection", [
      { path: "notes/one.md", content: "# One" },
    ]);
    const content = await readContent(created.knowledge_source.id);
    const wildcardList = await call("GET", "/v1/knowledge-sources", undefined, srv.apiKey);
    expect(wildcardList.status).toBe(200);
    const login = await issueBrowserSession({
      db: srv.db,
      tenantId: srv.tenantId,
      userId: srv.userId,
      redirectTo: srv.baseUrl,
      via: "knowledge-documents-test",
    });
    const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("browser session was not issued");
    const sessionList = await fetch(`${srv.baseUrl}/v1/knowledge-sources`, {
      headers: { cookie, "x-subkit-client": "cockpit" },
    });
    expect(sessionList.status).toBe(200);
    const list = await call("GET", "/v1/knowledge-sources", undefined, readScopeKey);
    expect(list.status).toBe(200);
    const readContentResponse = await call(
      "GET",
      `/v1/knowledge-sources/${created.knowledge_source.id}/content`,
      undefined,
      readScopeKey,
    );
    expect(readContentResponse.status).toBe(200);
    const readBundle = await call(
      "POST",
      "/v1/knowledge-sources/bundle",
      { name: "Read denied", files: [{ path: "notes/a.md", content: "# A" }] },
      readScopeKey,
    );
    expect(readBundle.status).toBe(403);
    const readAppend = await call(
      "POST",
      `/v1/knowledge-sources/${created.knowledge_source.id}/documents`,
      { expected_version: content.version, path: "clips/read.md", content: "# Read" },
      readScopeKey,
    );
    expect(readAppend.status).toBe(403);
    const readReplace = await call(
      "PUT",
      `/v1/knowledge-sources/${created.knowledge_source.id}/content`,
      { expected_version: content.version, path: "/notes/one.md", content: "# Replace" },
      readScopeKey,
    );
    expect(readReplace.status).toBe(403);
    const writeList = await call("GET", "/v1/knowledge-sources", undefined, writeScopeKey);
    expect(writeList.status).toBe(403);
    const writeContent = await call(
      "GET",
      `/v1/knowledge-sources/${created.knowledge_source.id}/content`,
      undefined,
      writeScopeKey,
    );
    expect(writeContent.status).toBe(403);
    const writeAppend = await call(
      "POST",
      `/v1/knowledge-sources/${created.knowledge_source.id}/documents`,
      { expected_version: content.version, path: "clips/write.md", content: "# Write" },
      writeScopeKey,
    );
    expect(writeAppend.status).toBe(201);
  });

  test("appends a Markdown document, returns its new version, and audits the write", async () => {
    const created = await createBundle("Clip collection", [
      { path: "notes/one.md", content: "# One" },
    ]);
    const before = await readContent(created.knowledge_source.id);
    const response = await call(
      "POST",
      `/v1/knowledge-sources/${created.knowledge_source.id}/documents`,
      {
        expected_version: before.version,
        path: "clips/example.md",
        content: "# Example",
      },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      knowledge_source_id: string;
      version: string;
      path: string;
    };
    expect(body).toMatchObject({
      knowledge_source_id: created.knowledge_source.id,
      path: "/clips/example.md",
    });
    expect(body.version).not.toBe(before.version);
    const after = await readContent(created.knowledge_source.id);
    expect(after.documents).toEqual([
      { path: "/clips/example.md", content: "# Example" },
      { path: "/notes/one.md", content: "# One" },
    ]);
    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.resource_id, created.knowledge_source.id),
          eq(auditLog.action, "knowledge_source.ingested"),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  test("rejects stale versions and an existing document path with explicit conflicts", async () => {
    const created = await createBundle("Conflict collection", [
      { path: "notes/one.md", content: "# One" },
    ]);
    const before = await readContent(created.knowledge_source.id);
    const first = await call(
      "POST",
      `/v1/knowledge-sources/${created.knowledge_source.id}/documents`,
      {
        expected_version: before.version,
        path: "clips/example.md",
        content: "# Example",
      },
    );
    expect(first.status).toBe(201);
    const latest = await readContent(created.knowledge_source.id);
    const duplicate = await call(
      "POST",
      `/v1/knowledge-sources/${created.knowledge_source.id}/documents`,
      {
        expected_version: latest.version,
        path: "/clips/example.md",
        content: "# Another",
      },
    );
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()) as { code: string }).toMatchObject({ code: "path_exists" });
    const stale = await call(
      "POST",
      `/v1/knowledge-sources/${created.knowledge_source.id}/documents`,
      {
        expected_version: before.version,
        path: "clips/second.md",
        content: "# Second",
      },
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()) as { code: string }).toMatchObject({ code: "version_conflict" });
  });

  test("serializes concurrent writers before persistence, preserving one winner without loser files", async () => {
    const created = await createBundle("Concurrent collection", [
      { path: "notes/one.md", content: "# One" },
    ]);
    const before = await readContent(created.knowledge_source.id);
    const beforeFiles = await srv.db.select().from(files).where(eq(files.tenant_id, srv.tenantId));
    const [first, second] = await Promise.all([
      call("POST", `/v1/knowledge-sources/${created.knowledge_source.id}/documents`, {
        expected_version: before.version,
        path: "clips/first.md",
        content: "# First",
      }),
      call("POST", `/v1/knowledge-sources/${created.knowledge_source.id}/documents`, {
        expected_version: before.version,
        path: "clips/second.md",
        content: "# Second",
      }),
    ]);
    const responses = [first, second];
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    const conflict = await responses.find((response) => response.status === 409)!.json();
    expect(conflict).toMatchObject({ code: "version_conflict" });
    const after = await readContent(created.knowledge_source.id);
    expect(after.documents).toHaveLength(2);
    expect(after.documents.filter((document) => document.path.startsWith("/clips/"))).toHaveLength(
      1,
    );
    const afterFiles = await srv.db.select().from(files).where(eq(files.tenant_id, srv.tenantId));
    expect(afterFiles).toHaveLength(beforeFiles.length + 1);
    const ingests = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.resource_id, created.knowledge_source.id),
          eq(auditLog.action, "knowledge_source.ingested"),
        ),
      );
    expect(ingests).toHaveLength(1);
  });

  test("enforces bundle type, safe Markdown paths, RBAC, and tenant isolation", async () => {
    const inline = await call("POST", "/v1/knowledge-sources/inline", {
      name: "Inline source",
      content: "# Inline",
    });
    expect(inline.status).toBe(201);
    const inlineSource = (await inline.json()) as { id: string; version: string };
    const sourceType = await call("POST", `/v1/knowledge-sources/${inlineSource.id}/documents`, {
      expected_version: inlineSource.version,
      path: "clips/example.md",
      content: "# Example",
    });
    expect(sourceType.status).toBe(409);
    expect((await sourceType.json()) as { code: string }).toMatchObject({
      code: "source_type_conflict",
    });

    const created = await createBundle("Access collection", [
      { path: "notes/one.md", content: "# One" },
    ]);
    const content = await readContent(created.knowledge_source.id);
    const invalid = await call(
      "POST",
      `/v1/knowledge-sources/${created.knowledge_source.id}/documents`,
      {
        expected_version: content.version,
        path: "../outside.txt",
        content: "# Invalid",
      },
    );
    expect(invalid.status).toBe(422);
    const forbidden = await call(
      "POST",
      `/v1/knowledge-sources/${created.knowledge_source.id}/documents`,
      { expected_version: content.version, path: "clips/example.md", content: "# Example" },
      readerKey,
    );
    expect(forbidden.status).toBe(403);
    const hidden = await call(
      "POST",
      `/v1/knowledge-sources/${created.knowledge_source.id}/documents`,
      { expected_version: content.version, path: "clips/example.md", content: "# Example" },
      otherTenantKey,
    );
    expect(hidden.status).toBe(404);
  });

  test("preserves all 500 bundle documents while replacing one and refuses a 501st", async () => {
    const files = Array.from({ length: 500 }, (_, index) => ({
      path: `clips/${String(index).padStart(3, "0")}.md`,
      content: `# ${index}`,
    }));
    const created = await createBundle("Large collection", files);
    const before = await readContent(created.knowledge_source.id);
    expect(before.documents).toHaveLength(500);
    const updated = await call(
      "PUT",
      `/v1/knowledge-sources/${created.knowledge_source.id}/content`,
      {
        expected_version: before.version,
        path: "/clips/499.md",
        content: "# Updated",
      },
    );
    expect(updated.status).toBe(200);
    const after = await readContent(created.knowledge_source.id);
    expect(after.documents).toHaveLength(500);
    expect(after.documents.find((document) => document.path === "/clips/000.md")?.content).toBe(
      "# 0",
    );
    expect(after.documents.find((document) => document.path === "/clips/499.md")?.content).toBe(
      "# Updated",
    );
    const append = await call(
      "POST",
      `/v1/knowledge-sources/${created.knowledge_source.id}/documents`,
      {
        expected_version: after.version,
        path: "clips/500.md",
        content: "# 500",
      },
    );
    expect(append.status).toBe(413);
  });
});
