import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { PLATFORM_CATEGORY } from "../../api/catalog-metadata.ts";
import { toPublicConnector } from "../../connectors/public-view.ts";
import { rebindConnectorIds } from "../../connectors/recipe-binding.ts";
import { listConnectors } from "../../connectors/service.ts";
import { listTenantConnectorTemplates } from "../../connectors/template-service.ts";
import type { Executor } from "../../db/client.ts";
import {
  fileLinks,
  files,
  knowledgeSources,
  tenants,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { storageKey } from "../../files/resolver.ts";
import { listKnowledgeSources } from "../../knowledge/catalog.ts";
import { getKnowledgeSourceContent } from "../../knowledge/content.ts";
import { listSkills } from "../../skills/service.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import { getWorkflowDraft } from "../../workflows/drafts.ts";
import { listWorkflows } from "../../workflows/service.ts";
import {
  CONNECTOR_REF_PREFIX,
  type ConnectorPayload,
  type ConnectorTemplatePayload,
  connectorKey,
  type FilePayload,
  type KnowledgePayload,
  PACKAGE_CONTENT_TYPE,
  PACKAGE_MAX_BYTES,
  PACKAGE_MAX_ENTRY_BYTES,
  type PackageItemKind,
  type PackagePayload,
  type PackageRequirement,
  type SchedulePayload,
  type SkillPayload,
  sortPayloads,
  type WorkflowPayload,
} from "./format.ts";
import { stripMaskedUrl, stripMaskedValues, stripSecretFields } from "./redact.ts";

const PAGE = 500;
const EXCLUDED_SKILL_SOURCES: ReadonlySet<string> = new Set(["template", "memory"]);
const RUN_LINK_TYPES: ReadonlySet<string> = new Set([
  "conversation",
  "workflow_run",
  "discovery_run",
]);
const PLACEHOLDER = /\$\{connector\.([A-Za-z0-9_-]+)\./g;

export class PackageTooLargeError extends Error {
  constructor(
    readonly total_bytes: number,
    readonly limit_bytes: number,
  ) {
    super("package_too_large");
  }
}

export interface PackageIndex {
  connector_templates: Map<string, string>;
  connectors: Map<string, string>;
  files: Map<string, string>;
  skills: Map<string, string>;
  workflows: Map<string, string>;
  schedules: Map<string, string>;
  knowledge: Map<string, string>;
}

export interface CollectedPackage {
  tenant_slug: string | null;
  payloads: PackagePayload[];
  requires: PackageRequirement[];
  index: PackageIndex;
}

export interface CollectOptions {
  kinds?: readonly PackageItemKind[] | undefined;
  include_bytes: boolean;
}

interface Dependency {
  kind: PackageItemKind;
  key: string;
}

async function pageAll<T>(fetch: (offset: number, limit: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await fetch(offset, PAGE);
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

function replaceCallWorkflowIds(value: unknown, slugs: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => replaceCallWorkflowIds(v, slugs));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "workflow_id" && record.kind === "call" && typeof child === "string") {
      const slug = slugs.get(child);
      if (slug && record.workflow_slug === undefined) out.workflow_slug = slug;
      if (!slug) out[key] = child;
      continue;
    }
    out[key] = replaceCallWorkflowIds(child, slugs);
  }
  return out;
}

function callSlugs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) callSlugs(v, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.kind === "call" && typeof record.workflow_slug === "string") {
    into.add(record.workflow_slug);
  }
  for (const child of Object.values(record)) callSlugs(child, into);
}

function connectorTokens(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) connectorTokens(v, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "connector_id" &&
      typeof child === "string" &&
      child.startsWith(CONNECTOR_REF_PREFIX)
    ) {
      into.add(child.slice(CONNECTOR_REF_PREFIX.length));
    } else {
      connectorTokens(child, into);
    }
  }
}

