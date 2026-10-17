import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { rotateOAuth2Tokens, upsertCredential } from "../../credentials/service.ts";
import { connectors, tenants, workflows, workflowVersions } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { capturePreparedWorkflowReferences } from "../../execution/prepared-workflow-references.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { resolveWorkflowEffectManifest } from "../effect-resolution.ts";
import { WorkflowDefSchema } from "../types.ts";

let ctx: TestDb;
let counter = 0;
beforeAll(async () => {
  ctx = await createTestDb("effect_resolution");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function fixture(request: Record<string, unknown> = {}) {
  const slug = `effect-resolution-${++counter}`;
  const [tenant] = await ctx.db.insert(tenants).values({ slug, display_name: slug }).returning();
  if (!tenant) throw new Error("missing tenant fixture");
  const [connector] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenant.id,
      slug,
      display_name: slug,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test/api/v1",
    })
    .returning();
  const [workflow] = await ctx.db
    .insert(workflows)
    .values({
      tenant_id: tenant.id,
      slug,
      name: slug,
      lifecycle: "draft",
    })
    .returning();
  if (!connector || !workflow) throw new Error("missing workflow fixture");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      version: 1,
      dag: {
        name: slug,
        steps: [
          {
            id: "send",
            kind: "request",
            method: "POST",
            connector_id: connector.id,
            path: "/api/v1/messages",
            body: { recipient: "reviewed@example.test", text: "Hello" },
            ...request,
          },
        ],
      },
    })
    .returning();
  if (!version) throw new Error("missing version fixture");
  return {
    connector,
    input: {
      tenant_id: tenant.id,
      workflow_id: workflow.id,
      workflow_version_id: version.id,
      execution_environment: "dev" as "dev" | "prod",
      execution_options_digest: "a".repeat(64),
    },
  };
}

test("resolves the stored exact version with the runtime HTTP path-joining rules", async () => {
  const f = await fixture();
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects[0]?.target).toBe("https://example.test/api/v1/messages");
  expect(result.manifest.effects[0]?.effect).toBe("write");
  expect(await resolveWorkflowEffectManifest(f.input, ctx.db)).toEqual(result);
});

test("does not accept caller-supplied definitions or binding claims", async () => {
  const f = await fixture();
  await expect(
    resolveWorkflowEffectManifest({ ...f.input, bindings: [] }, ctx.db),
  ).rejects.toThrow();
  await expect(
    resolveWorkflowEffectManifest({ ...f.input, definition: {} }, ctx.db),
  ).rejects.toThrow();
});

test("GraphQL binds its single endpoint rather than an HTTP path join", async () => {
  const f = await fixture({
    graphql: { operation: "query", query: "mutation { sendMessage { id } }" },
  });
  await ctx.db
    .update(connectors)
    .set({ driver: "graphql", base_url: "https://example.test/graphql" })
    .where(eq(connectors.id, f.connector.id));
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects[0]).toMatchObject({
    target: "https://example.test/graphql",
    effect: "write",
    operation: "mutation",
  });
});

test("tenant, workflow and deleted-workflow boundaries are enforced", async () => {
  const f = await fixture();
  const other = await fixture();
  for (const patch of [
    { tenant_id: other.input.tenant_id },
    { workflow_id: other.input.workflow_id },
  ]) {
    await expect(
      resolveWorkflowEffectManifest({ ...f.input, ...patch }, ctx.db),
    ).rejects.toMatchObject({ code: "workflow_version_unavailable" });
  }
  await ctx.db
    .update(workflows)
    .set({ deleted_at: await databaseNow(ctx.db) })
    .where(eq(workflows.id, f.input.workflow_id));
  await expect(resolveWorkflowEffectManifest(f.input, ctx.db)).rejects.toMatchObject({
    code: "workflow_version_unavailable",
  });
});

test("environment fallback fails closed and an exact environment replacement is digest-bound", async () => {
  const f = await fixture();
  const input = { ...f.input, execution_environment: "prod" as const };
  const fallback = await resolveWorkflowEffectManifest(input, ctx.db);
  expect(fallback.eligible_for_repeated_runs).toBe(false);
  expect(fallback.manifest.issues).toContainEqual({
    step_id: "send",
    code: "environment_mismatch",
  });
  await ctx.db.insert(connectors).values({
    tenant_id: f.input.tenant_id,
    slug: f.connector.slug,
    display_name: "Production",
    driver: "http",
    environment: "prod",
    auth_type: "none",
    base_url: f.connector.base_url,
  });
  const exact = await resolveWorkflowEffectManifest(input, ctx.db);
  expect(exact.eligible_for_repeated_runs).toBe(true);
  expect(exact.digest).not.toBe(fallback.digest);
  expect(exact.manifest.effects[0]?.environment).toBe("prod");
});

