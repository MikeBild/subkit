import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type {
  AppBudgetToday,
  AppSettings,
  AppSignIn,
  AppSummary,
  AppView,
  AppWorkflow,
} from "../api/app-schemas.ts";
import type { AuthProviderConfig, Config } from "../config/schema.ts";
import type { Db } from "../db/client.ts";
import { userIdentities, users, workflows, workflowVersions } from "../db/schema/index.ts";
import { readStoredDefinition } from "../workflows/stored-definition.ts";
import { bucketUsageToday } from "./caller-budget.ts";
import { productReadiness, storedProductId } from "./product-status.ts";

export type AppConfig = Pick<Config, "products" | "auth">;

export interface AppTenant {
  tenant_id: string;
  tenant_slug: string;
}

interface WorkflowFact {
  id: string;
  slug: string;
  name: string;
  lifecycle: AppWorkflow["lifecycle"];
  product_id: string | null;
  definition_valid: boolean;
}

interface UserFact {
  count: number;
  last_seen_at: string | null;
}

interface AppFacts {
  workflows: WorkflowFact[];
  users: Map<string, UserFact>;
  signIn: Map<string, AppSignIn[]>;
}

async function tenantWorkflows(db: Db, tenant_id: string): Promise<WorkflowFact[]> {
  const rows = await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      lifecycle: workflows.lifecycle,
      dag: workflowVersions.dag,
    })
    .from(workflows)
    .leftJoin(
      workflowVersions,
      and(
        eq(workflowVersions.tenant_id, workflows.tenant_id),
        eq(workflowVersions.id, workflows.current_version_id),
      ),
    )
    .where(and(eq(workflows.tenant_id, tenant_id), isNull(workflows.deleted_at)))
    .orderBy(asc(workflows.name));
  return rows.map((row) => {
    const stored = row.dag === null ? null : readStoredDefinition(row.dag);
    const definition = stored && !stored.invalid ? stored.definition : null;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      lifecycle: row.lifecycle,
      product_id: row.dag === null ? null : storedProductId(row.dag, definition),
      definition_valid: definition !== null,
    };
  });
}

