import { and, eq, isNull } from "drizzle-orm";
import { type AppCheck, AppIdParam, type AppSignIn } from "../api/app-schemas.ts";
import type { ProductConfig } from "../config/schema.ts";
import { loadConnectorSystem } from "../connectors/system.ts";
import type { Db } from "../db/client.ts";
import { workflowExecutionAuthorities, workflows, workflowVersions } from "../db/schema/index.ts";
import { authorityLive } from "../workflows/authority-live.ts";
import { readStoredDefinition } from "../workflows/stored-definition.ts";
import type { WorkflowDef } from "../workflows/types.ts";
import { type CallerUsage, callerUsage } from "./caller-budget.ts";

export interface ProductContext {
  tenant_id: string;
  principal_id: string;
  product_id: string;
  product: ProductConfig;
}

export interface ProductHealth {
  ok: boolean;
  version: "1";
  model: { id: null; status: "unchecked" };
  key: "present" | "missing";
}

export interface AssistantRecord {
  id: string;
  name: string;
  slug: string;
  lifecycle: "draft" | "active" | "archived";
  version_id: string | null;
  definition: WorkflowDef | null;
  product_id: string | null;
}

export interface ActiveAssistant {
  versionId: string;
  def: WorkflowDef;
}

export interface ProductReadinessFacts {
  product_id: string;
  product: ProductConfig | null;
  sign_in: AppSignIn[];
  assistant: AssistantRecord | null;
  authority_live: boolean;
  credentials_present: boolean;
}

export interface ProductReadiness {
  assistant: ActiveAssistant | null;
  record: AssistantRecord | null;
  checks: AppCheck[];
}

export function storedProductId(dag: unknown, definition: WorkflowDef | null): string | null {
  const raw = definition
    ? definition.product_id
    : (dag as { product_id?: unknown } | null)?.product_id;
  return AppIdParam.shape.id.safeParse(raw).success ? (raw as string) : null;
}

async function loadAssistant(
  db: Db,
  tenant_id: string,
  workflow_id: string,
): Promise<AssistantRecord | null> {
  const [row] = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      slug: workflows.slug,
      lifecycle: workflows.lifecycle,
      versionId: workflows.current_version_id,
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
    .where(
      and(
        eq(workflows.tenant_id, tenant_id),
        eq(workflows.id, workflow_id),
        isNull(workflows.deleted_at),
      ),
    )
    .limit(1);
  if (!row) return null;
  const stored = row.dag === null ? null : readStoredDefinition(row.dag);
  const definition = stored && !stored.invalid ? stored.definition : null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    lifecycle: row.lifecycle,
    version_id: row.dag === null ? null : row.versionId,
    definition,
    product_id: storedProductId(row.dag, definition),
  };
}

export function activeAssistant(
  record: AssistantRecord | null,
  product_id: string,
): ActiveAssistant | null {
  if (!record?.version_id || !record.definition || record.lifecycle !== "active") return null;
  return record.definition.product_id === product_id
    ? { versionId: record.version_id, def: record.definition }
    : null;
}

async function credentialsPresent(
  db: Db,
  tenant_id: string,
  def: WorkflowDef,
  environment: "dev" | "prod",
): Promise<boolean> {
  const connectorIds = [
    ...new Set(
      def.steps.flatMap((step) =>
        step.kind === "request" && step.connector_id ? [step.connector_id] : [],
      ),
    ),
  ];
  for (const connectorId of connectorIds) {
    const system = await loadConnectorSystem(tenant_id, connectorId, environment, db);
    if (!system) return false;
    if (system.connector.auth_type === "none") continue;
    const metadata = await system.getAuthorityMetadata();
    if (!metadata.available || !metadata.binding.primary) return false;
  }
  return true;
}

async function authorityExists(
  db: Db,
  tenant_id: string,
  product: ProductConfig,
  assistant: ActiveAssistant,
): Promise<boolean> {
  const [authority] = await db
    .select({ id: workflowExecutionAuthorities.id })
    .from(workflowExecutionAuthorities)
    .where(
      and(
        eq(workflowExecutionAuthorities.tenant_id, tenant_id),
        eq(workflowExecutionAuthorities.workflow_id, product.assistant_workflow_id),
        eq(workflowExecutionAuthorities.workflow_version_id, assistant.versionId),
        eq(workflowExecutionAuthorities.execution_environment, product.execution_environment),
        authorityLive(),
      ),
    )
    .limit(1);
  return Boolean(authority);
}

function check(
  key: AppCheck["key"],
  ok: boolean,
  message: string,
  next_action: string | null,
): AppCheck {
  return { key, ok, message, next_action: ok ? null : next_action };
}

function assistantCheck(facts: ProductReadinessFacts): AppCheck {
  const { product, product_id, assistant } = facts;
  const fail = (message: string, next: string) => check("assistant_workflow", false, message, next);
  if (!product)
    return fail(
      "No assistant workflow is configured for this app",
      `Add products.${product_id} with an assistant_workflow_id in settings`,
    );
  if (!assistant)
    return fail(
      `Assistant workflow ${product.assistant_workflow_id} does not exist in this workspace`,
      `Set products.${product_id}.assistant_workflow_id to a saved workflow of this workspace`,
    );
  if (!assistant.version_id || !assistant.definition)
    return fail(
      `The current version of ${assistant.name} is not a valid workflow definition`,
      `Save ${assistant.name} again in the current definition format`,
    );
  if (assistant.definition.product_id !== product_id)
    return fail(
      assistant.definition.product_id
        ? `${assistant.name} declares product_id ${assistant.definition.product_id}`
        : `${assistant.name} declares no product_id`,
      `Set product_id: ${product_id} in the definition of ${assistant.name}`,
    );
  if (assistant.lifecycle !== "active")
    return fail(`${assistant.name} is ${assistant.lifecycle}`, `Activate ${assistant.name}`);
  return check("assistant_workflow", true, `${assistant.name} is active`, null);
}

