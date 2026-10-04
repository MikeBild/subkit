import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { parseFileIdOrThrow } from "../../api/files-schemas.ts";
import {
  apiKeys,
  auditLog,
  conversations,
  executions,
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
let portalUserId: string;

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
      role_id: portalRole.id,
    })
    .returning();
  if (!portalUser) throw new Error("seed portal user");
  portalUserId = portalUser.id;
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

describe("the @attachment:<slug> reference", () => {
  type Wire = { id: string; slug: string | null; reference: string | null };

  test("a new file gets a tenant-unique slug from its name", async () => {
    const first = (await upload("q3 one", "Übersicht Q3.pdf")) as Wire;
    const second = (await upload("q3 two", "Übersicht Q3.pdf")) as Wire;
    expect(first.slug).toBe("uebersicht-q3");
    expect(first.reference).toBe("@attachment:uebersicht-q3");
    expect(second.slug).toBe("uebersicht-q3-2");
  });

  test("rename and replace keep the slug", async () => {
    const file = (await upload("keep me", "keep.txt")) as Wire;
    const renamed = await request("PATCH", `/v1/files/${file.id}`, srv.apiKey, {
      filename: "anders.txt",
    });
    expect(((await renamed.json()) as Wire).slug).toBe(file.slug);
    const replaced = await request("POST", `/v1/files/${file.id}/replace`, srv.apiKey, {
      filename: "noch-anders.txt",
      content_base64: Buffer.from("kept, new bytes").toString("base64"),
    });
    expect(((await replaced.json()) as Wire).slug).toBe(file.slug);
  });

  test("a revived file takes the next free slug when its own was taken", async () => {
    const original = (await upload("revive content", "revive.txt")) as Wire;
    expect(original.slug).toBe("revive");
    const removed = await request("DELETE", `/v1/files/${original.id}`, srv.apiKey);
    expect(removed.status).toBeLessThan(300);
    const newcomer = (await upload("other revive content", "revive.txt")) as Wire;
    expect(newcomer.slug).toBe("revive");
    const again = await request("POST", "/v1/files/inline", srv.apiKey, {
      filename: "revive.txt",
      content_base64: Buffer.from("revive content").toString("base64"),
    });
    const revived = (await again.json()) as Wire;
    expect(revived.id).toBe(original.id);
    expect(revived.slug).toBe("revive-2");
  });

  test("a $file leaf resolves by reference only where an author wrote it", async () => {
    const { walkAndResolve } = await import("../../files/resolver.ts");
    const file = (await upload("by reference", "by-ref.txt")) as Wire;
    const authored = { db: srv.db, tenant_id: srv.tenantId, resolve_references: true };
    const resolved: unknown = await walkAndResolve(
      { sheet: { $file: "@attachment:by-ref" } },
      authored,
      new Map(),
    );
    expect((resolved as { sheet: { id: string } }).sheet.id).toBe(parseFileIdOrThrow(file.id));
    await expect(
      walkAndResolve({ $file: "@attachment:no-such-file" }, authored, new Map()),
    ).rejects.toThrow();
    await expect(
      walkAndResolve(
        { $file: "@attachment:by-ref" },
        { db: srv.db, tenant_id: srv.tenantId },
        new Map(),
      ),
    ).rejects.toThrow();
  });

  test("chat text naming a tenant slug links the file into the conversation", async () => {
    const { resolveAttachmentSlugsInText } = await import("../../conversations/attachments.ts");
    const file = (await upload("chat by slug", "chat-slug.txt")) as Wire;
    const [conversation] = await srv.db
      .insert(conversations)
      .values({ tenant_id: srv.tenantId, status: "active", title: "Slug chat" })
      .returning();
    if (!conversation) throw new Error("seed conversation");
    const admin = {
      provider: "test",
      kind: "user" as const,
      id: "00000000-0000-4000-8000-00000000a11c",
      tenant_id: srv.tenantId,
      roles: ["admin"],
    };
    const rewrite = await resolveAttachmentSlugsInText("lies @attachment:chat-slug bitte", {
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: conversation.id,
      principal: admin,
    });
    expect(rewrite.text).toBe(`lies [file:${file.id}] bitte`);
    const links = await srv.db
      .select({ slug: fileLinks.slug })
      .from(fileLinks)
      .where(
        and(
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, conversation.id),
        ),
      );
    expect(links).toEqual([{ slug: "chat-slug" }]);
  });

  test("a run's input keeps a reference as written: admission resolves no name", async () => {
    const { createExecution } = await import("../../execution/state.ts");
    await upload("pinned content", "pinned.txt");
    const input = { report: { $file: "@attachment:pinned" } };
    const id = await createExecution(srv.db, {
      tenant_id: srv.tenantId,
      workflow_id: null,
      workflow_version_id: null,
      source_kind: "draft",
      source_ref: null,
      request_source: "api",
      input,
    });
    const [row] = await srv.db
      .select({ input: executions.input })
      .from(executions)
      .where(eq(executions.id, id));
    expect(row?.input).toEqual(input);
  });

  test("a writer without file:read cannot reach a tenant file by guessing its slug", async () => {
    const { resolveAttachmentSlugsInText } = await import("../../conversations/attachments.ts");
    await upload("salaries", "gehalt.txt");
    const [conversation] = await srv.db
      .insert(conversations)
      .values({ tenant_id: srv.tenantId, status: "active", title: "Guessing" })
      .returning();
    if (!conversation) throw new Error("seed conversation");
    const ctx = { db: srv.db, tenant_id: srv.tenantId, conversation_id: conversation.id };
    const portal = {
      provider: "test",
      kind: "user" as const,
      id: portalUserId,
      tenant_id: srv.tenantId,
      roles: ["portal_token_user"],
    };
    for (const principal of [portal, undefined]) {
      const rewrite = await resolveAttachmentSlugsInText("zeig @attachment:gehalt", {
        ...ctx,
        ...(principal ? { principal } : {}),
      });
      expect(rewrite.text).toBe("zeig @attachment:gehalt");
      expect(rewrite.unresolved).toEqual(["gehalt"]);
    }
    const { resolveAttachmentSlugsInArgs } = await import("../../conversations/attachments.ts");
    const args = { doc: { $file: "@attachment:gehalt" } };
    expect(await resolveAttachmentSlugsInArgs(args, { ...ctx, principal: portal })).toEqual(args);
    const links = await srv.db
      .select({ slug: fileLinks.slug })
      .from(fileLinks)
      .where(eq(fileLinks.resource_id, conversation.id));
    expect(links).toEqual([]);
    const admin = { ...portal, roles: ["admin"] };
    const pinned = await resolveAttachmentSlugsInArgs(args, { ...ctx, principal: admin });
    expect(pinned.doc.$file).toStartWith("fid_");
  });

  test("the list counts workflows naming the file by id or reference, and conversations", async () => {
    const file = (await upload("counted content", "counted.txt")) as Wire;
    await upload("neighbour content", "counted-2-neighbour.txt");
    const seed = async (slug: string, dag: Record<string, unknown>) => {
      const [workflow] = await srv.db
        .insert(workflows)
        .values({ tenant_id: srv.tenantId, slug, name: slug, lifecycle: "active" })
        .returning();
      if (!workflow) throw new Error("seed workflow");
      const [version] = await srv.db
        .insert(workflowVersions)
        .values({ tenant_id: srv.tenantId, workflow_id: workflow.id, version: 1, dag })
        .returning();
      if (!version) throw new Error("seed version");
      await srv.db
        .update(workflows)
        .set({ current_version_id: version.id })
        .where(eq(workflows.id, workflow.id));
    };
    await seed("counts-by-ref", { steps: [{ id: "a", input: { $file: "@attachment:counted" } }] });
    await seed("counts-by-id", { steps: [{ id: "a", input: { $file: file.id } }] });
    await seed("counts-not", {
      steps: [{ id: "a", input: { $file: "@attachment:counted-2-neighbour" } }],
    });
    const [conversation] = await srv.db
      .insert(conversations)
      .values({ tenant_id: srv.tenantId, status: "active", title: "Counted" })
      .returning();
    if (!conversation) throw new Error("seed conversation");
    await srv.db.insert(fileLinks).values({
      tenant_id: srv.tenantId,
      file_id: parseFileIdOrThrow(file.id),
      resource_type: "conversation",
      resource_id: conversation.id,
      slug: "counted",
    });
    const response = await request("GET", "/v1/files?q=counted&limit=100", srv.apiKey);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Array<Wire & { usage: { workflows: number; conversations: number } }>;
    };
    const listed = body.items.find((item) => item.id === file.id);
    expect(listed?.usage).toEqual({ workflows: 2, conversations: 1 });
    const usage = await request("GET", `/v1/files/${file.id}/usage`, srv.apiKey);
    const named = (await usage.json()) as { workflows: Array<{ name: string }> };
    expect(named.workflows.map((w) => w.name).sort()).toEqual(["counts-by-id", "counts-by-ref"]);
  });
});