async function tenantProductUsers(db: Db, tenant_id: string): Promise<Map<string, UserFact>> {
  const rows = await db
    .select({
      product_id: userIdentities.product_id,
      count: sql<number>`count(distinct ${userIdentities.user_id})::int`,
      last_seen_at: sql<
        string | null
      >`to_char(max(${userIdentities.last_seen_at}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    })
    .from(userIdentities)
    .innerJoin(
      users,
      and(eq(users.tenant_id, userIdentities.tenant_id), eq(users.id, userIdentities.user_id)),
    )
    .where(
      and(
        eq(userIdentities.tenant_id, tenant_id),
        isNotNull(userIdentities.product_id),
        isNull(users.deleted_at),
      ),
    )
    .groupBy(userIdentities.product_id);
  const result = new Map<string, UserFact>();
  for (const row of rows) {
    if (row.product_id)
      result.set(row.product_id, { count: row.count, last_seen_at: row.last_seen_at });
  }
  return result;
}

function signInOf(provider: AuthProviderConfig): { product_id: string; sign_in: AppSignIn } | null {
  if (provider.protocol === "oidc") {
    if (!provider.product_id) return null;
    return {
      product_id: provider.product_id,
      sign_in: {
        id: provider.id,
        label: provider.label,
        protocol: "oidc",
        issuer_url: provider.issuer_url,
        tenant_slug: provider.tenant_slug,
        audience: null,
        algorithms: null,
        required_claims: [],
        reject_anonymous: null,
      },
    };
  }
  if (provider.protocol === "oidc_bearer") {
    return {
      product_id: provider.product_id,
      sign_in: {
        id: provider.id,
        label: provider.label,
        protocol: "oidc_bearer",
        issuer_url: provider.issuer_url,
        tenant_slug: provider.tenant_slug,
        audience: provider.audience,
        algorithms: [...provider.algorithms],
        required_claims: provider.required_claims.map((claim) => ({
          path: claim.path,
          equals: claim.equals,
        })),
        reject_anonymous: provider.reject_anonymous,
      },
    };
  }
  return null;
}

export function tenantSignIn(
  providers: AuthProviderConfig[],
  tenant_slug: string,
): Map<string, AppSignIn[]> {
  const result = new Map<string, AppSignIn[]>();
  for (const provider of providers) {
    const entry = signInOf(provider);
    if (!entry || entry.sign_in.tenant_slug !== tenant_slug) continue;
    result.set(entry.product_id, [...(result.get(entry.product_id) ?? []), entry.sign_in]);
  }
  return result;
}

export function visibleAppIds(
  config: AppConfig,
  facts: {
    workflows: Pick<WorkflowFact, "id" | "product_id">[];
    users: Map<string, unknown>;
    signIn: Map<string, unknown>;
  },
): string[] {
  const ids = new Set<string>(facts.signIn.keys());
  const workflowIds = new Set(facts.workflows.map((workflow) => workflow.id));
  for (const [id, product] of Object.entries(config.products)) {
    if (workflowIds.has(product.assistant_workflow_id)) ids.add(id);
  }
  for (const workflow of facts.workflows) if (workflow.product_id) ids.add(workflow.product_id);
  for (const id of facts.users.keys()) ids.add(id);
  return [...ids].sort();
}

async function gatherFacts(db: Db, tenant: AppTenant, config: AppConfig): Promise<AppFacts> {
  const [workflowFacts, userFacts] = await Promise.all([
    tenantWorkflows(db, tenant.tenant_id),
    tenantProductUsers(db, tenant.tenant_id),
  ]);
  return {
    workflows: workflowFacts,
    users: userFacts,
    signIn: tenantSignIn(config.auth.providers, tenant.tenant_slug),
  };
}

async function buildApp(
  db: Db,
  tenant: AppTenant,
  config: AppConfig,
  facts: AppFacts,
  app_id: string,
  withBudget: boolean,
): Promise<AppView> {
  const product = config.products[app_id] ?? null;
  const sign_in = facts.signIn.get(app_id) ?? [];
  const readiness = await productReadiness(db, {
    tenant_id: tenant.tenant_id,
    product_id: app_id,
    product,
    sign_in,
  });
  const assistantId = product?.assistant_workflow_id ?? null;
  const appWorkflows: AppWorkflow[] = facts.workflows
    .filter((workflow) => workflow.product_id === app_id || workflow.id === assistantId)
    .map((workflow) => ({
      id: workflow.id,
      slug: workflow.slug,
      name: workflow.name,
      lifecycle: workflow.lifecycle,
      is_assistant: workflow.id === assistantId,
      definition_valid: workflow.definition_valid,
    }));
  const guard = readiness.record?.definition?.execution_guards?.caller_daily_limit ?? null;
  const settings: AppSettings | null = product
    ? {
        execution_environment: product.execution_environment,
        budget_bucket: product.budget_bucket,
        assistant_workflow: {
          id: product.assistant_workflow_id,
          name: readiness.record?.name ?? null,
          slug: readiness.record?.slug ?? null,
        },
        daily_limit: guard
          ? { bucket: guard.bucket, limit_per_caller: guard.limit, unit: guard.unit, tz: guard.tz }
          : null,
      }
    : null;
  let budget_today: AppBudgetToday | null = null;
  if (withBudget && product && guard) {
    budget_today = await bucketUsageToday(db, {
      tenant_id: tenant.tenant_id,
      product_id: app_id,
      bucket: guard.bucket,
      tz: guard.tz,
      workflow_ids: appWorkflows.map((workflow) => workflow.id),
    });
  }
  return {
    id: app_id,
    configured: product !== null,
    ready: readiness.checks.every((item) => item.ok),
    settings,
    sign_in_count: sign_in.length,
    workflow_count: appWorkflows.length,
    users: facts.users.get(app_id) ?? { count: 0, last_seen_at: null },
    sign_in,
    workflows: appWorkflows,
    budget_today,
    checks: readiness.checks,
  };
}

function summaryOf(view: AppView): AppSummary {
  return {
    id: view.id,
    configured: view.configured,
    ready: view.ready,
    settings: view.settings,
    sign_in_count: view.sign_in_count,
    workflow_count: view.workflow_count,
    users: view.users,
    failing_checks: view.checks.filter((item) => !item.ok).map((item) => item.key),
  };
}

export async function listApps(
  db: Db,
  tenant: AppTenant,
  config: AppConfig,
): Promise<AppSummary[]> {
  const facts = await gatherFacts(db, tenant, config);
  const summaries: AppSummary[] = [];
  for (const id of visibleAppIds(config, facts)) {
    summaries.push(summaryOf(await buildApp(db, tenant, config, facts, id, false)));
  }
  return summaries;
}

export async function getApp(
  db: Db,
  tenant: AppTenant,
  config: AppConfig,
  app_id: string,
): Promise<AppView | null> {
  const facts = await gatherFacts(db, tenant, config);
  if (!visibleAppIds(config, facts).includes(app_id)) return null;
  return buildApp(db, tenant, config, facts, app_id, true);
}
