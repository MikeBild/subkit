import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { executions, workflowVersions } from "../db/schema/index.ts";
import { runExecution } from "../execution/engine.ts";
import { recoverExecutionPayload } from "../execution/sensitive-payload.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { testEnv } from "../test-helpers/determinism/env.ts";
import { withSelfHostedDriverFetchForTests } from "../test-helpers/driver-fetch.ts";
import { handleInbound } from "../webhooks/inbound/service.ts";
import { createInboundCtx, type InboundTestCtx } from "../webhooks/inbound/tests/setup.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { pinnedRecipeDefinition, recipeDeliveryBinding } from "../workflows/recipe-origin.ts";
import { bindRecipe, listTemplateConnectors, rebindConnectorIds } from "./recipe-binding.ts";
import { createConnector } from "./service.ts";
import { getSolutionRecipe } from "./solutions.ts";
import { type ConnectorRecipe, loadBuiltinTemplates } from "./templates.ts";

const skip = testEnv.REQUIRES_PG === "0";

let ctx: InboundTestCtx;
let recipe: ConnectorRecipe;
let accessApi: string;
let hookId: string;
const signingValue = "isolated-stripe-signing-value";

async function connector(slug: string, template: string, base_url?: string): Promise<string> {
  const created = await createConnector(
    {
      tenant_id: ctx.tenantId,
      input: {
        name: slug,
        slug,
        driver: "http",
        environment: "prod",
        auth_type: "none",
        template_slug: template,
        ...(base_url ? { base_url } : {}),
      },
      actor_id: null,
    },
    ctx.db,
  );
  return created.id;
}

beforeAll(async () => {
  if (skip) return;
  const found = getSolutionRecipe("payment-grants-access");
  if (!found) throw new Error("payment-grants-access missing");
  recipe = found;
  ctx = await createInboundCtx("payment-solution-authority");
  await connector("stripe", "stripe");
  await connector("google-gmail", "google-gmail");
  accessApi = await connector("access-api", "http", "https://access.example.com");
  const hook = await ctx.createBinding({
    slug: "payment-solution-stripe",
    verifier: "stripe",
    secret: signingValue,
    native_verifier_config: { source: "stripe", events: ["checkout.session.completed"] },
  });
  hookId = hook.id;
}, 60_000);

afterAll(async () => {
  if (!skip) await ctx?.cleanup();
}, 30_000);

async function installedDefinition(): Promise<unknown> {
  const needed = recipe.required_connectors.map((r) => r.template);
  const available = await listTemplateConnectors(ctx.tenantId, needed, ctx.db);
  const templates = new Map(
    loadBuiltinTemplates().map((t) => [t.slug, { name: t.name, base_url: t.base_url }]),
  );
  const bound = bindRecipe(recipe, available, templates);
  const unbound = bound.connectors.filter((c) => c.connector_id === null);
  expect(unbound.map((c) => c.template)).toEqual(["http"]);
  return rebindConnectorIds(
    bound.workflow,
    Object.fromEntries(unbound.map((c) => [c.placeholder, accessApi])),
  );
}

async function previewOf(definition: unknown) {
  const [version] = await ctx.db
    .select({ id: workflowVersions.id })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.tenant_id, ctx.tenantId),
        eq(workflowVersions.workflow_id, ctx.workflowId),
      ),
    );
  if (!version) throw new Error("missing fixture version");
  await ctx.db
    .update(workflowVersions)
    .set({ dag: definition as Record<string, unknown> })
    .where(and(eq(workflowVersions.tenant_id, ctx.tenantId), eq(workflowVersions.id, version.id)));
  return previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: ctx.workflowId,
      workflow_version_id: version.id,
      execution_environment: "prod",
    },
    ctx.db,
  );
}

function signedCheckout(id: string, session: string, email: string) {
  const timestamp = Math.floor(getTestNow() / 1000);
  const rawBody = JSON.stringify({
    id,
    type: "checkout.session.completed",
    data: {
      object: { id: session, customer_details: { email }, metadata: { access_group: "members" } },
    },
  });
  const signature = createHmac("sha256", signingValue)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return {
    slug: "payment-solution-stripe",
    rawBody,
    now: timestamp * 1000,
    headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
  };
}

