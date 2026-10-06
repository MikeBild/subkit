import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { CATALOG_KINDS, type CatalogKind } from "../api/catalog-metadata.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { type Executor, getDb } from "../db/client.ts";
import {
  connectors,
  fileLinks,
  files,
  knowledgeChunks,
  knowledgeSources,
  skills,
  workflows,
  workflowVersions,
} from "../db/schema/index.ts";
import {
  type CatalogDescribeInput,
  type CategoryCount,
  catalogInputHash,
  describeCatalogObject,
} from "../llm/catalog-describe.ts";
import { errorFields, logger } from "../logging/logger.ts";
import { loadCategoryVocabulary } from "./catalog-view.ts";

const TABLES = {
  workflow: workflows,
  connector: connectors,
  knowledge_source: knowledgeSources,
  skill: skills,
  file: files,
} as const;

const KNOWLEDGE_SAMPLE_CHUNKS = 4;

const KNOWLEDGE_SAMPLE_CHARS = 3000;

export const CATALOG_DESCRIBE_BATCH = 25;

export const CATALOG_DESCRIBE_RETRY_MS = 6 * 60 * 60 * 1000;

type CatalogTable = (typeof TABLES)[CatalogKind];

function liveCondition(kind: CatalogKind) {
  if (kind === "workflow") return isNull(workflows.deleted_at);
  if (kind === "connector") return isNull(connectors.deleted_at);
  if (kind === "knowledge_source") return isNull(knowledgeSources.deleted_at);
  if (kind === "file") return and(isNull(files.deleted_at), eq(files.status, "ready"));
  return undefined;
}

function pendingCondition(table: CatalogTable) {
  const retryBefore = new Date(Date.now() - CATALOG_DESCRIBE_RETRY_MS);
  return and(
    or(eq(table.description_source, "llm"), eq(table.category_source, "llm")),
    or(
      isNull(table.catalog_described_at),
      gt(table.updated_at, table.catalog_described_at),
      and(isNull(table.catalog_input_hash), lt(table.catalog_described_at, retryBefore)),
    ),
  );
}

export async function hasPendingCatalogDescriptions(
  tenant_id: string,
  exec?: Executor,
): Promise<boolean> {
  const db = exec ?? getDb();
  for (const kind of CATALOG_KINDS) {
    const table = TABLES[kind];
    const live = liveCondition(kind);
    const [row] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenant_id, tenant_id), pendingCondition(table), ...(live ? [live] : [])))
      .limit(1);
    if (row) return true;
  }
  return false;
}

interface PendingRef {
  kind: CatalogKind;
  id: string;
}

async function pendingRefs(tenant_id: string, limit: number, db: Executor): Promise<PendingRef[]> {
  const out: PendingRef[] = [];
  for (const kind of CATALOG_KINDS) {
    if (out.length >= limit) break;
    const table = TABLES[kind];
    const live = liveCondition(kind);
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenant_id, tenant_id), pendingCondition(table), ...(live ? [live] : [])))
      .orderBy(asc(table.created_at))
      .limit(limit - out.length);
    for (const row of rows) out.push({ kind, id: row.id });
  }
  return out;
}

interface StepLike {
  id?: unknown;
  kind?: unknown;
  method?: unknown;
  url?: unknown;
  path?: unknown;
  connector_id?: unknown;
  steps?: unknown;
}

function describeSteps(steps: unknown, depth = 0): string[] {
  if (!Array.isArray(steps) || depth > 2) return [];
  const lines: string[] = [];
  for (const raw of steps as StepLike[]) {
    const parts = [String(raw.id ?? "step"), `(${String(raw.kind ?? "step")}`];
    if (typeof raw.method === "string") parts.push(raw.method);
    if (typeof raw.path === "string") parts.push(raw.path);
    else if (typeof raw.url === "string") parts.push(raw.url);
    parts[parts.length - 1] = `${parts[parts.length - 1]})`;
    lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
    lines.push(...describeSteps(raw.steps, depth + 1));
  }
  return lines;
}

