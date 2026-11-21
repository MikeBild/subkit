import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, conversations, fileLinks, users } from "../../db/schema/index.ts";
import { findRetainedFileReferences } from "../../files/reference-protection.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let conversation_id = "";
let otherKey = "";
let accountKey = "";
const nextKeyHex = createDeterministicHexFactory(0xc0e0);

function keyRow(plaintext: string) {
  return {
    prefix: plaintext.slice(0, 12),
    token_sha256: createHash("sha256").update(plaintext).digest("hex"),
    scopes: ["*"],
  };
}

beforeAll(async () => {
  srv = await createHttpTestServer("chat-composer");
  const [c] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active" })
    .returning();
  conversation_id = c!.id;
  const [other] = await srv.db
    .insert(users)
    .values({
      tenant_id: srv.tenantId,
      email: "other@composer.test.local",
      role_id: await builtinRoleId(srv.db, "admin"),
    })
    .returning();
  otherKey = `wf_live_${nextKeyHex(24)}`;
  accountKey = `wf_live_${nextKeyHex(24)}`;
  await srv.db.insert(apiKeys).values([
    { tenant_id: srv.tenantId, user_id: other!.id, ...keyRow(otherKey) },
    { tenant_id: srv.tenantId, system_account_id: srv.systemAccountId, ...keyRow(accountKey) },
  ]);
});

afterAll(async () => {
  await srv.cleanup();
});

async function api(method: string, path: string, body?: unknown, key = srv.apiKey) {
  return fetch(`${srv.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function upload(name: string, text: string) {
  return {
    filename: name,
    content_type: "text/plain",
    content_base64: Buffer.from(text, "utf8").toString("base64"),
  };
}

type Staged = { id: string; file: { id: string; slug: string }; expires_at: string };

describe("chat composer tray", () => {
  test("a staged file waits in the person's composer and only there", async () => {
    const res = await api("POST", "/v1/chat/composer/attachments", upload("notes.txt", "hello"));
    expect(res.status).toBe(201);
    const staged = (await res.json()) as Staged;
    expect(staged.file.slug).toBe("notes");

    const mine = (await (await api("GET", "/v1/chat/composer/attachments")).json()) as {
      items: Staged[];
    };
    expect(mine.items.map((item) => item.id)).toEqual([staged.id]);

    const theirs = (await (
      await api("GET", "/v1/chat/composer/attachments", undefined, otherKey)
    ).json()) as { items: Staged[] };
    expect(theirs.items).toEqual([]);
    expect(
      (await api("DELETE", `/v1/chat/composer/attachments/${staged.id}`, undefined, otherKey))
        .status,
    ).toBe(404);

    const audits = await srv.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "chat.composer_attachment_staged"),
        ),
      );
    expect(audits.length).toBeGreaterThan(0);

    const fileId = staged.file.id.replace(/^fid_/, "");
    const retained = await findRetainedFileReferences(srv.db, [
      { id: fileId, tenant_id: srv.tenantId, slug: null },
    ]);
    expect(retained.has(fileId)).toBe(true);
  });

  test("claiming links the staged files to the conversation and empties the tray", async () => {
    const res = await api("POST", "/v1/chat/composer/attachments/claim", { conversation_id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachments: Array<{ slug: string }> };
    expect(body.attachments.map((a) => a.slug)).toEqual(["notes"]);
    const links = await srv.db
      .select()
      .from(fileLinks)
      .where(
        and(
          eq(fileLinks.tenant_id, srv.tenantId),
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, conversation_id),
        ),
      );
    expect(links.map((link) => link.slug)).toContain("notes");
    const after = (await (await api("GET", "/v1/chat/composer/attachments")).json()) as {
      items: Staged[];
    };
    expect(after.items).toEqual([]);
  });

  test("a claim naming a file that is not in the tray changes nothing", async () => {
    const staged = (await (
      await api("POST", "/v1/chat/composer/attachments", upload("keep.txt", "keep me"))
    ).json()) as Staged;
    const res = await api("POST", "/v1/chat/composer/attachments/claim", {
      conversation_id,
      ids: [staged.id, "00000000-0000-4000-8000-0000000000aa"],
    });
    expect(res.status).toBe(404);
    const still = (await (await api("GET", "/v1/chat/composer/attachments")).json()) as {
      items: Staged[];
    };
    expect(still.items.map((item) => item.id)).toEqual([staged.id]);
    expect((await api("DELETE", `/v1/chat/composer/attachments/${staged.id}`)).status).toBe(204);
  });

  test("a claim that cannot link one file links none and keeps the tray", async () => {
    const taken = await api(
      "POST",
      `/v1/conversations/${conversation_id}/attachments`,
      upload("clash.txt", "already in the conversation"),
    );
    expect(taken.status).toBe(201);
    const clash = (await (
      await api("POST", "/v1/chat/composer/attachments", upload("clash.txt", "another file"))
    ).json()) as Staged;
    const fine = (await (
      await api("POST", "/v1/chat/composer/attachments", upload("fine.txt", "would link"))
    ).json()) as Staged;
    const takenFileId = ((await taken.json()) as { id: string }).id.replace(/^fid_/, "");
    await srv.db.insert(fileLinks).values({
      tenant_id: srv.tenantId,
      file_id: takenFileId,
      resource_type: "conversation",
      resource_id: conversation_id,
      slug: clash.file.slug,
      role: "attachment",
    });
    const res = await api("POST", "/v1/chat/composer/attachments/claim", { conversation_id });
    expect(res.status).toBe(400);
    const linked = await srv.db
      .select({ slug: fileLinks.slug })
      .from(fileLinks)
      .where(
        and(
          eq(fileLinks.tenant_id, srv.tenantId),
          eq(fileLinks.resource_type, "conversation"),
          eq(fileLinks.resource_id, conversation_id),
        ),
      );
    expect(linked.map((link) => link.slug)).not.toContain("fine");
    const still = (await (await api("GET", "/v1/chat/composer/attachments")).json()) as {
      items: Staged[];
    };
    expect(still.items.map((item) => item.id).sort()).toEqual([clash.id, fine.id].sort());
    for (const id of [clash.id, fine.id])
      expect((await api("DELETE", `/v1/chat/composer/attachments/${id}`)).status).toBe(204);
  });

  test("the tray holds at most ten files", async () => {
    for (let i = 0; i < 10; i++)
      expect(
        (await api("POST", "/v1/chat/composer/attachments", upload(`f${i}.txt`, `file ${i}`)))
          .status,
      ).toBe(201);
    const full = await api("POST", "/v1/chat/composer/attachments", upload("f10.txt", "one more"));
    expect(full.status).toBe(409);
    expect(((await full.json()) as { code: string }).code).toBe("composer_full");
  });

  test("a system account has no composer", async () => {
    expect((await api("GET", "/v1/chat/composer/attachments", undefined, accountKey)).status).toBe(
      403,
    );
  });

  test("an invalid upload is refused", async () => {
    const res = await api("POST", "/v1/chat/composer/attachments", {
      filename: "empty.txt",
      content_base64: "",
    });
    expect(res.status).toBe(400);
  });
});