test("configuration changes alter the binding while temporary availability stays separate", async () => {
  const f = await fixture();
  const before = await resolveWorkflowEffectManifest(f.input, ctx.db);
  await ctx.db.update(connectors).set({ enabled: false }).where(eq(connectors.id, f.connector.id));
  const disabled = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(disabled.digest).toBe(before.digest);
  expect(disabled.eligible_for_repeated_runs).toBe(false);
  expect(disabled.unavailable_steps).toEqual(["send"]);
  await ctx.db
    .update(connectors)
    .set({ enabled: true, config: { static_query: { recipient: "other" } } })
    .where(eq(connectors.id, f.connector.id));
  expect((await resolveWorkflowEffectManifest(f.input, ctx.db)).digest).not.toBe(before.digest);
});

test("the preview names the unavailable connector exactly as the run admission refuses it", async () => {
  const f = await fixture();
  const [version] = await ctx.db
    .select({ dag: workflowVersions.dag })
    .from(workflowVersions)
    .where(eq(workflowVersions.id, f.input.workflow_version_id));
  const definition = WorkflowDefSchema.parse(version?.dag);
  const healthy = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(healthy.unavailable_connectors).toEqual([]);
  for (const [patch, reason] of [
    [{ needs_reauth: true }, "needs_reauth"],
    [{ needs_reauth: false, enabled: false }, "disabled"],
    [{ enabled: true, auth_type: "bearer" as const }, "credential_unavailable"],
  ] as const) {
    await ctx.db.update(connectors).set(patch).where(eq(connectors.id, f.connector.id));
    const preview = await resolveWorkflowEffectManifest(f.input, ctx.db);
    expect(preview.unavailable_connectors).toEqual([
      {
        step_id: "send",
        connector_id: f.connector.id,
        connector_slug: f.connector.slug,
        connector_name: f.connector.display_name,
        reason,
      },
    ]);
    if (reason !== "credential_unavailable") expect(preview.digest).toBe(healthy.digest);
    await expect(
      capturePreparedWorkflowReferences(ctx.db, f.input.tenant_id, "dev", definition),
    ).rejects.toMatchObject({
      code: "prepared_credential_unavailable",
      details: {
        step_id: "send",
        connector_id: f.connector.id,
        connector_slug: f.connector.slug,
        environment: "dev",
        reason,
      },
    });
  }
});

test("OAuth refresh retains the binding but changed scopes require reauthorization", async () => {
  const f = await fixture();
  await ctx.db
    .update(connectors)
    .set({ auth_type: "oauth2" })
    .where(eq(connectors.id, f.connector.id));
  expect((await resolveWorkflowEffectManifest(f.input, ctx.db)).eligible_for_repeated_runs).toBe(
    false,
  );
  const credential = await upsertCredential(
    {
      tenant_id: f.input.tenant_id,
      connector_id: f.connector.id,
      environment: "dev",
      mode: "oauth2",
      actor_id: null,
      value: {
        mode: "oauth2",
        access_token: "fixture-secret",
        token_type: "Bearer",
        scope: "read write",
      },
    },
    ctx.db,
  );
  const before = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(before.eligible_for_repeated_runs).toBe(true);
  expect(JSON.stringify(before)).not.toContain("fixture-secret");
  const rotate = {
    tenant_id: f.input.tenant_id,
    credential_id: credential.id,
    access_token: "rotated-fixture-secret",
    actor_id: null,
  };
  await rotateOAuth2Tokens(rotate, ctx.db);
  expect((await resolveWorkflowEffectManifest(f.input, ctx.db)).digest).toBe(before.digest);
  await rotateOAuth2Tokens({ ...rotate, scope: "admin" }, ctx.db);
  expect((await resolveWorkflowEffectManifest(f.input, ctx.db)).digest).not.toBe(before.digest);
});

test("response-driven pagination cannot authorize a changing body recipient", async () => {
  const f = await fixture({
    pagination: {
      strategy: "cursor",
      cursor_request_param: "recipient",
      cursor_response_path: "next",
      parameter_location: "body",
    },
  });
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.eligible_for_repeated_runs).toBe(false);
  expect(result.manifest.issues).toContainEqual({ step_id: "send", code: "dynamic_request" });
});