export function addressWithoutSecrets(address: string | null): string | null {
  if (!address) return null;
  try {
    const url = new URL(address);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return address.split(/[?#]/)[0] ?? null;
  }
}

function ownedText(value: string | null, source: string): string | null {
  return source === "human" ? value : null;
}

async function workflowInput(
  tenant_id: string,
  id: string,
  db: Executor,
): Promise<CatalogDescribeInput | null> {
  const [row] = await db
    .select({ wf: workflows, dag: workflowVersions.dag })
    .from(workflows)
    .leftJoin(workflowVersions, eq(workflowVersions.id, workflows.current_version_id))
    .where(and(eq(workflows.tenant_id, tenant_id), eq(workflows.id, id)))
    .limit(1);
  if (!row) return null;
  const dag = (row.dag ?? {}) as {
    steps?: unknown;
    trigger?: { kind?: unknown };
    input_schema?: { properties?: Record<string, unknown> };
  };
  const inputs = Object.keys(dag.input_schema?.properties ?? {});
  return {
    kind: "workflow",
    name: row.wf.name,
    fields: [
      ["slug", row.wf.slug],
      ["description", ownedText(row.wf.description, row.wf.description_source)],
      ["trigger", typeof dag.trigger?.kind === "string" ? dag.trigger.kind : null],
      ["inputs", inputs.length > 0 ? inputs.join(", ") : null],
      ["steps", describeSteps(dag.steps).join("\n")],
    ],
  };
}

async function connectorInput(
  tenant_id: string,
  id: string,
  db: Executor,
): Promise<CatalogDescribeInput | null> {
  const [row] = await db
    .select()
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, id)))
    .limit(1);
  if (!row) return null;
  const quirks = (row.operator_quirks ?? {}) as Record<string, string | undefined>;
  const snapshot = (row.template_snapshot ?? {}) as { description?: unknown };
  return {
    kind: "connector",
    name: row.display_name,
    fields: [
      ["slug", row.slug],
      ["description", ownedText(row.description, row.description_source)],
      ["driver", row.driver],
      ["base_url", addressWithoutSecrets(row.base_url)],
      ["template", row.template_name ?? row.template_slug],
      [
        "template_description",
        typeof snapshot.description === "string" ? snapshot.description : null,
      ],
      ["operator_notes", quirks.general ?? null],
    ],
  };
}

async function knowledgeSourceInput(
  tenant_id: string,
  id: string,
  db: Executor,
): Promise<CatalogDescribeInput | null> {
  const [row] = await db
    .select()
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.tenant_id, tenant_id), eq(knowledgeSources.id, id)))
    .limit(1);
  if (!row) return null;
  const chunks = await db
    .select({ title: knowledgeChunks.title, content: knowledgeChunks.content })
    .from(knowledgeChunks)
    .where(
      and(eq(knowledgeChunks.tenant_id, tenant_id), eq(knowledgeChunks.knowledge_source_id, id)),
    )
    .orderBy(asc(knowledgeChunks.ordinal))
    .limit(KNOWLEDGE_SAMPLE_CHUNKS);
  const sample = chunks
    .map((c) => (c.title ? `## ${c.title}\n${c.content}` : c.content))
    .join("\n\n")
    .slice(0, KNOWLEDGE_SAMPLE_CHARS);
  return {
    kind: "knowledge_source",
    name: row.name,
    fields: [
      ["slug", row.slug],
      ["description", ownedText(row.description, row.description_source)],
      ["source", `${row.source_type} ${addressWithoutSecrets(row.source_uri) ?? ""}`],
      ["tags", row.tags.length > 0 ? row.tags.join(", ") : null],
      ["content_sample", sample],
    ],
  };
}

async function skillInput(
  tenant_id: string,
  id: string,
  db: Executor,
): Promise<CatalogDescribeInput | null> {
  const [row] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
    .limit(1);
  if (!row) return null;
  const tags = Array.isArray(row.tags) ? (row.tags as string[]) : [];
  return {
    kind: "skill",
    name: row.title,
    fields: [
      ["slug", row.slug],
      ["description", ownedText(row.description, row.description_source)],
      ["scope", row.scope],
      ["tags", tags.length > 0 ? tags.join(", ") : null],
      ["body", row.body],
    ],
  };
}

async function fileInput(
  tenant_id: string,
  id: string,
  db: Executor,
): Promise<CatalogDescribeInput | null> {
  const [row] = await db
    .select()
    .from(files)
    .where(and(eq(files.tenant_id, tenant_id), eq(files.id, id)))
    .limit(1);
  if (!row) return null;
  const links = await db
    .select({ resource_type: fileLinks.resource_type, role: fileLinks.role })
    .from(fileLinks)
    .where(and(eq(fileLinks.tenant_id, tenant_id), eq(fileLinks.file_id, id)))
    .limit(10);
  return {
    kind: "file",
    name: row.filename,
    fields: [
      ["slug", row.slug],
      ["description", ownedText(row.description, row.description_source)],
      ["content_type", row.content_type],
      ["size_bytes", String(row.size_bytes)],
      [
        "used_by",
        links.length > 0
          ? links
              .map((l) => (l.role ? `${l.resource_type} (${l.role})` : l.resource_type))
              .join(", ")
          : null,
      ],
    ],
  };
}

const INPUT_BUILDERS: Record<
  CatalogKind,
  (tenant_id: string, id: string, db: Executor) => Promise<CatalogDescribeInput | null>
> = {
  workflow: workflowInput,
  connector: connectorInput,
  knowledge_source: knowledgeSourceInput,
  skill: skillInput,
  file: fileInput,
};

export type CatalogDescribeOutcome = "described" | "unchanged" | "skipped" | "failed";

