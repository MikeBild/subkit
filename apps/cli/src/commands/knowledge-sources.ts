// `subkit knowledge-sources ...`

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "List knowledge sources" },
  args: {
    ...clientArgs,
    scope: { type: "string", description: "Filter by scope (global|workflow)" },
    status: { type: "string", description: "Filter by status (active|inactive|processing|error)" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.listKnowledgeSources({
      scope: args.scope as string | undefined,
      status: args.status as string | undefined,
    });
    emitList(
      asJson,
      ["id", "name", "scope", "status", "chunk_count", "bytes_total", "updated_at"],
      body.items as unknown as Record<string, unknown>[],
    );
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Fetch a knowledge source" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Knowledge source id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const s = await client.getKnowledgeSource(args.id as string);
    emitOne(asJson, s as unknown as Record<string, unknown>);
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Create a knowledge source from a file" },
  args: {
    ...clientArgs,
    file: { type: "string", description: "Path to file", required: true },
    name: { type: "string", description: "Display name (defaults to filename)" },
    scope: { type: "string", description: "Scope: global (default) or workflow" },
    "workflow-id": { type: "string", description: "Workflow ID (required when scope=workflow)" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const filePath = args.file as string;
    const content = readFileSync(filePath);
    const fileName = basename(filePath);
    const displayName = (args.name as string | undefined) ?? fileName.replace(/\.[^.]+$/, "");

    const metadata: Record<string, unknown> = { name: displayName };
    if (args.scope) metadata.scope = args.scope;
    if (args["workflow-id"]) metadata.workflow_id = args["workflow-id"];

    const created = await client.createKnowledgeSource({ name: fileName, content }, metadata);
    emitOne(asJson, created as unknown as Record<string, unknown>);
  },
});

const searchCmd = defineCommand({
  meta: { name: "search", description: "Search across knowledge sources" },
  args: {
    ...clientArgs,
    query: { type: "positional", description: "Search query", required: true },
    limit: { type: "string", description: "Max results (default 10)" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.searchKnowledge(args.query as string, {
      limit: args.limit ? Number(args.limit) : undefined,
    });
    emitList(
      asJson,
      ["id", "knowledge_source_id", "title", "snippet", "rank"],
      body.hits as unknown as Record<string, unknown>[],
    );
  },
});

const deleteCmd = defineCommand({
  meta: { name: "delete", description: "Delete a knowledge source" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Knowledge source id", required: true },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    await client.deleteKnowledgeSource(args.id as string);
    process.stdout.write("deleted\n");
  },
});

export const knowledgeSourcesCommand = defineCommand({
  meta: { name: "knowledge-sources", description: "Knowledge source management" },
  subCommands: {
    list: listCmd,
    get: getCmd,
    create: createCmd,
    search: searchCmd,
    delete: deleteCmd,
  },
});
