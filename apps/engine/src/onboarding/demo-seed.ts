import { and, eq } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { resolveActor } from "../audit/recorders/types.ts";
import { AuditAction } from "../audit/types.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Executor } from "../db/client.ts";
import { workflows, workflowVersions } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { carriedSpecColumns, type VersionActor, versionAuthorColumns } from "../workflows/index.ts";
import { WorkflowDefSchema } from "../workflows/types.ts";

interface DemoWorkflowSpec {
  slug: string;
  name: string;
  description: string;
  dag: unknown;
}

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

interface SeedOnboardingDemoParams extends VersionActor {
  tenant_id: string;
  actor_id?: string | null;
}

interface SeedOnboardingDemoResult {
  created: string[];
  skipped: string[];
}

export async function seedOnboardingDemo(
  p: SeedOnboardingDemoParams,
  exec: Executor,
): Promise<SeedOnboardingDemoResult> {
  const actor = resolveActor({
    tenant_id: p.tenant_id,
    actor_id: p.actor_id ?? null,
    ...(p.actor_type !== undefined ? { actor_type: p.actor_type } : {}),
  });

  return exec.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, p.tenant_id);
    const created: string[] = [];
    const skipped: string[] = [];

    for (const spec of DEMO_WORKFLOWS) {
      WorkflowDefSchema.parse(spec.dag);

      const existing = await tx
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.tenant_id, p.tenant_id), eq(workflows.slug, spec.slug)))
        .limit(1);
      if (existing.length > 0) {
        skipped.push(spec.slug);
        continue;
      }

      const [wf] = await tx
        .insert(workflows)
        .values({
          tenant_id: p.tenant_id,
          slug: spec.slug,
          name: spec.name,
          lifecycle: "active",
        })
        .returning();
      if (!wf) throw new Error(`demo seed: workflow insert returned no row for ${spec.slug}`);

      const [version] = await tx
        .insert(workflowVersions)
        .values({
          ...versionAuthorColumns(actor),
          tenant_id: p.tenant_id,
          workflow_id: wf.id,
          version: 1,
          dag: spec.dag as object,
          ...carriedSpecColumns(null),
          note: "Seeded by onboarding-demo-seed.",
        })
        .returning();
      if (!version) {
        throw new Error(`demo seed: workflow_versions insert returned no row for ${spec.slug}`);
      }

      await tx
        .update(workflows)
        .set({ current_version_id: version.id })
        .where(eq(workflows.id, wf.id));

      await auditAwait(
        {
          tenant_id: p.tenant_id,
          ...actor,
          action: AuditAction.WORKFLOW_CREATED,
          resource_type: "workflow",
          resource_id: wf.id,
          result: "success",
          metadata: { slug: spec.slug, seeded: true },
        },
        tx,
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
  });
}
