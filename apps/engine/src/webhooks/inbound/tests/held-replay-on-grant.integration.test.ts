import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { grantWorkflowAuthorityOperation } from "../../../api/operations/workflow-authority-grants.ts";
import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../../auth/browser-session.ts";
import type { ResolvedPrincipal } from "../../../auth/types.ts";
import { withSystemScope } from "../../../db/index.ts";
import {
  executions,
  sessions,
  users,
  webhookHeldDeliveries,
  workflows,
} from "../../../db/schema/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { databaseNow } from "../../../test-helpers/database-clock.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { previewWorkflowAuthority } from "../../../workflows/execution-authorities.ts";
import { handleInbound } from "../service.ts";
import { createInboundCtx, type InboundTestCtx } from "./setup.ts";

const secret = "held-replay-on-grant-signing-key";
let ctx: InboundTestCtx;

beforeAll(async () => {
  ctx = await createInboundCtx("held-grant");
  await ctx.createBinding({ slug: "held-grant", verifier: "standard", secret });
});
afterAll(async () => {
  await ctx.cleanup();
});

function delivery(id: string, body: string) {
  const timestamp = Math.floor(getTestNow() / 1000);
  return {
    slug: "held-grant",
    rawBody: body,
    now: timestamp * 1000,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-type": "invoice.paid",
      "webhook-signature": `v1,${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
    },
  };
}

async function humanBrowser() {
  const now = await databaseNow(ctx.db);
  const [user] = await ctx.db
    .insert(users)
    .values({
      tenant_id: ctx.tenantId,
      email: "approver@example.test",
      role_id: await builtinRoleId(ctx.db, "admin"),
    })
    .returning();
  if (!user) throw new Error("missing user");
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: user.id,
      expires_at: new Date(now.getTime() + 3_600_000),
    })
    .returning();
  if (!session) throw new Error("missing session");
  const identity = { tenant_id: ctx.tenantId, user_id: user.id, session_id: session.id };
  const principal: ResolvedPrincipal = {
    provider: "session",
    kind: "user",
    id: user.id,
    tenant_id: ctx.tenantId,
    roles: ["admin"],
    session_id: session.id,
  };
  const request = new Request("https://example.test/grant", {
    method: "POST",
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(identity)),
      "x-subkit-csrf": await signBrowserCsrf(identity),
    },
  });
  return { principal, request, now };
}

test("a human approval replays every held delivery into exactly one execution", async () => {
  for (const [id, body] of [
    ["evt-1", '{"n":1}'],
    ["evt-2", '{"n":2}'],
    ["evt-1", '{"n":1}'],
  ] as const)
    expect(await handleInbound({ db: ctx.db, boss: ctx.boss }, delivery(id, body))).toMatchObject({
      status: "held",
    });
  const [workflow] = await ctx.db
    .select()
    .from(workflows)
    .where(and(eq(workflows.tenant_id, ctx.tenantId), eq(workflows.id, ctx.workflowId)));
  const versionId = workflow?.current_version_id ?? "";
  const review = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: ctx.workflowId,
      workflow_version_id: versionId,
      execution_environment: "prod",
    },
    ctx.db,
  );
  const { principal, request, now } = await humanBrowser();
  const operation = grantWorkflowAuthorityOperation(async () => ({ state: "not_requested" }));
  await operation.handler(
    {
      db: ctx.db,
      tenant_id: ctx.tenantId,
      principal,
      actor: { id: principal.id, type: "user" },
      request,
      boss: ctx.boss,
    },
    {
      id: ctx.workflowId,
      body: {
        workflow_version_id: versionId,
        expected_manifest_digest: review.digest,
        execution_environment: "prod",
        valid_from: now.toISOString(),
        valid_until: new Date(now.getTime() + 3_600_000).toISOString(),
        max_runs: 10,
      },
    },
  );
  const runs = await ctx.db.select().from(executions).where(eq(executions.tenant_id, ctx.tenantId));
  expect(runs).toHaveLength(2);
  const held = await withSystemScope(ctx.db, "test reads held deliveries", (tx) =>
    tx
      .select()
      .from(webhookHeldDeliveries)
      .where(eq(webhookHeldDeliveries.tenant_id, ctx.tenantId)),
  );
  expect(held.map((row) => row.state)).toEqual(["replayed", "replayed"]);
  expect(new Set(held.map((row) => row.execution_id))).toEqual(new Set(runs.map((run) => run.id)));
});
