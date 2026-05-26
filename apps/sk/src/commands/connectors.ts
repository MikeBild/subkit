import * as prompts from "@clack/prompts";
import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson, printTable } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import { renderIntent, renderSummary, renderTaskList } from "../render/index.ts";
import type { ConnectorIntent, ConnectorSummary, PlanStep } from "../render/types.ts";

// See workflows.ts:reportError — same contract: jsonMode keeps stderr
// silent so callers can pipe `sk connectors create --json` into jq.
function reportError(err: unknown, jsonMode: boolean): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
  } else {
    process.stderr.write(`${msg}\n`);
  }
  process.exit(exitCodeFor(err));
}

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List connectors" },
  args: {
    limit: { type: "string", description: "Max rows", default: "50" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listConnectors({ limit: Number(args.limit) });
      emitList(
        !!args.json,
        ["id", "name", "slug", "environment", "template_slug"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a connector by id" },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getConnector(args.id));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const createCommand = defineCommand({
  meta: {
    name: "create",
    description:
      "Create a connector from a template slug. Runs a driver probe after create unless --skip-checks is set.",
  },
  args: {
    template: { type: "string", required: true, description: "Template slug" },
    name: { type: "string", description: "Override connector name" },
    "skip-checks": {
      type: "boolean",
      description: "Skip the post-create driver probe (NOT recommended).",
    },
    json: { type: "boolean", description: "JSON-only output (suppresses narration)" },
  },
  async run({ args }) {
    const client = makeClient();
    const jsonMode = Boolean(args.json);
    try {
      const intent: ConnectorIntent = {
        kind: "connector",
        template_slug: args.template as string,
        ...(args.name ? { name: args.name } : {}),
      };
      await renderIntent(intent, { jsonMode });

      const body: Record<string, unknown> = {};
      if (args.name) body.name = args.name;
      const created = (await client.createConnectorFromTemplate(
        args.template as string,
        body,
      )) as Record<string, unknown> & { id?: string; slug?: string };
      printJson(created);

      const skip = Boolean((args as Record<string, unknown>)["skip-checks"]);
      let probe: ConnectorSummary["probe"];
      if (!skip && typeof created.id === "string") {
        try {
          const result = (await client.testConnector(created.id)) as Record<string, unknown> & {
            ok?: boolean;
            status_code?: number;
            duration_ms?: number;
          };
          probe = {
            ok: Boolean(result.ok),
            ...(typeof result.status_code === "number" ? { status_code: result.status_code } : {}),
            ...(typeof result.duration_ms === "number" ? { duration_ms: result.duration_ms } : {}),
          };
          if (!result.ok) {
            const phases: PlanStep[] = [
              { id: "create", label: "Create", status: "succeeded" },
              {
                id: "probe",
                label: "Probe",
                status: "failed",
                detail:
                  typeof result.error === "string"
                    ? result.error
                    : `status=${result.status_code ?? "?"}`,
              },
            ];
            await renderTaskList(phases, { jsonMode });
            // EX_DATAERR (sysexits.h 64): "the input data was incorrect in
            // some way". The connector exists but its driver probe came
            // back not-ok — distinct from a transport/auth failure (which
            // exitCodeFor maps to 2) and a hard usage error (1). Pinning
            // a stable code here lets CI scripts branch reliably on
            // "probe-said-no" without parsing stderr.
            process.exit(64);
          }
        } catch (err) {
          const phases: PlanStep[] = [
            { id: "create", label: "Create", status: "succeeded" },
            {
              id: "probe",
              label: "Probe",
              status: "failed",
              detail: err instanceof Error ? err.message : String(err),
            },
          ];
          await renderTaskList(phases, { jsonMode });
          process.exit(exitCodeFor(err));
        }
      } else if (skip && !jsonMode) {
        // Mirror the workflows.ts skip-checks reminder so the operator
        // sees the same warning at both authoring surfaces. Gated on
        // !jsonMode so the --json contract stays "stderr silent".
        process.stderr.write(
          `${pc.yellow("warning:")} --skip-checks active; no driver probe was run\n`,
        );
      }

      const summary: ConnectorSummary = {
        kind: "connector",
        id: typeof created.id === "string" ? created.id : "(unknown)",
        slug: typeof created.slug === "string" ? created.slug : (args.template as string),
        template_slug: args.template as string,
        ...(probe ? { probe } : {}),
      };
      await renderSummary(summary, { jsonMode });
    } catch (err) {
      reportError(err, jsonMode);
    }
  },
});

// probe is an alias for `test` that mirrors the conversational authoring
// vocabulary: "inspect -> validate -> probe -> save". The CLI exposes both
// names so operators can follow the same mental model from either surface.
const probeCommand = defineCommand({
  meta: {
    name: "probe",
    description: "Probe a connector's upstream boundary (alias of `test`).",
  },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const result = await client.testConnector(args.id);
      process.stdout.write(`ok: ${result.ok}\n`);
      if (!result.ok) process.exit(1);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

// inspect is an alias for `get` that mirrors the conversational authoring
// vocabulary. Returns the current connector resource body.
const inspectCommand = defineCommand({
  meta: {
    name: "inspect",
    description: "Inspect a connector resource (alias of `get`).",
  },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.getConnector(args.id));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const patchCommand = defineCommand({
  meta: { name: "patch", description: "Update a connector" },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
    name: { type: "string", description: "New name" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const body: Record<string, unknown> = {};
      if (args.name) body.name = args.name;
      printJson(await client.patchConnector(args.id, body));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a connector" },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  async run({ args }) {
    if (!args.yes) {
      const confirmed = await prompts.confirm({ message: `Delete connector "${args.id}"?` });
      if (!confirmed || prompts.isCancel(confirmed)) return;
    }
    const client = makeClient();
    try {
      await client.deleteConnector(args.id);
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const testCommand = defineCommand({
  meta: { name: "test", description: "Test a connector connection" },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const result = await client.testConnector(args.id);
      process.stdout.write(`ok: ${result.ok}\n`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const docsIngestCommand = defineCommand({
  meta: { name: "docs-ingest", description: "Ingest docs from a URL into a connector" },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
    url: { type: "string", required: true, description: "URL to ingest" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      printJson(await client.ingestConnectorDocs(args.id, { url: args.url }));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const docsListCommand = defineCommand({
  meta: { name: "docs-list", description: "List ingested docs for a connector" },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.listConnectorDocs(args.id);
      emitList(!!args.json, ["id", "title", "url"], items);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const docsSearchCommand = defineCommand({
  meta: { name: "docs-search", description: "Ranked search over connector docs" },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
    query: { type: "positional", required: true, description: "Search query" },
    limit: { type: "string", description: "Max results", default: "10" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items } = await client.searchConnectorDocs(args.id, args.query, Number(args.limit));
      printTable(
        ["id", "title", "match_type", "score"],
        items.map((item) => ({
          ...item,
          score: (item as Record<string, unknown>).rank,
        })),
      );
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

const docsDeleteCommand = defineCommand({
  meta: { name: "docs-delete", description: "Delete a connector doc" },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
    "doc-id": { type: "positional", required: true, description: "Doc id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      await client.deleteConnectorDoc(args.id, args["doc-id"]);
      process.stdout.write("deleted\n");
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(exitCodeFor(err));
    }
  },
});

export const connectorsCommand = defineCommand({
  meta: { name: "connectors", description: "Manage connectors" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    inspect: inspectCommand,
    create: createCommand,
    patch: patchCommand,
    delete: deleteCommand,
    test: testCommand,
    probe: probeCommand,
    "docs-ingest": docsIngestCommand,
    "docs-list": docsListCommand,
    "docs-search": docsSearchCommand,
    "docs-delete": docsDeleteCommand,
  },
});
