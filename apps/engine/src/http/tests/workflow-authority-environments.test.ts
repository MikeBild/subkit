import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import {
  connectors,
  tenants,
  workflows,
  workflowsSchedules,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { buildDefaultRegistry, createApp } from "../server.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let ctx: HttpTestServer;
let app: ReturnType<typeof createApp>;
const suffix = createDeterministicHexFactory(7);

beforeAll(async () => {
  ctx = await createHttpTestServer("workflow_authority_environments");
  app = createApp({ db: ctx.db, registry: buildDefaultRegistry(ctx.db) });
});
afterAll(async () => {
  await ctx.cleanup();
});

interface Assessment {
  possible: boolean;
  reasons: Array<{
    code: string;
    step_id: string;
    connector_id: string | null;
    connector_name: string | null;
  }>;
}

interface Preview {
  environments: { dev: Assessment; prod: Assessment };
  recommended_environment: { environment: "dev" | "prod" | null; reason: string };
  manifest: { issues: Array<{ step_id: string; code: string }> };
}

async function connector(
  slug: string,
  environment: "dev" | "prod",
  options: {
    auth_type?: "none" | "bearer";
    needs_reauth?: boolean;
    enabled?: boolean;
    deleted?: boolean;
    tenant_id?: string;
  } = {},
) {
  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: options.tenant_id ?? ctx.tenantId,
      enabled: options.enabled ?? true,
      deleted_at: options.deleted ? new Date("2026-01-01T00:00:00.000Z") : null,
      slug,
      display_name: `Support Admin ${slug}`,
      driver: "http",
      environment,
      auth_type: options.auth_type ?? "none",
      needs_reauth: options.needs_reauth ?? false,
      base_url: "https://support.example.test/api",
    })
    .returning();
  if (!row) throw new Error("missing connector fixture");
  return row;
}

async function workflowOf(steps: unknown[], lifecycle: "draft" | "active" = "draft") {
  const slug = `authority-environments-${suffix(6)}`;
  const [created] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenantId, slug, name: slug, lifecycle })
    .returning();
  if (!created) throw new Error("missing workflow fixture");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: created.id,
      version: 1,
      dag: { name: slug, steps },
    })
    .returning();
  if (!version) throw new Error("missing version fixture");
  if (lifecycle === "active")
    await ctx.db
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, created.id));
  return { workflow: created, version };
}

function workflow(connector_id: string) {
  return workflowOf([
    { id: "fetch", kind: "request", connector_id, method: "GET", path: "/tickets" },
  ]);
}

async function preview(
  target: Awaited<ReturnType<typeof workflow>>,
  environment: "dev" | "prod",
): Promise<Preview> {
  const response = await app.request(
    `/v1/workflows/${target.workflow.id}/versions/${target.version.id}/authority-preview?environment=${environment}`,
    { headers: { authorization: `Bearer ${ctx.apiKey}` } },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Preview;
}

async function both(target: Awaited<ReturnType<typeof workflow>>) {
  const dev = await preview(target, "dev");
  const prod = await preview(target, "prod");
  expect(prod.environments).toEqual(dev.environments);
  expect(prod.recommended_environment).toEqual(dev.recommended_environment);
  return { dev, prod };
}

test("a connector that exists only in Test makes Test the only possible approval", async () => {
  const slug = `dev-only-${suffix(6)}`;
  const devConnector = await connector(slug, "dev");
  const target = await workflow(devConnector.id);
  const { dev, prod } = await both(target);
  expect(dev.environments).toEqual({
    dev: { possible: true, reasons: [] },
    prod: {
      possible: false,
      reasons: [
        {
          code: "connector_missing",
          step_id: "fetch",
          connector_id: devConnector.id,
          connector_name: `Support Admin ${slug}`,
        },
      ],
    },
  });
  expect(dev.recommended_environment).toEqual({ environment: "dev", reason: "only_possible" });
  expect(prod.manifest.issues).toContainEqual({ step_id: "fetch", code: "environment_mismatch" });
  expect(dev.manifest.issues).not.toContainEqual({
    step_id: "fetch",
    code: "environment_mismatch",
  });
});

test("a Production schedule does not override a connector that exists only in Test", async () => {
  const devConnector = await connector(`dev-scheduled-${suffix(6)}`, "dev");
  const target = await workflow(devConnector.id);
  await ctx.db.insert(workflowsSchedules).values({
    tenant_id: ctx.tenantId,
    workflow_id: target.workflow.id,
    cron: "0 8 * * *",
    execution_mode: "prod",
  });
  const { dev } = await both(target);
  expect(dev.recommended_environment).toEqual({ environment: "dev", reason: "only_possible" });
});

test("a connector that exists only in Production makes Production the only possible approval", async () => {
  const prodConnector = await connector(`prod-only-${suffix(6)}`, "prod");
  const target = await workflow(prodConnector.id);
  const { dev } = await both(target);
  expect(dev.environments.prod).toEqual({ possible: true, reasons: [] });
  expect(dev.environments.dev.possible).toBe(false);
  expect(dev.environments.dev.reasons.map((reason) => reason.code)).toEqual(["connector_missing"]);
  expect(dev.recommended_environment).toEqual({ environment: "prod", reason: "only_possible" });
});

test("a connector in both environments follows the context", async () => {
  const slug = `both-${suffix(6)}`;
  const devConnector = await connector(slug, "dev");
  await connector(slug, "prod");
  const target = await workflow(devConnector.id);
  const manual = await both(target);
  expect(manual.dev.environments).toEqual({
    dev: { possible: true, reasons: [] },
    prod: { possible: true, reasons: [] },
  });
  expect(manual.dev.recommended_environment).toEqual({
    environment: "dev",
    reason: "started_manually",
  });
  await ctx.db.insert(workflowsSchedules).values({
    tenant_id: ctx.tenantId,
    workflow_id: target.workflow.id,
    cron: "0 8 * * *",
    execution_mode: "prod",
  });
  const scheduled = await both(target);
  expect(scheduled.dev.recommended_environment).toEqual({
    environment: "prod",
    reason: "schedule",
  });
});

test("a connector without sign-in is not possible until it is signed in", async () => {
  const slug = `signed-out-${suffix(6)}`;
  const devConnector = await connector(slug, "dev", { auth_type: "bearer" });
  const prodConnector = await connector(slug, "prod", { auth_type: "bearer", needs_reauth: true });
  const target = await workflow(devConnector.id);
  const signedOut = await both(target);
  expect(signedOut.dev.environments).toEqual({
    dev: {
      possible: false,
      reasons: [
        {
          code: "connector_without_sign_in",
          step_id: "fetch",
          connector_id: devConnector.id,
          connector_name: `Support Admin ${slug}`,
        },
      ],
    },
    prod: {
      possible: false,
      reasons: [
        {
          code: "connector_needs_sign_in_again",
          step_id: "fetch",
          connector_id: prodConnector.id,
          connector_name: `Support Admin ${slug}`,
        },
      ],
    },
  });
  expect(signedOut.dev.recommended_environment).toEqual({
    environment: null,
    reason: "none_possible",
  });
  await upsertCredential(
    {
      tenant_id: ctx.tenantId,
      connector_id: devConnector.id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "fixture-token" },
      actor_id: null,
    },
    ctx.db,
  );
  const signedIn = await both(target);
  expect(signedIn.dev.environments.dev).toEqual({ possible: true, reasons: [] });
  expect(signedIn.dev.recommended_environment).toEqual({
    environment: "dev",
    reason: "only_possible",
  });
});