async function loadOwnership(kind: CatalogKind, tenant_id: string, id: string, db: Executor) {
  const table = TABLES[kind];
  const [row] = await db
    .select({
      tenant_id: table.tenant_id,
      description: table.description,
      category: table.category,
      description_source: table.description_source,
      category_source: table.category_source,
      catalog_input_hash: table.catalog_input_hash,
      updated_at: table.updated_at,
    })
    .from(table)
    .where(and(eq(table.tenant_id, tenant_id), eq(table.id, id)))
    .limit(1);
  return row ?? null;
}

export async function describeOne(
  p: { tenant_id: string; kind: CatalogKind; id: string; vocabulary?: readonly CategoryCount[] },
  exec?: Executor,
): Promise<CatalogDescribeOutcome> {
  const db = exec ?? getDb();
  const table = TABLES[p.kind];
  const owned = await loadOwnership(p.kind, p.tenant_id, p.id, db);
  if (!owned || owned.tenant_id !== p.tenant_id) return "skipped";
  const now = sql`now()`;
  if (owned.description_source === "human" && owned.category_source === "human") {
    await db
      .update(table)
      .set({ catalog_described_at: now })
      .where(and(eq(table.tenant_id, p.tenant_id), eq(table.id, p.id)));
    return "skipped";
  }
  const input = await INPUT_BUILDERS[p.kind](p.tenant_id, p.id, db);
  if (!input) return "skipped";
  const hash = catalogInputHash(input);
  if (hash === owned.catalog_input_hash) {
    await db
      .update(table)
      .set({ catalog_described_at: now })
      .where(and(eq(table.tenant_id, p.tenant_id), eq(table.id, p.id)));
    return "unchanged";
  }
  const vocabulary =
    p.vocabulary ??
    (await loadCategoryVocabulary(p.tenant_id, db)).map((v) => ({
      category: v.category,
      total: v.total,
    }));
  const generated = await describeCatalogObject({ tenant_id: p.tenant_id, input, vocabulary }, db);
  if (!generated) {
    await db
      .update(table)
      .set({ catalog_described_at: now, catalog_input_hash: null })
      .where(and(eq(table.tenant_id, p.tenant_id), eq(table.id, p.id)));
    return "failed";
  }
  const set: {
    catalog_input_hash: string;
    catalog_described_at: typeof now;
    description?: string;
    category?: string;
  } = { catalog_input_hash: hash, catalog_described_at: now };
  const applied = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        description: table.description,
        category: table.category,
        description_source: table.description_source,
        category_source: table.category_source,
        updated_at: table.updated_at,
      })
      .from(table)
      .where(and(eq(table.tenant_id, p.tenant_id), eq(table.id, p.id)))
      .for("update")
      .limit(1);
    if (!current) return null;
    if (current.updated_at.getTime() !== owned.updated_at.getTime()) return null;
    if (current.description_source === "llm") set.description = generated.description;
    if (current.category_source === "llm") set.category = generated.category;
    await tx
      .update(table)
      .set(set)
      .where(and(eq(table.tenant_id, p.tenant_id), eq(table.id, p.id)));
    const changed =
      (set.description !== undefined && set.description !== current.description) ||
      (set.category !== undefined && set.category !== current.category);
    if (changed) {
      await auditAwait(
        {
          tenant_id: p.tenant_id,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.CATALOG_METADATA_GENERATED,
          resource_type: p.kind,
          resource_id: p.id,
          result: "success",
          before: { description: current.description, category: current.category },
          after: {
            description: set.description ?? current.description,
            category: set.category ?? current.category,
          },
          metadata: { model_used: generated.model_used },
        },
        tx,
      );
    }
    return current;
  });
  if (!applied) return "skipped";
  return "described";
}

export interface CatalogDescribeRun {
  described: number;
  unchanged: number;
  skipped: number;
  failed: number;
  remaining: boolean;
}

export async function describePendingCatalog(
  tenant_id: string,
  exec?: Executor,
  limit = CATALOG_DESCRIBE_BATCH,
): Promise<CatalogDescribeRun> {
  const db = exec ?? getDb();
  const refs = await pendingRefs(tenant_id, limit, db);
  const run: CatalogDescribeRun = {
    described: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    remaining: false,
  };
  for (const ref of refs) {
    try {
      run[await describeOne({ tenant_id, ...ref }, db)] += 1;
    } catch (err) {
      run.failed += 1;
      logger.warn({
        module: "catalog",
        action: "catalog.describe_failed",
        msg: "describing one catalog object failed; the next pass retries it after the back-off",
        tenant_id,
        kind: ref.kind,
        object_id: ref.id,
        ...errorFields(err),
      });
      const table = TABLES[ref.kind];
      await db
        .update(table)
        .set({ catalog_described_at: sql`now()`, catalog_input_hash: null })
        .where(and(eq(table.id, ref.id), eq(table.tenant_id, tenant_id)));
    }
  }
  run.remaining = refs.length >= limit && (await hasPendingCatalogDescriptions(tenant_id, db));
  return run;
}
