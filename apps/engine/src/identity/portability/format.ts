import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";

export const PACKAGE_FORMAT = "subkit-package/v1";
export const PACKAGE_CONTENT_TYPE = "application/vnd.subkit.package+zip";
export const PACKAGE_MAX_BYTES = 256 * 1024 * 1024;
export const PACKAGE_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
export const PACKAGE_MAX_ENTRIES = 10_000;
export const PACKAGE_MAX_COMPRESSION_RATIO = 200;
export const CONNECTOR_REF_PREFIX = "package-connector:";

export const PackageItemKindSchema = z.enum([
  "connector_template",
  "connector",
  "file",
  "skill",
  "workflow",
  "schedule",
  "knowledge",
]);
export type PackageItemKind = z.infer<typeof PackageItemKindSchema>;

export const PACKAGE_KIND_ORDER: readonly PackageItemKind[] = [
  "connector_template",
  "connector",
  "file",
  "skill",
  "workflow",
  "schedule",
  "knowledge",
];

const PACKAGE_KIND_DIRECTORY: Record<PackageItemKind, string> = {
  connector_template: "connector-templates",
  connector: "connectors",
  file: "files",
  skill: "skills",
  workflow: "workflows",
  schedule: "schedules",
  knowledge: "knowledge",
};

const SlugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const ConnectorKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*@(dev|prod)$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const JsonRecordSchema = z.record(z.string(), z.unknown());

export const PackageManifestItemSchema = z
  .object({
    kind: PackageItemKindSchema,
    key: z.string().min(1).max(220),
    path: z.string().min(1).max(400),
    sha256: Sha256Schema,
    blob_path: z.string().min(1).max(400).optional(),
    blob_sha256: Sha256Schema.optional(),
  })
  .openapi("PackageManifestItem");
export type PackageManifestItem = z.infer<typeof PackageManifestItemSchema>;

export const PackageRequirementSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("credential"),
      connector: ConnectorKeySchema,
      fields: z.array(z.string()),
    }),
    z.object({ kind: z.literal("approval"), workflow: SlugSchema }),
    z.object({ kind: z.literal("schedule_resume"), workflow: SlugSchema }),
    z.object({ kind: z.literal("knowledge_review"), knowledge: SlugSchema }),
  ])
  .openapi("PackageRequirement");
export type PackageRequirement = z.infer<typeof PackageRequirementSchema>;

export const PackageManifestSchema = z
  .object({
    format: z.literal(PACKAGE_FORMAT),
    kind: z.enum(["tenant-export", "fachpaket"]),
    package_id: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    source: z.object({
      instance: z.string().max(400).nullable(),
      tenant_slug: z.string().max(200).nullable(),
      engine_version: z.string().max(100).nullable(),
    }),
    exported_at: z.string(),
    content_digest: Sha256Schema,
    items: z.array(PackageManifestItemSchema),
    requires: z.array(PackageRequirementSchema),
  })
  .openapi("PackageManifest");
export type PackageManifest = z.infer<typeof PackageManifestSchema>;

export const ConnectorTemplatePayloadSchema = z.object({
  slug: SlugSchema,
  name: z.string(),
  driver: z.string(),
  base_url: z.string(),
  auth_type: z.string(),
  oauth: JsonRecordSchema.nullable(),
  default_skill: z.string().nullable(),
  ingestion_source: z.string(),
  ingestion_url: z.string().nullable(),
  icon: z.string(),
  description: z.string(),
  category: z.string().nullable(),
  tags: z.array(z.unknown()),
  aliases: z.array(z.unknown()),
  setup_instructions: z.string(),
  auth_options: z.array(z.unknown()),
  url_pattern: z.string(),
  keywords: z.array(z.unknown()),
  inline_schema: z.unknown(),
  probe_endpoint: z.unknown(),
  credential_hints: z.array(z.unknown()),
  base_url_options: z.array(z.unknown()),
  pagination_defaults: z.unknown(),
  capabilities: z.unknown(),
});
export type ConnectorTemplatePayload = z.infer<typeof ConnectorTemplatePayloadSchema>;

export const ConnectorPayloadSchema = z.object({
  slug: SlugSchema,
  environment: z.enum(["dev", "prod"]),
  name: z.string().min(1),
  driver: z.string(),
  auth_type: z.string(),
  base_url: z.string().nullable(),
  config: JsonRecordSchema,
  operator_quirks: JsonRecordSchema,
  template_slug: z.string().nullable(),
  template_source: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
});
export type ConnectorPayload = z.infer<typeof ConnectorPayloadSchema>;