test("a paginating read whose boundary names its paging keys is not a rewritten target", async () => {
  const paged = await fixture({
    method: "GET",
    body: undefined,
    path: "/api/v1/messages",
    pagination: {
      strategy: "cursor",
      cursor_request_param: "start_cursor",
      cursor_response_path: "$.next",
      max_pages: 6,
    },
    boundary: { variables: {}, max_body_bytes: 0, max_calls: 1 },
  });
  const bound = await resolveWorkflowEffectManifest(paged.input, ctx.db);
  expect(bound.manifest.issues).toEqual([]);
  expect(bound.eligible_for_repeated_runs).toBe(true);
  expect(bound.manifest.effects[0]?.rewrites_target).toBe(false);
  expect(bound.manifest.effects[0]?.boundary?.pagination).toEqual({
    params: ["start_cursor"],
    max_requests: 6,
  });

  const open = await fixture({
    method: "GET",
    body: undefined,
    path: "/api/v1/messages",
    pagination: {
      strategy: "cursor",
      cursor_request_param: "start_cursor",
      cursor_response_path: "$.next",
      max_pages: 6,
    },
  });
  const unbound = await resolveWorkflowEffectManifest(open.input, ctx.db);
  expect(unbound.eligible_for_repeated_runs).toBe(false);
  expect(unbound.manifest.effects[0]?.rewrites_target).toBe(true);
});

test("connectorless credential-bearing URLs never become reusable display targets", async () => {
  const f = await fixture({
    connector_id: undefined,
    path: undefined,
    url: "https://user:fixture-secret@example.test/messages",
  });
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.eligible_for_repeated_runs).toBe(false);
  expect(result.manifest.effects[0]?.target).toBeNull();
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
});

test("documentation placeholders do not turn a fixed request into a dynamic target", async () => {
  const f = await fixture();
  await ctx.db
    .update(connectors)
    .set({
      template_snapshot: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: documentation fixture
        documentation: { examples: ["GET /items/${id}"] },
      },
    })
    .where(eq(connectors.id, f.connector.id));
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects[0]?.rewrites_target).toBe(false);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: runtime configuration fixture
  await ctx.db
    .update(connectors)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored runtime-expression fixture
    .set({ config: { static_headers: { "X-Target": "${input.destination}" } } })
    .where(eq(connectors.id, f.connector.id));
  expect((await resolveWorkflowEffectManifest(f.input, ctx.db)).eligible_for_repeated_runs).toBe(
    false,
  );
});

test("resolves S3 scope from the loaded connector without a network probe", async () => {
  const f = await fixture({
    method: "PUT",
    path: undefined,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored runtime-expression fixture
    body: "${input.report}",
    s3: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: authored runtime-expression fixture
      key: "${input.key}",
      content_type: "application/json",
      scope: { key_prefix: "reports/daily/", max_bytes: 1000 },
    },
  });
  await ctx.db
    .update(connectors)
    .set({
      driver: "s3",
      base_url: null,
      config: { endpoint: "https://store.example.test", bucket: "bucket", region: "us-east-1" },
    })
    .where(eq(connectors.tenant_id, f.input.tenant_id));
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db, { include_review: true });
  expect(result.eligible_for_repeated_runs).toBe(true);
  expect(result.manifest.effects[0]?.storage?.base_url).toBe("https://store.example.test/bucket/");
  expect(result.execution_shape?.requests[0]?.opaque_payload_omitted).toBe(false);
  expect(result.execution_shape?.requests[0]?.redacted_request_json).toContain("reports/daily/");
});

test("a read whose only runtime values are in its query is admitted without a request refusal", async () => {
  const f = await fixture({
    method: "GET",
    path: "/api/v1/stats",
    body: undefined,
    side_effects: "read",
    query: { from: "${scope.window.data.start}", bucket: "hour" },
  });
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.request_refusals).toEqual([]);
  expect(result.manifest.issues).toEqual([]);
  expect(result.eligible_for_repeated_runs).toBe(true);
});

test("a read whose only runtime value is a path identifier is admitted without a request refusal", async () => {
  const f = await fixture({
    method: "GET",
    path: "/api/v1/items/${scope.pick.data.id}",
    body: undefined,
    side_effects: "read",
  });
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.request_refusals).toEqual([]);
  expect(result.eligible_for_repeated_runs).toBe(true);
});

test("a write with runtime values and no boundary is still refused", async () => {
  const f = await fixture({ body: { recipient: "${input.to}", text: "Hello" } });
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.request_refusals.map((refusal) => refusal.reason)).toContain("no_boundary");
  expect(result.eligible_for_repeated_runs).toBe(false);
});

test("a read with a runtime header is still refused", async () => {
  const f = await fixture({
    method: "GET",
    path: "/api/v1/stats",
    body: undefined,
    side_effects: "read",
    query: { from: "${scope.window.data.start}" },
    headers: { "x-trace": "${input.trace}" },
  });
  const result = await resolveWorkflowEffectManifest(f.input, ctx.db);
  expect(result.request_refusals.length).toBeGreaterThan(0);
  expect(result.eligible_for_repeated_runs).toBe(false);
});
