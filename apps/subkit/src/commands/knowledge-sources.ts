import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { components } from "@cli-core/engine-api/openapi.d.ts";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import type { KnowledgeSourceMetadata } from "../engine-client/knowledge.ts";
import { EngineClient } from "../engine-client.ts";
import { collectBundleFiles, defaultBundleName } from "../lib/bundle-import.ts";
import {
  catalogMetadataArgs,
  catalogMetadataBody,
  catalogMetadataCreate,
  shortDescription,
} from "../lib/catalog-metadata.ts";
import { sanitizePathInput } from "../lib/path-input.ts";
import { renderIntent, renderSummary, renderTaskList } from "../render/index.ts";
import type { KnowledgeSourceIntent, KnowledgeSourceSummary, PlanStep } from "../render/types.ts";
import { detectMime } from "../utils/mime.ts";
import { withCommandErrors } from "./command-runtime.ts";
import { uploadPath } from "./files.ts";

type Schemas = components["schemas"];
type KnowledgeScope = Schemas["KnowledgeSource"]["scope"];
type KnowledgeStatus = NonNullable<Schemas["UpdateKnowledgeSourceBody"]["status"]>;

const KNOWLEDGE_SCOPES: readonly KnowledgeScope[] = ["global", "workflow"];
const KNOWLEDGE_STATUSES: readonly KnowledgeStatus[] = ["active", "inactive"];

function knowledgeScope(value: string): KnowledgeScope {
  const scope = KNOWLEDGE_SCOPES.find((candidate) => candidate === value);
  if (!scope) throw new Error(`--scope must be one of: ${KNOWLEDGE_SCOPES.join(", ")}`);
  return scope;
}

function knowledgeStatus(value: string): KnowledgeStatus {
  const status = KNOWLEDGE_STATUSES.find((candidate) => candidate === value);
  if (!status) throw new Error(`--status must be one of: ${KNOWLEDGE_STATUSES.join(", ")}`);
  return status;
}

function tagList(value: string): string[] {
  return value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List knowledge sources" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const { items } = await client.listKnowledgeSources({ limit: Number(args.limit) });
        if (args.json) {
          printJson(items);
          return;
        }
        const rows = items.map((it) => ({
          ...it,
          description: shortDescription(it.description),
          tags: it.tags.join(", "),
        }));
        emitList(
          false,
          ["id", "name", "category", "description", "tags", "chunk_count", "status"],
          rows,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a knowledge source by id" },
  args: {
    id: { type: "positional", required: true, description: "Knowledge source id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(async () => {
      const ks = await client.getKnowledgeSource(args.id);
      printJson(ks);
    });
  },
});

const searchCommand = defineCommand({
  meta: { name: "search", description: "Semantic search across knowledge sources" },
  args: {
    query: { type: "positional", required: true, description: "Search query" },
    tags: { type: "string", description: "Comma-separated tags to narrow results" },
    limit: { type: "string", description: "Max results", default: "10" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const { hits } = await client.searchKnowledge(args.query, {
          limit: Number(args.limit),
          ...(args.tags ? { tags: args.tags } : {}),
        });
        emitList(!!args.json, ["source_name", "title", "rank"], hits);
      },
      { json: Boolean(args.json) },
    );
  },
});

