import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { flushOidcBearerKeys } from "../../auth/providers/oidc-bearer.ts";
import { loadConfig } from "../../config/loader.ts";
import {
  apiKeys,
  workflowExecutionAuthorities,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { createWorkflowRow } from "../../execution/tests/setup.ts";
import { generateKey as generateApiKey } from "../../identity/api-key.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  BEARER_NOW_SECONDS,
  startTestBearerIssuer,
  type TestBearerIssuer,
} from "../../test-helpers/oidc-bearer-issuer.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

export let ctx: HttpTestServer;

let issuer: TestBearerIssuer;

export let brokenIssuer: TestBearerIssuer;

export let assistantId: string;

export let flowId: string;

export let brokenId: string;

let foreignAssistantId: string;

export let narrowKey: string;

export const TENANT_SLUG = "t-apps-view";

export let nextUuid = createDeterministicUuidFactory(517);

const fakeBoss = {
  send: async () => "queued",
} as unknown as PgBoss;

export function token(sub: string) {
  return issuer.mint({ sub }, { issuedAt: BEARER_NOW_SECONDS, expiresIn: 10 * 365 * 24 * 3600 });
}

export async function call(path: string, bearer: string | null, init: RequestInit = {}) {
  return fetch(`${ctx.baseUrl}${path}`, {
    ...init,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function run(bearer: string, turn_id: string, idempotency_key: string) {
  return call("/v1/executions", bearer, {
    method: "POST",
    body: JSON.stringify({
      workflow_id: assistantId,
      async: true,
      idempotency_key,
      input: { turn_id },
    }),
  });
}

export interface Summary {
  id: string;
  configured: boolean;
  ready: boolean;
  failing_checks: string[];
  users: { count: number; last_seen_at: string | null };
  workflow_count: number;
}

export function setupAppsHttp(): void {
  nextUuid = createDeterministicUuidFactory(517);
  beforeAll(async () => {
    ctx = await createHttpTestServer("apps-view", { appOptions: { boss: fakeBoss } });
    issuer = await startTestBearerIssuer();
    brokenIssuer = await startTestBearerIssuer();

    const assistant = await createWorkflowRow(ctx, {
      name: "apps-assistant",
      slug: "apps-assistant",
      product_id: "testapp",
      required_caller_kind: "user",
      execution_privacy: "sensitive",
      input_schema: {
        type: "object",
        required: ["turn_id"],
        properties: { turn_id: { type: "string" } },
      },
      steps: [{ id: "round", kind: "transform", expression: "return { done: true };" }],
      execution_guards: {
        caller_daily_limit: {
          bucket: "brain",
          limit: 5,
          tz: "Europe/Berlin",
          unit: "turn_id",
          billable_steps: ["round"],
          max_metered: 3,
          commit_when: "true",
        },
      },
    });
    assistantId = assistant.workflow_id;
    const preview = await previewWorkflowAuthority(
      {
        tenant_id: ctx.tenantId,
        workflow_id: assistant.workflow_id,
        workflow_version_id: assistant.version_id,
        execution_environment: "prod",
      },
      ctx.db,
    );
    await ctx.db.insert(workflowExecutionAuthorities).values({
      tenant_id: ctx.tenantId,
      workflow_id: assistant.workflow_id,
      workflow_version_id: assistant.version_id,
      effect_manifest_digest: preview.digest,
      effect_manifest: { ...preview.manifest },
      target_constraints: { targets: [] },
      execution_environment: "prod",
      valid_from: new Date(getTestNow() - 60_000),
      created_by: ctx.userId,
    });

    flowId = (
      await createWorkflowRow(ctx, {
        name: "apps-flow",
        slug: "apps-flow",
        product_id: "flowkit",
        steps: [{ id: "a", kind: "transform", expression: "return {};" }],
      })
    ).workflow_id;

    const [broken] = await ctx.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenantId,
        slug: "apps-broken",
        name: "apps-broken",
        lifecycle: "active",
      })
      .returning();
    if (!broken) throw new Error("broken workflow insert failed");
    brokenId = broken.id;
    const [brokenVersion] = await ctx.db
      .insert(workflowVersions)
      .values({
        tenant_id: ctx.tenantId,
        workflow_id: broken.id,
        version: 1,
        dag: { name: "apps-broken", product_id: "brokenkit", steps: [] },
      })
      .returning();
    if (!brokenVersion) throw new Error("broken version insert failed");
    const { eq } = await import("drizzle-orm");
    await ctx.db
      .update(workflows)
      .set({ current_version_id: brokenVersion.id })
      .where(eq(workflows.id, broken.id));

    const other = await seedTenant(ctx.db, { slug: "t-apps-other", display_name: "Other" });
    const otherCtx = { ...ctx, tenantId: other.id };
    foreignAssistantId = (
      await createWorkflowRow(otherCtx, {
        name: "secret-flow",
        product_id: "secretkit",
        steps: [{ id: "a", kind: "transform", expression: "return {};" }],
      })
    ).workflow_id;

    const narrow = generateApiKey();
    await ctx.db.insert(apiKeys).values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      prefix: narrow.prefix,
      token_sha256: narrow.hash,
      scopes: ["identity:read"],
    });
    narrowKey = narrow.plaintext;

    const dir = mkdtempSync(join(tmpdir(), "sk-apps-config-"));
    const file = join(dir, "subkit.config.json");
    await writeFile(
      file,
      JSON.stringify({
        auth: {
          providers: [
            { protocol: "api_key", id: "api-key", label: "SubKit API key" },
            issuer.provider({ tenant_slug: TENANT_SLUG }),
            brokenIssuer.provider({
              id: "broken-bearer",
              label: "Broken",
              product_id: "brokenkit",
              tenant_slug: TENANT_SLUG,
            }),
            issuer.provider({
              id: "orphan-bearer",
              label: "Orphan",
              issuer_url: "https://orphan.example.test",
              product_id: "orphankit",
              tenant_slug: TENANT_SLUG,
            }),
            issuer.provider({
              id: "other-bearer",
              label: "Other",
              issuer_url: "https://other.example.test",
              product_id: "otherkit",
              tenant_slug: "t-apps-other",
            }),
          ],
          enable_signup: false,
        },
        products: {
          testapp: {
            execution_environment: "prod",
            assistant_workflow_id: assistantId,
            budget_bucket: "brain",
          },
          brokenkit: {
            execution_environment: "prod",
            assistant_workflow_id: brokenId,
            budget_bucket: "brain",
          },
          secretkit: {
            execution_environment: "prod",
            assistant_workflow_id: foreignAssistantId,
            budget_bucket: "brain",
          },
        },
      }),
    );
    flushOidcBearerKeys();
    await loadConfig({
      env: { DATABASE_URL: ctx.testDb.url, NODE_ENV: "test" },
      configPathOverride: file,
    });
  }, 60_000);
  afterAll(async () => {
    await issuer?.stop();
    await brokenIssuer?.stop();
    if (ctx) await ctx.cleanup();
  }, 60_000);
}