async function execute(id: string) {
  const [row] = await ctx.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, id)));
  if (!row) throw new Error("missing admitted execution");
  return runExecution({
    db: ctx.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id: ctx.workflowId },
    input: recoverExecutionPayload(row.input, ctx.tenantId, id),
    options: {
      resume_authorized: true,
      existing_execution_id: id,
      execution_mode: "prod",
      request_source: "webhook",
    },
  });
}

const origin = { vertical: "solutions", slug: "payment-grants-access" };

describe.skipIf(skip)("paid checkout solution approval needs its install inputs", () => {
  test("without the sender the install is refused and the uninstalled recipe is not approvable", async () => {
    const definition = await installedDefinition();
    expect(pinnedRecipeDefinition(origin, definition)).toEqual({
      ok: false,
      reason: "recipe_input_missing",
      message:
        "install input sender of recipe solutions/payment-grants-access is required: it must be one plain email address of the sending mailbox",
    });
    const preview = await previewOf(definition);
    expect(preview.eligible_for_repeated_runs).toBe(false);
    expect(preview.unavailable_steps).toContain("send_welcome");
  });

  test("with the sender and its own Stripe binding the checkout is approved and fulfilled once", async () => {
    const pinned = pinnedRecipeDefinition(
      { ...origin, inputs: { sender: "team@example.com" } },
      await installedDefinition(),
    );
    if (!pinned.ok) throw new Error(pinned.message);
    const delivery = recipeDeliveryBinding(pinned.definition);
    if (!delivery) throw new Error("payment-grants-access has no transactional delivery");
    const installed = JSON.parse(
      JSON.stringify(delivery.definition).replaceAll(delivery.binding_id, hookId),
    );
    expect(JSON.stringify(installed)).not.toContain("install-input.invalid");
    const preview = await previewOf(installed);
    expect({
      eligible: preview.eligible_for_repeated_runs,
      unavailable: preview.unavailable_steps,
      refusals: preview.request_refusals,
    }).toEqual({ eligible: true, unavailable: [], refusals: [] });
    await ctx.grantAuthority("prod", 5);
    const calls: Array<{ method: string; url: URL; body: string }> = [];
    const transport = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input));
        const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
        const raw = init?.body ?? (request ? await request.text() : "");
        calls.push({ method, url, body: typeof raw === "string" ? raw : String(raw ?? "") });
        if (url.pathname.endsWith("/checkout/sessions/cs_paid_0001"))
          return Response.json({ id: "cs_paid_0001", payment_status: "paid" });
        if (url.pathname === "/access/grants") return Response.json({ granted: true });
        if (url.pathname.endsWith("/users/me/messages/send"))
          return Response.json({ id: "msg-welcome-1" });
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
      { preconnect: () => {} },
    ) as typeof fetch;
    await withSelfHostedDriverFetchForTests(transport, async () => {
      const admitted = await handleInbound(
        { db: ctx.db, boss: ctx.boss },
        signedCheckout("evt_paid_0001", "cs_paid_0001", "buyer@example.com"),
      );
      if (admitted.status !== "ok") throw new Error(`admission ${admitted.status}`);
      const result = await execute(admitted.execution_id);
      expect({ status: result.status, error: result.error, output: result.output }).toEqual({
        status: "succeeded",
        error: null,
        output: {
          status: "granted",
          email: "buyer@example.com",
          group: "members",
          message_id: "msg-welcome-1",
        },
      });
      const replay = await handleInbound(
        { db: ctx.db, boss: ctx.boss },
        signedCheckout("evt_paid_0001", "cs_paid_0001", "buyer@example.com"),
      );
      expect(replay.status).toBe("deduped");
    });
    expect(calls.map((call) => `${call.method} ${call.url.hostname}${call.url.pathname}`)).toEqual([
      "GET api.stripe.com/v1/checkout/sessions/cs_paid_0001",
      "POST access.example.com/access/grants",
      "POST gmail.googleapis.com/gmail/v1/users/me/messages/send",
    ]);
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      email: "buyer@example.com",
      group: "members",
      reference: "cs_paid_0001",
    });
    const mime = Buffer.from(JSON.parse(calls[2]?.body ?? "{}").raw, "base64url").toString("utf8");
    expect(mime).toContain("To: buyer@example.com");
    expect(mime).toContain("From: team@example.com");
  });
});
