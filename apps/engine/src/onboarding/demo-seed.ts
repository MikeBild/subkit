// OnboardingDemoSeed — curated starter workflows for a fresh tenant.
//
// When someone opens the portal for the first time we want *something to
// run*, not an empty workspace. These three workflows point at public APIs
// that need no credentials so the very first `POST /v1/executions` call
// succeeds.
//
// The seed is idempotent: re-running against a tenant that already has
// any of the demo slugs is a no-op per slug. Call once per tenant from
// HTTP onboarding, CLI onboarding, or db/seed.ts#seedDevFixtures.

import { and, eq } from "drizzle-orm";

import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { WorkflowDefSchema } from "../workflows/types.ts";

export interface DemoWorkflowSpec {
  slug: string;
  name: string;
  description: string;
  dag: unknown;
}

/**
 * All demo workflows shipped with a fresh tenant. Every DAG round-trips
 * through WorkflowDefSchema so a schema drift test fails at seed time,
 * not at first execution.
 */
export const DEMO_WORKFLOWS: ReadonlyArray<DemoWorkflowSpec> = [
  {
    slug: "demo-httpbin-echo",
    name: "Demo — httpbin echo",
    description:
      "Smallest possible end-to-end run. GETs httpbin.org/json, proves the engine can reach the public internet and record a successful step.",
    dag: {
      name: "Demo — httpbin echo",
      slug: "demo-httpbin-echo",
      description:
        "Smallest possible end-to-end run. GETs httpbin.org/json, proves the engine can reach the public internet and record a successful step.",
      steps: [
        {
          kind: "request",
          id: "fetch_json",
          method: "GET",
          url: "https://httpbin.org/json",
        },
      ],
    },
  },
  {
    slug: "demo-github-public-repos",
    name: "Demo — list public GitHub repos",
    description:
      "Two-step workflow: fetch a public org's repos, pick the top five names. Shows request + transform without any auth.",
    dag: {
      name: "Demo — list public GitHub repos",
      slug: "demo-github-public-repos",
      description:
        "Two-step workflow: fetch a public org's repos, pick the top five names. Shows request + transform without any auth.",
      steps: [
        {
          kind: "request",
          id: "fetch_repos",
          method: "GET",
          url: "https://api.github.com/orgs/github/repos?per_page=10",
          headers: { accept: "application/vnd.github+json" },
        },
        {
          kind: "transform",
          id: "top_names",
          language: "javascript",
          // JS slice + map: take the first 5 elements, keep name + stars.
          expression:
            "return (input.scope.fetch_repos.data || []).slice(0, 5).map((r) => ({ name: r.name, stars: r.stargazers_count }));",
        },
      ],
    },
  },
  {
    slug: "demo-open-meteo-weather",
    name: "Demo — weather for Berlin (open-meteo)",
    description:
      "Single-request workflow using a free, no-auth weather API. Good smoke test for geographic endpoints with query params.",
    dag: {
      name: "Demo — weather for Berlin (open-meteo)",
      slug: "demo-open-meteo-weather",
      description:
        "Single-request workflow using a free, no-auth weather API. Good smoke test for geographic endpoints with query params.",
      steps: [
        {
          kind: "request",
          id: "fetch_weather",
          method: "GET",
          url: "https://api.open-meteo.com/v1/forecast",
          query: {
            latitude: "52.52",
            longitude: "13.41",
            current: "temperature_2m,wind_speed_10m",
          },
        },
      ],
    },
  },
];

export interface SeedOnboardingDemoParams {
  tenant_id: string;
  actor_id?: string | null;
}

export interface SeedOnboardingDemoResult {
  created: string[];
  skipped: string[];
}

export async function seedOnboardingDemo(
  p: SeedOnboardingDemoParams,
  exec: Executor,
): Promise<SeedOnboardingDemoResult> {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const spec of DEMO_WORKFLOWS) {
    // Validate the DAG every run so a typo in the seed surfaces as a loud
    // unit-test failure instead of a silent runtime error at first execute.
    WorkflowDefSchema.parse(spec.dag);

    const existing = await exec
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, p.tenant_id), eq(workflows.slug, spec.slug)))
      .limit(1);
    if (existing.length > 0) {
      skipped.push(spec.slug);
      continue;
    }

    const [wf] = await exec
      .insert(workflows)
      .values({
        tenant_id: p.tenant_id,
        slug: spec.slug,
        name: spec.name,
        lifecycle: "active",
      })
      .returning();
    if (!wf) throw new Error(`demo seed: workflow insert returned no row for ${spec.slug}`);

    const [version] = await exec
      .insert(workflowVersions)
      .values({
        tenant_id: p.tenant_id,
        workflow_id: wf.id,
        version: 1,
        dag: spec.dag as object,
        note: "Seeded by onboarding-demo-seed.",
      })
      .returning();
    if (!version) {
      throw new Error(`demo seed: workflow_versions insert returned no row for ${spec.slug}`);
    }

    await exec
      .update(workflows)
      .set({ current_version_id: version.id })
      .where(eq(workflows.id, wf.id));

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id ?? null,
        action: AuditAction.WORKFLOW_CREATED,
        resource_type: "workflow",
        resource_id: wf.id,
        result: "success",
        metadata: { slug: spec.slug, seeded: true },
      },
      exec,
    );
    created.push(spec.slug);
  }

  logger.info({
    module: "onboarding",
    action: "demo_seed.completed",
    msg: "onboarding demo seed completed",
    tenant_id: p.tenant_id,
    created,
    skipped,
  });

  return { created, skipped };
}
