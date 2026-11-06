import { and, eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { createEmptyDraftDocument } from "../conversations/authoring-state.ts";
import type { ToolContext } from "../conversations/tools/index.ts";
import type { DraftDocument } from "../conversations/types.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  connectors,
  conversations,
  tenants,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import { EngineClient } from "../engine-client/index.ts";
import { type WorkflowDef, WorkflowDefSchema } from "../workflows/types.ts";
import { FROZEN_NOW } from "./determinism/clock.ts";

export type TenantRow = typeof tenants.$inferSelect;
export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowVersionRow = typeof workflowVersions.$inferSelect;
export type ConnectorRow = typeof connectors.$inferSelect;
export type ConversationRow = typeof conversations.$inferSelect;

const ENTITY_PREFIX = {
  tenant: "5eed0001",
  workflow: "5eed0002",
  workflow_version: "5eed0003",
  connector: "5eed0004",
  conversation: "5eed0005",
  tool_conversation: "5eed0006",
} as const;

type SeedEntity = keyof typeof ENTITY_PREFIX;

let sequence = 0;

function nextSequence(): number {
  sequence += 1;
  return sequence;
}

export function seedUuid(entity: SeedEntity, n: number): string {
  return `${ENTITY_PREFIX[entity]}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export function seedTimestamp(n: number): Date {
  return new Date(FROZEN_NOW + n * 1000);
}

function requireRow<T>(row: T | undefined, table: string): T {
  if (!row) throw new Error(`seed ${table} insert returned no row`);
  return row;
}

export type SeedTenantOverrides = Partial<typeof tenants.$inferInsert>;

export async function seedTenant(
  db: Executor,
  overrides: SeedTenantOverrides = {},
): Promise<TenantRow> {
  const n = nextSequence();
  const at = seedTimestamp(n);
  const [row] = await db
    .insert(tenants)
    .values({
      id: seedUuid("tenant", n),
      slug: `t-seed-${n}`,
      display_name: `Tenant ${n}`,
      created_at: at,
      updated_at: at,
      ...overrides,
    })
    .returning();
  return requireRow(row, "tenants");
}

export const SEED_WORKFLOW_STEP = {
  id: "noop",
  kind: "transform",
  expression: "return 1;",
} as const;

export type SeedWorkflowInput = Partial<typeof workflows.$inferInsert> & {
  tenant_id: string;
  def?: WorkflowDef;
  dag?: Record<string, unknown>;
  version?: Partial<Omit<typeof workflowVersions.$inferInsert, "tenant_id" | "workflow_id">>;
};

export interface SeededWorkflow {
  workflow: WorkflowRow;
  version: WorkflowVersionRow;
}

export async function seedWorkflow(
  db: Executor,
  input: SeedWorkflowInput,
): Promise<SeededWorkflow> {
  const { def, dag, version: versionOverrides = {}, ...overrides } = input;
  const n = nextSequence();
  const at = seedTimestamp(n);
  const source = dag ?? def;
  const sourceSlug = typeof source?.slug === "string" ? source.slug : undefined;
  const sourceName = typeof source?.name === "string" ? source.name : undefined;
  const slug = overrides.slug ?? sourceSlug ?? `wf-seed-${n}`;
  const name = overrides.name ?? sourceName ?? `Workflow ${n}`;
  const storedDag =
    source ?? WorkflowDefSchema.parse({ name, slug, steps: [{ ...SEED_WORKFLOW_STEP }] });

  const [inserted] = await db
    .insert(workflows)
    .values({
      id: seedUuid("workflow", n),
      lifecycle: "active",
      created_at: at,
      updated_at: at,
      ...overrides,
      slug,
      name,
    })
    .returning();
  const workflow = requireRow(inserted, "workflows");

  const [versionRow] = await db
    .insert(workflowVersions)
    .values({
      id: seedUuid("workflow_version", n),
      version: 1,
      dag: storedDag,
      created_at: at,
      ...versionOverrides,
      tenant_id: workflow.tenant_id,
      workflow_id: workflow.id,
    })
    .returning();
  const version = requireRow(versionRow, "workflow_versions");

  const [updated] = await db
    .update(workflows)
    .set({ current_version_id: version.id })
    .where(and(eq(workflows.tenant_id, workflow.tenant_id), eq(workflows.id, workflow.id)))
    .returning();
  return { workflow: requireRow(updated, "workflows"), version };
}

export type SeedConnectorInput = Partial<typeof connectors.$inferInsert> & { tenant_id: string };

export async function seedConnector(
  db: Executor,
  input: SeedConnectorInput,
): Promise<ConnectorRow> {
  const n = nextSequence();
  const at = seedTimestamp(n);
  const [row] = await db
    .insert(connectors)
    .values({
      id: seedUuid("connector", n),
      slug: `cn-seed-${n}`,
      display_name: `Connector ${n}`,
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://example.test",
      config: {},
      created_at: at,
      updated_at: at,
      ...input,
    })
    .returning();
  return requireRow(row, "connectors");
}

export type SeedConversationInput = Partial<typeof conversations.$inferInsert> & {
  tenant_id: string;
};

export async function seedConversation(
  db: Executor,
  input: SeedConversationInput,
): Promise<ConversationRow> {
  const n = nextSequence();
  const at = seedTimestamp(n);
  const [row] = await db
    .insert(conversations)
    .values({
      id: seedUuid("conversation", n),
      status: "active",
      draft: createEmptyDraftDocument(),
      loaded_skills: [],
      created_at: at,
      updated_at: at,
      ...input,
    })
    .returning();
  return requireRow(row, "conversations");
}

export type MakeToolCtxInput = Partial<Omit<ToolContext, "db" | "tenant_id">> & {
  db: Db;
  tenant_id: string;
  principal?: ResolvedPrincipal | null;
  draft?: DraftDocument;
};

export type SeededToolContext = ToolContext & { readonly draft: DraftDocument };

export function makeToolCtx(input: MakeToolCtxInput): SeededToolContext {
  const { db, tenant_id, draft: initialDraft, ...overrides } = input;
  const actor_id = overrides.actor_id ?? null;
  const state = { draft: initialDraft ?? createEmptyDraftDocument() };
  const ctx: ToolContext = {
    db,
    tenant_id,
    conversation_id: seedUuid("tool_conversation", nextSequence()),
    actor_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id,
      actor_id,
      ...(actor_id ? { actor_type: "user" as const } : {}),
      db,
    }),
    getDraft: () => state.draft,
    setDraft: async (next: DraftDocument) => {
      state.draft = next;
    },
    onLog: () => {},
    ...overrides,
  };
  return Object.defineProperty(ctx, "draft", {
    get: () => state.draft,
    enumerable: false,
  }) as SeededToolContext;
}

export function adminHeaders(
  apiKey: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    ...extra,
  };
}
