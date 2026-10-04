import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../conversations/abort.ts";
import { apiKeys, conversations, roles, systemAccounts } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let memberKey = "";
let memberId = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

beforeAll(async () => {
  srv = await createHttpTestServer("conv-delete");
  const [memberRole] = await srv.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, "member")));
  if (!memberRole) throw new Error("member role not seeded");
  const [acct] = await srv.db
    .insert(systemAccounts)
    .values({ tenant_id: srv.tenantId, name: "conv-delete-member", role_id: memberRole.id })
    .returning();
  memberId = acct!.id;
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test key material
  memberKey = `wf_live_${rand}`;
  await srv.db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    system_account_id: memberId,
    prefix: memberKey.slice(0, 12),
    token_sha256: sha256Hex(memberKey),
    scopes: ["*"],
  });
});

afterAll(async () => {
  await srv.cleanup();
});

async function seed(owner_id: string | null): Promise<string> {
  const [c] = await srv.db
    .insert(conversations)
    .values({ tenant_id: srv.tenantId, status: "active", title: "to delete", owner_id })
    .returning();
  return c!.id;
}

function del(id: string, key: string) {
  return fetch(`${srv.baseUrl}/v1/conversations/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${key}` },
  });
}

describe("DELETE /v1/conversations/:id", () => {
  test("an administrator deletes; a second delete is 404", async () => {
    const id = await seed(null);
    const res = await del(id, srv.apiKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, deleted: true });
    expect((await del(id, srv.apiKey)).status).toBe(404);
  });

  test("a member may delete their own conversation but not someone else's", async () => {
    const foreign = await seed(srv.userId);
    expect((await del(foreign, memberKey)).status).toBe(403);
    const own = await seed(memberId);
    expect((await del(own, memberKey)).status).toBe(200);
  });

  test("a running turn refuses the delete with 409", async () => {
    const id = await seed(null);
    const ctrl = registerConversationAbort(srv.tenantId, id);
    try {
      const res = await del(id, srv.apiKey);
      expect(res.status).toBe(409);
    } finally {
      unregisterConversationAbort(srv.tenantId, id, ctrl);
    }
  });
});
