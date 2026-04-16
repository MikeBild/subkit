// `subkit connectors ...`

import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import type { EngineClient } from "../engine-client.ts";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

export async function runList(client: EngineClient, asJson: boolean): Promise<number> {
  const body = await client.listConnectors();
  emitList(
    asJson,
    ["id", "slug", "display_name", "driver", "environment", "auth_type"],
    body.items as unknown as Record<string, unknown>[],
  );
  return 0;
}

const listCmd = defineCommand({
  meta: { name: "list", description: "List connectors" },
  args: clientArgs,
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await runList(client, asJson);
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Fetch a connector" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Connector id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const c = await client.getConnector(args.id as string);
    emitOne(asJson, c as unknown as Record<string, unknown>);
  },
});

const testCmd = defineCommand({
  meta: { name: "test", description: "Probe connector health" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Connector id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const result = await client.testConnector(args.id as string);
    emitOne(asJson, result as unknown as Record<string, unknown>);
  },
});

const createCmd = defineCommand({
  meta: { name: "create", description: "Create a connector from a JSON file" },
  args: {
    ...clientArgs,
    file: { type: "string", description: "Path to connector JSON", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = JSON.parse(readFileSync(args.file as string, "utf8")) as Record<string, unknown>;
    const created = await client.createConnector(body);
    emitOne(asJson, created as unknown as Record<string, unknown>);
  },
});

const docsIngestCmd = defineCommand({
  meta: { name: "ingest", description: "Ingest documentation into a connector" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Connector id", required: true },
    source: {
      type: "string",
      description: "openapi|markdown|llms_txt",
      required: true,
    },
    url: { type: "string", description: "Source URL" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body: { source_type: string; url?: string; content?: string } = {
      source_type: args.source as string,
    };
    if (typeof args.url === "string" && args.url) body.url = args.url;
    const result = await client.ingestConnectorDocs(args.id as string, body);
    emitOne(asJson, result as unknown as Record<string, unknown>);
  },
});

const docsSearchCmd = defineCommand({
  meta: { name: "search", description: "Full-text search over connector docs" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Connector id", required: true },
    q: { type: "string", description: "Search query", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const result = (await client.searchConnectorDocs(args.id as string, args.q as string)) as {
      items: Record<string, unknown>[];
    };
    emitList(asJson, ["id", "document_id", "title", "path", "rank"], result.items);
  },
});

const docsCmd = defineCommand({
  meta: { name: "docs", description: "Connector documentation" },
  subCommands: { ingest: docsIngestCmd, search: docsSearchCmd },
});

export const connectorsCommand = defineCommand({
  meta: { name: "connectors", description: "Connector management" },
  subCommands: {
    list: listCmd,
    get: getCmd,
    test: testCmd,
    create: createCmd,
    docs: docsCmd,
  },
});
