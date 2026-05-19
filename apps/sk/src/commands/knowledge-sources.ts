import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
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
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const filePath = args.file;
      // First register the bytes in the unified `files` table. Every
      // CLI surface that ingests a local path funnels through
      // `uploadPath` so the file is dedup-able + auditable. The
      // resulting fid is linked to the knowledge_source after creation
      // — until the engine route accepts `file_id` directly, the
      // legacy multipart call is still the persistence path, but the
      // file row makes the audit trail honest.
      const file = await uploadPath(client, filePath, { quiet: true });
      const fileBuffer = readFileSync(filePath);
      const mime_type = detectMime(filePath);
      const name = args.title ?? basename(filePath);
      const ks = (await client.createKnowledgeSource({
        name,
        content: fileBuffer,
        mime_type,
      })) as Record<string, unknown>;
      const ksId = typeof ks.id === "string" ? ks.id : null;
      if (ksId) {
        try {
          await client.linkFile(file.id, {
            resource_type: "knowledge_source",
            resource_id: ksId,
          });
        } catch {
          // Linking is best-effort — the knowledge source already
          // owns its bytes; the file_link is a cross-reference for
          // future provenance queries.
        }
      }
      printJson(ks);
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
