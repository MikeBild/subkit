import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import {
  createDeterministicHexFactory,
  createDeterministicUuidFactory,
} from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const CHOSEN = "00000000-0000-4000-8000-00000000b4a1";
let ctx: HttpTestServer;
let memberKey: string;
const hex = createDeterministicHexFactory(4161);
const nextUuid = createDeterministicUuidFactory(4162);

function definition(name: string, id?: string) {
  return {
    name,
    ...(id ? { id } : {}),
    steps: [{ id: "noop", kind: "transform", expression: "return 1;" }],
  };
}

function create(key: string, body: unknown) {
  return fetch(`${ctx.baseUrl}/v1/workflows`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  ctx = await createHttpTestServer("workflow-chosen-id");
  const [member] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "member@example.test",
      role_id: await builtinRoleId(ctx.db, "member"),
    })
    .returning({ id: users.id });
  if (!member) throw new Error("member fixture missing");
  memberKey = `wf_live_${hex(16)}`;
  await ctx.db.insert(apiKeys).values({
    tenant_id: ctx.tenantId,
    user_id: member.id,
    prefix: memberKey.slice(0, 12),
    token_sha256: createHash("sha256").update(memberKey).digest("hex"),
    scopes: ["*"],
  });
}, 60_000);

afterAll(async () => {
  if (ctx) await ctx.cleanup();
}, 60_000);

describe("operator-chosen workflow id", () => {
  test("an admin creates a workflow under a chosen id and the creation is audited", async () => {
    const res = await create(ctx.apiKey, definition("te-kit-brain-round", CHOSEN));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id: string }).id).toBe(CHOSEN);
    const audits = await ctx.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_id, CHOSEN)));
    expect(
      audits.some((row) => (row.metadata as Record<string, unknown>)?.operator_chosen_id),
    ).toBe(true);
  });

  test("a chosen id that is already in use is refused", async () => {
    const res = await create(ctx.apiKey, definition("second", CHOSEN));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("already in use");
  });

  test("a non-admin may create workflows but never choose their id", async () => {
    const chosen = await create(memberKey, definition("member chosen", nextUuid()));
    expect(chosen.status).toBe(403);
    expect((await create(memberKey, definition("member plain"))).status).toBe(201);
  });
});
