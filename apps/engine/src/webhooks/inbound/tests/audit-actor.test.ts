import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../../db/schema/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { createInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const deterministicUuid = createDeterministicUuidFactory(0x1baad);

let ctx: InboundTestCtx;

beforeAll(async () => {
  ctx = await createInboundCtx("audit-actor");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("legacy inbound ID-only attribution persists as unknown without an actor ID", async () => {
  const legacyId = deterministicUuid();
  const hook = await createInbound(
    {
      tenant_id: ctx.tenantId,
      actor_id: legacyId,
      slug: "legacy-audit-actor",
      workflow_id: ctx.workflowId,
      verifier: "standard",
      secret: "fixture-secret",
    },
    ctx.db,
  );
  const [row] = await ctx.db
    .select({ actor_type: auditLog.actor_type, actor_id: auditLog.actor_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenantId),
        eq(auditLog.action, "webhook.inbound.created"),
        eq(auditLog.resource_id, hook.id),
      ),
    );
  expect(row).toEqual({ actor_type: "unknown", actor_id: null });
});