test("a called workflow's connector decides for the calling step", async () => {
  const devConnector = await connector(`child-dev-${suffix(6)}`, "dev");
  const child = await workflow(devConnector.id);
  await ctx.db
    .update(workflows)
    .set({ lifecycle: "active", current_version_id: child.version.id })
    .where(eq(workflows.id, child.workflow.id));
  const slug = `authority-environments-parent-${suffix(6)}`;
  const [parent] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: ctx.tenantId, slug, name: slug, lifecycle: "draft" })
    .returning();
  if (!parent) throw new Error("missing parent fixture");
  const [version] = await ctx.db
    .insert(workflowVersions)
    .values({
      tenant_id: ctx.tenantId,
      workflow_id: parent.id,
      version: 1,
      dag: {
        name: slug,
        steps: [{ id: "delegate", kind: "call", workflow_id: child.workflow.id }],
      },
    })
    .returning();
  if (!version) throw new Error("missing parent version");
  const { dev } = await both({ workflow: parent, version });
  expect(dev.environments.dev).toEqual({ possible: true, reasons: [] });
  expect(dev.environments.prod.reasons).toEqual([
    {
      code: "connector_missing",
      step_id: "delegate",
      connector_id: devConnector.id,
      connector_name: devConnector.display_name,
    },
  ]);
  expect(dev.recommended_environment).toEqual({ environment: "dev", reason: "only_possible" });
});

test("a workflow without connector steps is possible in both environments", async () => {
  const target = await workflowOf([{ id: "shape", kind: "transform", expression: "1" }]);
  const { dev } = await both(target);
  expect(dev.environments).toEqual({
    dev: { possible: true, reasons: [] },
    prod: { possible: true, reasons: [] },
  });
  expect(dev.recommended_environment.environment).not.toBeNull();
});

test("a disabled connector is switched off in that environment only", async () => {
  const slug = `disabled-${suffix(6)}`;
  const devConnector = await connector(slug, "dev");
  const prodConnector = await connector(slug, "prod", { enabled: false });
  const { dev } = await both(await workflow(devConnector.id));
  expect(dev.environments.dev).toEqual({ possible: true, reasons: [] });
  expect(dev.environments.prod).toEqual({
    possible: false,
    reasons: [
      {
        code: "connector_switched_off",
        step_id: "fetch",
        connector_id: prodConnector.id,
        connector_name: `Support Admin ${slug}`,
      },
    ],
  });
});

