import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import { renderIntent, renderSummary, renderTaskList } from "../render/index.ts";
import type { KnowledgeSourceIntent, KnowledgeSourceSummary } from "../render/types.ts";
import type { PlanStep } from "../repl/plan-cell.tsx";
import { detectMime } from "../utils/mime.ts";
import { uploadPath } from "./files.ts";

// Subcommand handlers never call `process.exit`; they throw the error
// and rely on the top-level `sk` dispatcher (apps/sk/src/index.ts) to
// translate it to an exit code via `exitCodeFor`. This keeps Citty's
// runCommand composable from test harnesses and preserves the original
// error for the catch chain instead of swallowing it behind a synthetic
// "process.exit(N)" Error.

const listCommand = defineCommand({
  meta: { name: "list", description: "List knowledge sources" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const { items } = await client.listKnowledgeSources({ limit: Number(args.limit) });
      emitList(!!args.json, ["id", "title", "kind", "status"], items as Record<string, unknown>[]);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      throw err;
    }
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
    try {
      const ks = await client.getKnowledgeSource(args.id);
      printJson(ks);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      throw err;
    }
  },
});

const searchCommand = defineCommand({
  meta: { name: "search", description: "Semantic search across knowledge sources" },
  args: {
    query: { type: "positional", required: true, description: "Search query" },
    limit: { type: "string", description: "Max results", default: "10" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const { items } = await client.searchKnowledge(args.query, { limit: Number(args.limit) });
      emitList(!!args.json, ["id", "title", "score"], items as Record<string, unknown>[]);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      throw err;
    }
  },
});

const createCommand = defineCommand({
  meta: { name: "create", description: "Upload a file as a knowledge source" },
  args: {
    file: { type: "string", required: true, description: "Path to file" },
    title: { type: "string", description: "Override title (defaults to filename)" },
    json: { type: "boolean", description: "JSON-only output (suppresses narration)" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    const jsonMode = Boolean(args.json);
    try {
      const filePath = args.file;
      const fileBuffer = readFileSync(filePath);
      const size_bytes = statSync(filePath).size;
      const mime_type = detectMime(filePath);
      const title = args.title ?? basename(filePath);

      const intent: KnowledgeSourceIntent = {
        kind: "knowledge_source",
        file_path: filePath,
        title,
        mime_type,
        size_bytes,
      };
      await renderIntent(intent, { jsonMode });

      // Upload + create are required; link is best-effort.
      let file: Awaited<ReturnType<typeof uploadPath>>;
      let ks: Record<string, unknown>;
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
      try {
        ks = (await client.createKnowledgeSource({
          name: title,
          content: fileBuffer,
          mime_type,
        })) as Record<string, unknown>;
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

      // Link is best-effort: the knowledge source already owns its
      // bytes; the file_link is a cross-reference for provenance.
      let linkFailed = false;
      const ksId = typeof ks.id === "string" ? ks.id : null;
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
        name: typeof ks.name === "string" ? ks.name : title,
        mime_type,
        size_bytes,
        ...(file.id ? { file_id: file.id } : {}),
        ...(linkFailed ? { link_failed: true } : {}),
      };
      await renderSummary(summary, { jsonMode });
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      throw err;
    }
  },
});

const patchCommand = defineCommand({
  meta: { name: "patch", description: "Update a knowledge source" },
  args: {
    id: { type: "positional", required: true, description: "Knowledge source id" },
    title: { type: "string", required: true, description: "New title" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const ks = await client.patchKnowledgeSource(args.id, { name: args.title });
      printJson(ks);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      throw err;
    }
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
    try {
      await client.deleteKnowledgeSource(args.id);
      process.stdout.write(`${pc.green("deleted")}\n`);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      throw err;
    }
  },
});

export const knowledgeSourcesCommand = defineCommand({
  meta: { name: "knowledge-sources", description: "Manage knowledge sources" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    search: searchCommand,
    create: createCommand,
    patch: patchCommand,
    delete: deleteCommand,
  },
});