export async function collectTenantPackage(
  exec: Executor,
  tenant_id: string,
  opts: CollectOptions,
): Promise<CollectedPackage> {
  const [tenant] = await exec
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenant_id))
    .limit(1);
  const payloads: PackagePayload[] = [];
  const deps = new Map<string, Dependency[]>();
  const requires: PackageRequirement[] = [];
  const index: PackageIndex = {
    connector_templates: new Map(),
    connectors: new Map(),
    files: new Map(),
    skills: new Map(),
    workflows: new Map(),
    schedules: new Map(),
    knowledge: new Map(),
  };
  const add = (item: PackagePayload, dependencies: Dependency[] = []): void => {
    payloads.push(item);
    deps.set(`${item.kind}:${item.key}`, dependencies);
  };

  const templates = await listTenantConnectorTemplates(tenant_id, exec);
  for (const row of templates) {
    index.connector_templates.set(row.slug, row.id);
    const oauth =
      row.oauth && typeof row.oauth === "object" && !Array.isArray(row.oauth)
        ? stripSecretFields(row.oauth as Record<string, unknown>, "oauth").value
        : null;
    const probe =
      row.probe_endpoint && typeof row.probe_endpoint === "object"
        ? stripSecretFields({ probe: row.probe_endpoint }, "probe_endpoint").value.probe
        : (row.probe_endpoint ?? null);
    const payload: ConnectorTemplatePayload = {
      slug: row.slug,
      name: row.name,
      driver: row.driver,
      base_url:
        stripMaskedUrl(
          toPublicConnector({ base_url: row.base_url, dsn: null, config: {} }).base_url,
          "base_url",
        ).value ?? "",
      auth_type: row.auth_type,
      oauth,
      default_skill: row.default_skill,
      ingestion_source: row.ingestion_source,
      ingestion_url: row.ingestion_url,
      icon: row.icon,
      description: row.description,
      category: row.category,
      tags: Array.isArray(row.tags) ? row.tags : [],
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      setup_instructions: row.setup_instructions,
      auth_options: Array.isArray(row.auth_options) ? row.auth_options : [],
      url_pattern: row.url_pattern,
      keywords: Array.isArray(row.keywords) ? row.keywords : [],
      inline_schema: row.inline_schema ?? null,
      probe_endpoint: probe ?? null,
      credential_hints: Array.isArray(row.credential_hints) ? row.credential_hints : [],
      base_url_options: Array.isArray(row.base_url_options) ? row.base_url_options : [],
      pagination_defaults: row.pagination_defaults ?? null,
      capabilities: row.capabilities ?? null,
    };
    add({ kind: "connector_template", key: row.slug, payload });
  }

  const connectorRows = await pageAll(
    async (offset, limit) => (await listConnectors(tenant_id, { limit, offset }, exec)).rows,
  );
  const connectorKeyById = new Map<string, string>();
  const connectorKeysBySlug = new Map<string, string[]>();
  for (const raw of connectorRows) {
    const key = connectorKey(raw.slug, raw.environment);
    index.connectors.set(key, raw.id);
    connectorKeyById.set(raw.id, key);
    connectorKeysBySlug.set(raw.slug, [...(connectorKeysBySlug.get(raw.slug) ?? []), key]);
    if (raw.category === PLATFORM_CATEGORY) continue;
    const view = toPublicConnector(raw);
    const baseUrl = stripMaskedUrl(view.base_url, "base_url");
    const config = stripMaskedValues(view.config ?? {}, "config");
    const quirks = stripMaskedValues(
      (view.operator_quirks ?? {}) as Record<string, unknown>,
      "operator_quirks",
    );
    const removed = [...baseUrl.removed, ...config.removed, ...quirks.removed];
    if (raw.dsn) removed.push("dsn");
    if (raw.auth_type !== "none" || removed.length > 0) {
      requires.push({
        kind: "credential",
        connector: key,
        fields: [...(raw.auth_type !== "none" ? [`auth:${raw.auth_type}`] : []), ...removed],
      });
    }
    const payload: ConnectorPayload = {
      slug: raw.slug,
      environment: raw.environment,
      name: raw.display_name,
      driver: raw.driver,
      auth_type: raw.auth_type,
      base_url: baseUrl.value,
      config: config.value,
      operator_quirks: quirks.value,
      template_slug: raw.template_slug,
      template_source: raw.template_source,
      description: raw.description,
      category: raw.category,
    };
    const dependencies: Dependency[] =
      raw.template_source === "tenant" && raw.template_slug
        ? [{ kind: "connector_template", key: raw.template_slug }]
        : [];
    add({ kind: "connector", key, payload }, dependencies);
  }

  const workflowRows = (
    await pageAll(
      async (offset, limit) => (await listWorkflows(tenant_id, { limit, offset }, exec)).rows,
    )
  ).filter((wf) => wf.lifecycle !== "archived");
  const workflowSlugById = new Map(workflowRows.map((wf) => [wf.id, wf.slug]));
  for (const wf of workflowRows) {
    index.workflows.set(wf.slug, wf.id);
    if (wf.category === PLATFORM_CATEGORY) continue;
    const definition =
      wf.current_version_id !== null
        ? wf.definition
        : (await getWorkflowDraft(tenant_id, wf.id, exec))?.definition;
    if (!definition) continue;
    const tokens: Record<string, string> = {};
    for (const [id, key] of connectorKeyById) tokens[id] = `${CONNECTOR_REF_PREFIX}${key}`;
    const portable = replaceCallWorkflowIds(
      rebindConnectorIds(definition, tokens),
      workflowSlugById,
    ) as Record<string, unknown>;
    const connectorKeys = new Set<string>();
    connectorTokens(portable, connectorKeys);
    for (const match of JSON.stringify(portable).matchAll(PLACEHOLDER)) {
      for (const key of connectorKeysBySlug.get(match[1] ?? "") ?? []) connectorKeys.add(key);
    }
    const subWorkflows = new Set<string>();
    callSlugs(portable, subWorkflows);
    subWorkflows.delete(wf.slug);
    const payload: WorkflowPayload = {
      slug: wf.slug,
      name: wf.name,
      description: wf.description,
      category: wf.category,
      connectors: [...connectorKeys].sort(),
      workflows: [...subWorkflows].sort(),
      definition: portable,
    };
    requires.push({ kind: "approval", workflow: wf.slug });
    add({ kind: "workflow", key: wf.slug, payload }, [
      ...payload.connectors.map((key) => ({ kind: "connector" as const, key })),
      ...payload.workflows.map((key) => ({ kind: "workflow" as const, key })),
      { kind: "schedule", key: wf.slug },
    ]);
  }

  const scheduleRows = await exec
    .select()
    .from(workflowsSchedules)
    .where(eq(workflowsSchedules.tenant_id, tenant_id))
    .orderBy(asc(workflowsSchedules.id));
  for (const row of scheduleRows) {
    const slug = workflowSlugById.get(row.workflow_id);
    if (!slug) continue;
    index.schedules.set(slug, row.id);
    const payload: SchedulePayload = {
      workflow: slug,
      cron: row.cron,
      timezone: row.timezone,
      execution_mode: row.execution_mode,
      input: row.input ?? null,
    };
    requires.push({ kind: "schedule_resume", workflow: slug });
    add({ kind: "schedule", key: slug, payload }, [{ kind: "workflow", key: slug }]);
  }

  const skillRows = (
    await pageAll((offset, limit) => listSkills({ tenant_id, limit, offset }, exec))
  ).sort((a, b) => {
    const at = String(a.created_at);
    const bt = String(b.created_at);
    if (at !== bt) return at < bt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const takenSkillSlugs = new Set(skillRows.flatMap((s) => (s.slug ? [s.slug] : [])));
  const skillKeyById = new Map<string, string>();
  for (const skill of skillRows) {
    const key = skill.slug ?? uniqueSlug(slugify(skill.title), takenSkillSlugs);
    index.skills.set(key, skill.id);
    skillKeyById.set(skill.id, key);
    if (
      skill.status === "archived" ||
      EXCLUDED_SKILL_SOURCES.has(skill.source) ||
      skill.category === PLATFORM_CATEGORY
    ) {
      continue;
    }
    const connector = skill.connector_id
      ? (connectorKeyById.get(skill.connector_id) ?? null)
      : null;
    const workflow = skill.workflow_id ? (workflowSlugById.get(skill.workflow_id) ?? null) : null;
    const payload: SkillPayload = {
      slug: key,
      title: skill.title,
      description: skill.description,
      category: skill.category,
      body: skill.body,
      scope: skill.scope,
      connector,
      workflow,
      examples: skill.examples,
      best_practices: skill.best_practices,
      pitfalls: skill.pitfalls,
      doc_refs: skill.doc_refs,
      gates_tools: skill.gates_tools,
      activates_when: skill.activates_when,
      input_schema: skill.input_schema,
      output_schema: skill.output_schema,
      side_effects: skill.side_effects,
      idempotency: skill.idempotency,
      maturity: skill.maturity,
      tags: skill.tags,
      applies_to: skill.applies_to,
    };
    add({ kind: "skill", key, payload }, [
      ...(connector ? [{ kind: "connector" as const, key: connector }] : []),
      ...(workflow ? [{ kind: "workflow" as const, key: workflow }] : []),
    ]);
  }

  const knowledgeRows = await pageAll((offset, limit) =>
    listKnowledgeSources({ tenant_id, limit, offset }, exec),
  );
  for (const source of knowledgeRows) {
    index.knowledge.set(source.slug, source.id);
    if (source.source_type === "seed" || source.category === PLATFORM_CATEGORY) continue;
    const content = await getKnowledgeSourceContent(tenant_id, source.id, exec);
    const payload: KnowledgePayload = {
      slug: source.slug,
      name: source.name,
      description: source.description,
      category: source.category,
      tags: source.tags,
      source_type: source.source_type,
      documents: content?.documents ?? [],
    };
    requires.push({ kind: "knowledge_review", knowledge: source.slug });
    add({ kind: "knowledge", key: source.slug, payload });
  }

  const knowledgeFiles = await exec
    .select({ file_id: knowledgeSources.file_id })
    .from(knowledgeSources)
    .where(eq(knowledgeSources.tenant_id, tenant_id));
  const knowledgeFileIds = new Set(
    knowledgeFiles.flatMap((row) => (row.file_id ? [row.file_id] : [])),
  );
  const fileRows = await exec
    .select()
    .from(files)
    .where(
      and(eq(files.tenant_id, tenant_id), eq(files.status, "ready"), isNull(files.deleted_at)),
    );
  const linkRows =
    fileRows.length === 0
      ? []
      : await exec
          .select()
          .from(fileLinks)
          .where(
            and(
              eq(fileLinks.tenant_id, tenant_id),
              inArray(
                fileLinks.file_id,
                fileRows.map((row) => row.id),
              ),
            ),
          );
  const linksByFile = new Map<string, (typeof linkRows)[number][]>();
  for (const link of linkRows) {
    linksByFile.set(link.file_id, [...(linksByFile.get(link.file_id) ?? []), link]);
  }
  let total = 0;
  for (const row of fileRows) {
    if (!row.sha256 || row.content_type === PACKAGE_CONTENT_TYPE) continue;
    const links = linksByFile.get(row.id) ?? [];
    if (links.some((link) => RUN_LINK_TYPES.has(link.resource_type))) continue;
    if (knowledgeFileIds.has(row.id)) continue;
    if (links.some((link) => link.resource_type === "knowledge_source")) continue;
    index.files.set(row.sha256, row.id);
    if (row.category === PLATFORM_CATEGORY) continue;
    if (row.size_bytes > PACKAGE_MAX_ENTRY_BYTES) {
      throw new PackageTooLargeError(row.size_bytes, PACKAGE_MAX_ENTRY_BYTES);
    }
    total += row.size_bytes;
    if (total > PACKAGE_MAX_BYTES) throw new PackageTooLargeError(total, PACKAGE_MAX_BYTES);
    const portableLinks: FilePayload["links"] = [];
    for (const link of links) {
      if (link.resource_type === "skill") {
        const key = skillKeyById.get(link.resource_id);
        if (key) {
          portableLinks.push({ resource_kind: "skill", key, slug: link.slug, role: link.role });
        }
      } else if (link.resource_type === "connector") {
        const key = connectorKeyById.get(link.resource_id);
        if (key) {
          portableLinks.push({ resource_kind: "connector", key, slug: link.slug, role: link.role });
        }
      }
    }
    portableLinks.sort((a, b) =>
      `${a.resource_kind}:${a.key}:${a.slug}` < `${b.resource_kind}:${b.key}:${b.slug}` ? -1 : 1,
    );
    const payload: FilePayload = {
      sha256: row.sha256,
      filename: row.filename,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
      slug: row.slug,
      description: row.description,
      category: row.category,
      links: portableLinks,
    };
    const bytes = opts.include_bytes
      ? new Uint8Array(await getObjectStore().get(storageKey(row.storage_uri)))
      : new Uint8Array();
    add(
      { kind: "file", key: row.sha256, payload, bytes },
      portableLinks.map((link) => ({ kind: link.resource_kind, key: link.key })),
    );
  }

  const selected = opts.kinds?.length
    ? closure(payloads, deps, new Set(opts.kinds))
    : new Set(payloads.map((p) => `${p.kind}:${p.key}`));
  const kept = sortPayloads(payloads.filter((p) => selected.has(`${p.kind}:${p.key}`)));
  const keptKeys = new Set(kept.map((p) => `${p.kind}:${p.key}`));
  const keptRequires = requires.filter((r) => {
    if (r.kind === "credential") return keptKeys.has(`connector:${r.connector}`);
    if (r.kind === "approval") return keptKeys.has(`workflow:${r.workflow}`);
    if (r.kind === "schedule_resume") return keptKeys.has(`schedule:${r.workflow}`);
    return keptKeys.has(`knowledge:${r.knowledge}`);
  });
  return { tenant_slug: tenant?.slug ?? null, payloads: kept, requires: keptRequires, index };
}

function closure(
  payloads: readonly PackagePayload[],
  deps: ReadonlyMap<string, Dependency[]>,
  kinds: ReadonlySet<PackageItemKind>,
): Set<string> {
  const available = new Set(payloads.map((p) => `${p.kind}:${p.key}`));
  const out = new Set<string>();
  const queue = payloads.filter((p) => kinds.has(p.kind)).map((p) => `${p.kind}:${p.key}`);
  while (queue.length > 0) {
    const next = queue.pop();
    if (!next || out.has(next) || !available.has(next)) continue;
    out.add(next);
    for (const dep of deps.get(next) ?? []) queue.push(`${dep.kind}:${dep.key}`);
  }
  return out;
}