test("a connector that needs sign-in again blocks only its environment", async () => {
  const slug = `reauth-${suffix(6)}`;
  const devConnector = await connector(slug, "dev");
  const prodConnector = await connector(slug, "prod", { needs_reauth: true });
  const { dev } = await both(await workflow(devConnector.id));
  expect(dev.environments.dev.possible).toBe(true);
  expect(dev.environments.prod.reasons).toEqual([
    {
      code: "connector_needs_sign_in_again",
      step_id: "fetch",
      connector_id: prodConnector.id,
      connector_name: `Support Admin ${slug}`,
    },
  ]);
});

test("a deleted connector counts as missing", async () => {
  const slug = `deleted-${suffix(6)}`;
  const devConnector = await connector(slug, "dev");
  await connector(slug, "prod", { deleted: true });
  const { dev } = await both(await workflow(devConnector.id));
  expect(dev.environments.dev.possible).toBe(true);
  expect(dev.environments.prod.reasons.map((reason) => reason.code)).toEqual(["connector_missing"]);
});

test("a connector referenced only by a placeholder is judged per environment", async () => {
  const slug = `placeholder-${suffix(6)}`;
  await connector(slug, "dev");
  const target = await workflowOf([
    { id: "fetch", kind: "request", method: "GET", url: `\${connector.${slug}.base_url}/tickets` },
  ]);
  const { dev } = await both(target);
  expect(dev.environments.dev).toEqual({ possible: true, reasons: [] });
  expect(dev.environments.prod).toEqual({
    possible: false,
    reasons: [
      {
        code: "connector_missing",
        step_id: "fetch",
        connector_id: null,
        connector_name: `Support Admin ${slug}`,
      },
    ],
  });
  expect(dev.recommended_environment).toEqual({ environment: "dev", reason: "only_possible" });
});

test("a placeholder with no connector in either environment names the slug", async () => {
  const slug = `nowhere-${suffix(6)}`;
  const target = await workflowOf([
    {
      id: "fetch",
      kind: "request",
      method: "GET",
      url: "https://support.example.test/tickets",
      headers: { authorization: `Bearer \${cred.${slug}.token}` },
    },
  ]);
  const { dev } = await both(target);
  for (const environment of ["dev", "prod"] as const)
    expect(dev.environments[environment].reasons).toEqual([
      { code: "connector_missing", step_id: "fetch", connector_id: null, connector_name: slug },
    ]);
  expect(dev.recommended_environment).toEqual({ environment: null, reason: "none_possible" });
});

test("a connector reached through nested calls decides for the outer calling step", async () => {
  const devConnector = await connector(`nested-dev-${suffix(6)}`, "dev");
  const leaf = await workflowOf(
    [{ id: "fetch", kind: "request", connector_id: devConnector.id, method: "GET", path: "/t" }],
    "active",
  );
  const middle = await workflowOf(
    [{ id: "inner", kind: "call", workflow_id: leaf.workflow.id }],
    "active",
  );
  const outer = await workflowOf([
    { id: "outer", kind: "call", workflow_slug: middle.workflow.slug },
  ]);
  const { dev } = await both(outer);
  expect(dev.environments.dev).toEqual({ possible: true, reasons: [] });
  expect(dev.environments.prod.reasons).toEqual([
    {
      code: "connector_missing",
      step_id: "outer",
      connector_id: devConnector.id,
      connector_name: devConnector.display_name,
    },
  ]);
});

test("workflows that call each other do not loop", async () => {
  const devConnector = await connector(`cycle-dev-${suffix(6)}`, "dev");
  const first = await workflowOf(
    [{ id: "fetch", kind: "request", connector_id: devConnector.id, method: "GET", path: "/t" }],
    "active",
  );
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: first.workflow.slug,
        steps: [
          {
            id: "fetch",
            kind: "request",
            connector_id: devConnector.id,
            method: "GET",
            path: "/t",
          },
          { id: "again", kind: "call", workflow_id: first.workflow.id },
        ],
      },
    })
    .where(eq(workflowVersions.id, first.version.id));
  const outer = await workflowOf([{ id: "outer", kind: "call", workflow_id: first.workflow.id }]);
  const { dev } = await both(outer);
  expect(dev.environments.dev.possible).toBe(true);
  expect(dev.environments.prod.possible).toBe(false);
});

test("a same-slug connector of another tenant never makes Production possible", async () => {
  const slug = `tenant-${suffix(6)}`;
  const devConnector = await connector(slug, "dev");
  const [other] = await ctx.db
    .insert(tenants)
    .values({ slug: `other-${suffix(6)}`, display_name: "Other tenant" })
    .returning();
  if (!other) throw new Error("missing second tenant");
  await connector(slug, "prod", { tenant_id: other.id });
  const direct = await both(await workflow(devConnector.id));
  expect(direct.dev.environments.prod.possible).toBe(false);
  const placeholder = await both(
    await workflowOf([
      { id: "fetch", kind: "request", method: "GET", url: `\${connector.${slug}.base_url}/t` },
    ]),
  );
  expect(placeholder.dev.environments.dev.possible).toBe(true);
  expect(placeholder.dev.environments.prod.possible).toBe(false);
  expect(placeholder.dev.environments.prod.reasons[0]?.code).toBe("connector_missing");
});
