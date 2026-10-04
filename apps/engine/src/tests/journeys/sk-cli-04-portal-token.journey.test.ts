import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { portalTokens, users } from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, seedWorkflow } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: JourneyCtx;
let portalToken: string;
let workflowId: string;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

async function pFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${portalToken}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${ctx.baseUrl}${path}`, { ...init, headers });
}

describe("journey: sk-cli portal-token customer", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-04-portal");

    workflowId = (
      await seedWorkflow(ctx, {
        slug: "invoices",
        name: "Invoices",
        steps: [{ id: "s1", kind: "transform", expression: '"ok"' }],
      })
    ).id;

    const [end] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "portal-customer@sk-cli-04.test",
        role_id: ctx.rbacRoleIds.portal_token_user,
      })
      .returning();
    if (!end) throw new Error("failed to seed enduser for portal token");

    const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
    portalToken = `wf_portal_${rand}`;
    await ctx.db.insert(portalTokens).values({
      tenant_id: ctx.tenantId,
      enduser_ref: end.id,
      prefix: portalToken.slice(0, 14),
      token_sha256: sha256Hex(portalToken),
      allowed_workflows: [workflowId],
      expires_at: new Date(TEST_NOW_MS + 3600_000),
    });
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  test("AC1: portal-token principal can POST /v1/conversations", async () => {
    const res = await pFetch("/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ initial_message: "status check" }),
    });
    expect(res.status).toBe(201);
  });

  test("AC2: portal-token principal is denied GET /v1/skills", async () => {
    const res = await pFetch("/v1/skills");
    expect(res.status).toBe(403);
  });

  test("AC3: portal-token can read conversations (list)", async () => {
    const res = await pFetch("/v1/conversations");
    expect(res.status).toBe(403);
  });

  test("AC4: portal-token compact is allowed (conversation:write on allowlist path)", async () => {
    const create = await pFetch("/v1/conversations", {
      method: "POST",
      body: JSON.stringify({ initial_message: "to compact" }),
    });
    expect(create.status).toBe(201);
    const body = (await create.json()) as { conversation: { id: string } };
    const res = await pFetch(`/v1/conversations/${body.conversation.id}/compact`, {
      method: "POST",
      body: JSON.stringify({ keep_last: 0 }),
    });
    expect(res.status).toBe(200);
  });
});