function budgetCheck(facts: ProductReadinessFacts): AppCheck {
  const { product, product_id } = facts;
  if (!product)
    return check(
      "budget_guard",
      false,
      "No budget_bucket is configured for this app",
      `Add products.${product_id} with a budget_bucket in settings`,
    );
  const definition = facts.assistant?.definition;
  if (!definition)
    return check(
      "budget_guard",
      false,
      "The daily limit cannot be read without a valid assistant workflow",
      null,
    );
  const guard = definition.execution_guards?.caller_daily_limit;
  if (!guard)
    return check(
      "budget_guard",
      false,
      "The assistant workflow has no caller_daily_limit guard",
      `Add execution_guards.caller_daily_limit with bucket ${product.budget_bucket} to the assistant workflow`,
    );
  if (guard.bucket !== product.budget_bucket)
    return check(
      "budget_guard",
      false,
      `The guard's bucket ${guard.bucket} differs from budget_bucket ${product.budget_bucket}`,
      `Align products.${product_id}.budget_bucket with the guard's bucket ${guard.bucket}`,
    );
  return check(
    "budget_guard",
    true,
    `Each caller may use ${guard.limit} units per day in bucket ${guard.bucket}`,
    null,
  );
}

export function deriveProductChecks(facts: ProductReadinessFacts): AppCheck[] {
  const { product, product_id, sign_in } = facts;
  const active = activeAssistant(facts.assistant, product_id);
  const environment = product?.execution_environment ?? "prod";
  return [
    check(
      "product_configured",
      Boolean(product),
      product
        ? `products.${product_id} is configured`
        : `No products.${product_id} entry exists in settings`,
      `Add products.${product_id} with execution_environment, assistant_workflow_id and budget_bucket in settings`,
    ),
    check(
      "sign_in_provider",
      sign_in.length > 0,
      sign_in.length > 0
        ? `${sign_in.length} sign-in provider${sign_in.length === 1 ? "" : "s"} carry product_id ${product_id}`
        : `No sign-in provider of this workspace carries product_id ${product_id}`,
      `Add an oidc_bearer provider with product_id ${product_id} under auth.providers`,
    ),
    assistantCheck(facts),
    active
      ? check(
          "execution_authority",
          facts.authority_live,
          facts.authority_live
            ? `A live execution authority covers the current version in ${environment}`
            : `No live execution authority covers the current version in ${environment}`,
          `Approve the assistant workflow's effect boundary for ${environment}`,
        )
      : check(
          "execution_authority",
          false,
          "An execution authority needs an active assistant workflow first",
          null,
        ),
    active
      ? check(
          "credentials",
          facts.credentials_present,
          facts.credentials_present
            ? "Every connector the assistant workflow uses holds a usable credential"
            : "A connector the assistant workflow uses has no usable credential",
          `Connect the missing connector credential in ${environment}`,
        )
      : check(
          "credentials",
          false,
          "Credentials are checked once the assistant workflow is active",
          null,
        ),
    budgetCheck(facts),
  ];
}

export async function productReadiness(
  db: Db,
  input: {
    tenant_id: string;
    product_id: string;
    product: ProductConfig | null;
    sign_in: AppSignIn[];
  },
): Promise<ProductReadiness> {
  const record = input.product
    ? await loadAssistant(db, input.tenant_id, input.product.assistant_workflow_id)
    : null;
  const assistant = activeAssistant(record, input.product_id);
  let authority_live = false;
  let credentials_present = false;
  if (assistant && input.product) {
    authority_live = await authorityExists(db, input.tenant_id, input.product, assistant);
    credentials_present = await credentialsPresent(
      db,
      input.tenant_id,
      assistant.def,
      input.product.execution_environment,
    );
  }
  return {
    assistant,
    record,
    checks: deriveProductChecks({
      product_id: input.product_id,
      product: input.product,
      sign_in: input.sign_in,
      assistant: record,
      authority_live,
      credentials_present,
    }),
  };
}

export async function productBudget(db: Db, context: ProductContext): Promise<CallerUsage | null> {
  const assistant = activeAssistant(
    await loadAssistant(db, context.tenant_id, context.product.assistant_workflow_id),
    context.product_id,
  );
  const guard = assistant?.def.execution_guards?.caller_daily_limit;
  if (!guard || guard.bucket !== context.product.budget_bucket) return null;
  return db.transaction((tx) =>
    callerUsage(tx, {
      tenant_id: context.tenant_id,
      bucket: guard.bucket,
      principal_id: context.principal_id,
      limit: guard.limit,
      tz: guard.tz,
    }),
  );
}

export async function productHealth(db: Db, context: ProductContext): Promise<ProductHealth> {
  const { checks } = await productReadiness(db, {
    tenant_id: context.tenant_id,
    product_id: context.product_id,
    product: context.product,
    sign_in: [],
  });
  const passed = (key: AppCheck["key"]) => checks.some((item) => item.key === key && item.ok);
  return {
    ok: passed("assistant_workflow") && passed("execution_authority") && passed("credentials"),
    version: "1",
    model: { id: null, status: "unchecked" },
    key: passed("credentials") ? "present" : "missing",
  };
}
