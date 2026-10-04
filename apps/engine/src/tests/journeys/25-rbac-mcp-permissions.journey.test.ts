import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { portalTokens, users } from "../../db/schema/index.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let ctx: JourneyCtx;

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

describe("journey: rbac mcp permissions", () => {
  let workflowA = "";
  let portalUser = "";

  beforeAll(async () => {
    ctx = await createJourneyCtx("25-rbac-mcp");
    workflowA = (
      await seedWorkflow(ctx, {
        slug: "a",
        name: "A",
        steps: [{ id: "s1", kind: "transform", expression: '"a"' }],
      })
    ).id;
    await seedWorkflow(ctx, {
      slug: "b",
      name: "B",
      steps: [{ id: "s1", kind: "transform", expression: '"b"' }],
    });
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "portal@25",
        role_id: await builtinRoleId(ctx.db, "enduser"),
      })
      .returning();
    portalUser = u!.id;
    const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: legacy; review before changing
    const plaintext = `wf_portal_${rand}`;
    await ctx.db.insert(portalTokens).values({
      tenant_id: ctx.tenantId,
      enduser_ref: portalUser,
      prefix: plaintext.slice(0, 12),
      token_sha256: sha256Hex(plaintext),
      allowed_workflows: [workflowA],
      expires_at: new Date(TEST_NOW_MS + 3600_000),
    });
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  async function canQuery(body: unknown): Promise<{ allow: boolean; source: string | null }> {
    const res = await journeyFetch(ctx, "/v1/rbac/can", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return (await res.json()) as { allow: boolean; source: string | null };
  }

  test("AC3: member-role user is allowed connector:read", async () => {
    const memberRes = await journeyFetch(ctx, "/v1/rbac/roles");
    const body = (await memberRes.json()) as {
      items: Array<{ id: string; name: string; is_builtin: boolean }>;
    };
    const member = body.items.find((r) => r.is_builtin && r.name === "member");
    expect(member).toBeDefined();
    if (!member) return;
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "member@25",
        role_id: member.id,
      })
      .returning();

    const d = await canQuery({
      principal_id: u!.id,
      permission: "connector:read",
    });
    expect(d.allow).toBe(true);
  });

  test("AC4: bare role user is denied connector:read", async () => {
    const bareRes = await journeyFetch(ctx, "/v1/rbac/roles", {
      method: "POST",
      body: JSON.stringify({ name: "bare-25" }),
    });
    const bare = (await bareRes.json()) as { id: string };
    const [u] = await ctx.db
      .insert(users)
      .values({
        tenant_id: ctx.tenantId,
        email: "bare@25",
        role_id: bare.id,
      })
      .returning();
    const d = await canQuery({
      principal_id: u!.id,
      permission: "connector:read",
    });
    expect(d.allow).toBe(false);
  });
});