const FileLinkPayloadSchema = z.object({
  resource_kind: z.enum(["skill", "connector"]),
  key: z.string(),
  slug: z.string().nullable(),
  role: z.string().nullable(),
});

export const FilePayloadSchema = z.object({
  sha256: Sha256Schema,
  filename: z.string().min(1),
  content_type: z.string().nullable(),
  size_bytes: z.number().int().nonnegative(),
  slug: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  links: z.array(FileLinkPayloadSchema),
});
export type FilePayload = z.infer<typeof FilePayloadSchema>;

export const SkillPayloadSchema = z.object({
  slug: SlugSchema,
  title: z.string().min(1),
  description: z.string().nullable(),
  category: z.string().nullable(),
  body: z.string().min(1),
  scope: z.enum(["global", "connector", "workflow"]),
  connector: ConnectorKeySchema.nullable(),
  workflow: SlugSchema.nullable(),
  examples: z.array(z.string()),
  best_practices: z.array(z.string()),
  pitfalls: z.array(z.string()),
  doc_refs: z.array(z.string()),
  gates_tools: z.array(z.string()),
  activates_when: z.array(z.unknown()),
  input_schema: JsonRecordSchema.nullable(),
  output_schema: JsonRecordSchema.nullable(),
  side_effects: z.string(),
  idempotency: z.string(),
  maturity: z.string(),
  tags: z.array(z.string()),
  applies_to: z.string(),
  audience: z.array(z.string()).optional(),
});
export type SkillPayload = z.infer<typeof SkillPayloadSchema>;

export const WorkflowPayloadSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  category: z.string().nullable(),
  connectors: z.array(ConnectorKeySchema),
  workflows: z.array(SlugSchema),
  definition: JsonRecordSchema,
});
export type WorkflowPayload = z.infer<typeof WorkflowPayloadSchema>;

export const SchedulePayloadSchema = z.object({
  workflow: SlugSchema,
  cron: z.string().min(1),
  timezone: z.string(),
  execution_mode: z.enum(["dev", "prod"]),
  input: z.unknown(),
});
export type SchedulePayload = z.infer<typeof SchedulePayloadSchema>;

export const KnowledgePayloadSchema = z.object({
  slug: SlugSchema,
  name: z.string().min(1),
  description: z.string().nullable(),
  category: z.string().nullable(),
  tags: z.array(z.string()),
  source_type: z.string(),
  documents: z.array(z.object({ path: z.string(), content: z.string() })),
});
export type KnowledgePayload = z.infer<typeof KnowledgePayloadSchema>;

export type PackagePayload =
  | { kind: "connector_template"; key: string; payload: ConnectorTemplatePayload }
  | { kind: "connector"; key: string; payload: ConnectorPayload }
  | { kind: "file"; key: string; payload: FilePayload; bytes: Uint8Array }
  | { kind: "skill"; key: string; payload: SkillPayload }
  | { kind: "workflow"; key: string; payload: WorkflowPayload }
  | { kind: "schedule"; key: string; payload: SchedulePayload }
  | { kind: "knowledge"; key: string; payload: KnowledgePayload };

export const PAYLOAD_SCHEMAS = {
  connector_template: ConnectorTemplatePayloadSchema,
  connector: ConnectorPayloadSchema,
  file: FilePayloadSchema,
  skill: SkillPayloadSchema,
  workflow: WorkflowPayloadSchema,
  schedule: SchedulePayloadSchema,
  knowledge: KnowledgePayloadSchema,
} as const;

export function connectorKey(slug: string, environment: string): string {
  return `${slug}@${environment}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = sortValue(child);
  }
  return out;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function payloadBytes(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(payload)}\n`);
}

export function payloadHash(payload: unknown): string {
  return sha256Hex(payloadBytes(payload));
}

export function itemPath(kind: PackageItemKind, key: string): string {
  return `${PACKAGE_KIND_DIRECTORY[kind]}/${key}.json`;
}

export function blobPath(sha256: string): string {
  return `files/${sha256}.bin`;
}

export function contentDigest(items: readonly PackageManifestItem[]): string {
  const lines = items
    .flatMap((item) => [
      `${item.path}:${item.sha256}`,
      ...(item.blob_path && item.blob_sha256 ? [`${item.blob_path}:${item.blob_sha256}`] : []),
    ])
    .sort();
  return sha256Hex(lines.join("\n"));
}

export function sortPayloads<T extends { kind: PackageItemKind; key: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const kind = PACKAGE_KIND_ORDER.indexOf(a.kind) - PACKAGE_KIND_ORDER.indexOf(b.kind);
    return kind !== 0 ? kind : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

export function stableUuid(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