const createCommand = defineCommand({
  meta: { name: "create", description: "Upload a file as a knowledge source" },
  args: {
    file: { type: "string", required: true, description: "Path to file" },
    name: { type: "string", description: "Source name (defaults to the filename)" },
    ...catalogMetadataArgs,
    tags: {
      type: "string",
      description:
        "Comma-separated tags. When set, they are authoritative (no AI auto-tagging). Omit --description and --category to let the engine describe the source.",
    },
    scope: { type: "string", description: "Scope: global | workflow" },
    "workflow-id": { type: "string", description: "Workflow id (required when scope=workflow)" },
    json: { type: "boolean", description: "JSON-only output (suppresses narration)" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    const jsonMode = Boolean(args.json);
    return withCommandErrors(
      async () => {
        const filePath = sanitizePathInput(args.file);
        const fileBuffer = readFileSync(filePath);
        const size_bytes = statSync(filePath).size;
        const mime_type = detectMime(filePath);
        const title = args.name ?? basename(filePath);

        const intent: KnowledgeSourceIntent = {
          kind: "knowledge_source",
          file_path: filePath,
          title,
          mime_type,
          size_bytes,
        };
        await renderIntent(intent, { jsonMode });

        let file: Awaited<ReturnType<typeof uploadPath>>;
        let ks: Schemas["KnowledgeSource"];
        try {
          file = await uploadPath(client, filePath, { quiet: true });
        } catch (err) {
          const phases: PlanStep[] = [
            {
              id: "upload",
              label: "Upload",
              status: "failed",
              detail: err instanceof Error ? err.message : String(err),
            },
            { id: "create", label: "Create", status: "pending" },
            { id: "link", label: "Link", status: "pending" },
          ];
          await renderTaskList(phases, { jsonMode });
          throw err;
        }
        const metadata: KnowledgeSourceMetadata = { name: title, ...catalogMetadataCreate(args) };
        if (args.tags) metadata.tags = tagList(args.tags);
        if (args.scope) metadata.scope = knowledgeScope(args.scope);
        if (args["workflow-id"]) metadata.workflow_id = args["workflow-id"];
        try {
          ks = await client.createKnowledgeSource(
            {
              name: title,
              content: fileBuffer,
              mime_type,
            },
            metadata,
          );
        } catch (err) {
          const phases: PlanStep[] = [
            { id: "upload", label: "Upload", status: "succeeded" },
            {
              id: "create",
              label: "Create",
              status: "failed",
              detail: err instanceof Error ? err.message : String(err),
            },
            { id: "link", label: "Link", status: "pending" },
          ];
          await renderTaskList(phases, { jsonMode });
          throw err;
        }

        let linkFailed = false;
        const ksId = ks.id || null;
        if (ksId) {
          try {
            await client.linkFile(file.id, {
              resource_type: "knowledge_source",
              resource_id: ksId,
            });
          } catch {
            linkFailed = true;
          }
        }

        printJson(ks);

        const summary: KnowledgeSourceSummary = {
          kind: "knowledge_source",
          id: ksId ?? "(unknown)",
          name: ks.name,
          mime_type,
          size_bytes,
          ...(typeof ks.description === "string" ? { description: ks.description } : {}),
          tags: ks.tags,
          ...(file.id ? { file_id: file.id } : {}),
          ...(linkFailed ? { link_failed: true } : {}),
        };
        await renderSummary(summary, { jsonMode });
      },
      { json: jsonMode },
    );
  },
});

const importCommand = defineCommand({
  meta: {
    name: "import",
    description:
      "Import a directory of markdown files as one knowledge source (upsert by slug; OKF-compatible frontmatter is read tolerantly)",
  },
  args: {
    dir: { type: "positional", required: true, description: "Directory to import" },
    name: { type: "string", description: "Source name (defaults to root index.md H1 or dirname)" },
    slug: { type: "string", description: "Stable slug (defaults to slugified name)" },
    ...catalogMetadataArgs,
    tags: { type: "string", description: "Comma-separated extra tags (frontmatter tags merge in)" },
    scope: { type: "string", description: "Scope: global | workflow" },
    "workflow-id": { type: "string", description: "Workflow id (required when scope=workflow)" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    const jsonMode = Boolean(args.json);
    return withCommandErrors(
      async () => {
        const dir = sanitizePathInput(args.dir);
        const bundle = collectBundleFiles(dir);
        const name = args.name ?? defaultBundleName(dir, bundle.files);
        const result = await client.importKnowledgeBundle({
          name,
          ...(args.slug ? { slug: args.slug } : {}),
          ...catalogMetadataCreate(args),
          ...(args.tags ? { tags: tagList(args.tags) } : {}),
          ...(args.scope ? { scope: knowledgeScope(args.scope) } : {}),
          ...(args["workflow-id"] ? { workflow_id: args["workflow-id"] } : {}),
          files: bundle.files,
        });
        if (jsonMode) {
          printJson(result);
          return;
        }
        const ks = result.knowledge_source;
        process.stdout.write(
          `${pc.green(result.outcome)}: ${ks.name} (${ks.slug}) — ` +
            `${bundle.files.length} files, ${result.ingested_count} chunks ingested, ` +
            `${result.skipped_count} skipped` +
            (bundle.skipped_non_markdown > 0
              ? `, ${bundle.skipped_non_markdown} non-markdown files left out`
              : "") +
            "\n",
        );
      },
      { json: jsonMode },
    );
  },
});

const patchCommand = defineCommand({
  meta: { name: "patch", description: "Update a knowledge source" },
  args: {
    id: { type: "positional", required: true, description: "Knowledge source id" },
    name: { type: "string", description: "New name" },
    ...catalogMetadataArgs,
    tags: { type: "string", description: "Comma-separated tags (replaces existing)" },
    status: { type: "string", description: "Status: active | inactive" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    if (
      !args.name &&
      args.tags === undefined &&
      !args.status &&
      Object.keys(catalogMetadataBody(args)).length === 0
    ) {
      const msg = "at least one of --name, --description, --category, --tags, --status is required";
      process.stderr.write(`${pc.red("error")}: ${msg}\n`);
      throw new Error(msg);
    }
    return withCommandErrors(async () => {
      const body: Schemas["UpdateKnowledgeSourceBody"] = { ...catalogMetadataBody(args) };
      if (args.name) body.name = args.name;
      if (args.tags !== undefined) body.tags = tagList(args.tags);
      if (args.status) body.status = knowledgeStatus(args.status);
      const ks = await client.patchKnowledgeSource(args.id, body);
      printJson(ks);
    });
  },
});

const analyzeCommand = defineCommand({
  meta: {
    name: "analyze",
    description: "Generate a description + tags for a knowledge source via the engine LLM",
  },
  args: {
    id: { type: "positional", required: true, description: "Knowledge source id" },
    force: { type: "boolean", description: "Overwrite an existing description", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(async () => {
      const result = await client.analyzeKnowledgeSource(args.id, { force: Boolean(args.force) });
      printJson(result);
    });
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a knowledge source" },
  args: {
    id: { type: "positional", required: true, description: "Knowledge source id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(async () => {
      await client.deleteKnowledgeSource(args.id);
      process.stdout.write(`${pc.green("deleted")}\n`);
    });
  },
});

function authorLabel(author: Schemas["KnowledgeSourceVersionAuthor"]): string {
  return author ? `${author.kind}:${author.id}` : "system";
}

const historyCommand = defineCommand({
  meta: {
    name: "history",
    description: "Show a knowledge source's content versions (newest first)",
  },
  args: {
    id: { type: "positional", required: true, description: "Knowledge source id" },
    limit: { type: "string", description: "Max rows" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const { items } = await client.knowledgeHistory(
          args.id,
          args.limit ? { limit: Number(args.limit) } : {},
        );
        if (args.json) {
          printJson(items);
          return;
        }
        emitList(
          false,
          ["version", "current", "author", "note", "created_at"],
          items.map((it) => ({ ...it, author: authorLabel(it.author), note: it.note ?? "" })),
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

const restoreCommand = defineCommand({
  meta: {
    name: "restore",
    description: "Restore an earlier content version; the result is a new version",
  },
  args: {
    id: { type: "positional", required: true, description: "Knowledge source id" },
    to: {
      type: "string",
      required: true,
      description: "Version number from `subkit knowledge-sources history`",
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const version = Number(args.to);
    if (!Number.isInteger(version) || version <= 0) {
      process.stderr.write(
        "subkit knowledge-sources restore: --to must be a positive version number\n",
      );
      process.exitCode = 2;
      return;
    }
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const restored = await client.restoreKnowledgeVersion(args.id, version);
        if (args.json) {
          printJson(restored);
          return;
        }
        process.stdout.write(`${pc.green("restored")} v${version} as v${restored.version}\n`);
      },
      { json: Boolean(args.json) },
    );
  },
});

export const knowledgeSourcesCommand = defineCommand({
  meta: { name: "knowledge-sources", description: "Manage knowledge sources" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    search: searchCommand,
    create: createCommand,
    import: importCommand,
    patch: patchCommand,
    analyze: analyzeCommand,
    history: historyCommand,
    restore: restoreCommand,
    delete: deleteCommand,
  },
});
