import * as prompts from "@clack/prompts";
import { exitCodeFor, reportCommandError } from "@cli-core/errors";
import { emitGroupedList, emitList, printJson, printTable } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import {
  catalogMetadataArgs,
  catalogMetadataBody,
  shortDescription,
} from "../lib/catalog-metadata.ts";
import {
  connectorDisplayName,
  connectorPatchBody,
  connectorPatchDraft,
  unwrapConnectorRecord,
} from "../lib/connector-patch.ts";
import { pickId } from "../lib/pick.ts";
import { renderIntent, renderSummary, renderTaskList } from "../render/index.ts";
import type { ConnectorIntent, ConnectorSummary, PlanStep } from "../render/types.ts";
import { CONNECTOR_LIST_COLUMNS } from "./list-columns.ts";

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

const fetchConnectorRows = async (client: EngineClient) => {
  const { items } = await client.listConnectors({ limit: 50 });
  return (items as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name:
      typeof r.display_name === "string"
        ? r.display_name
        : typeof r.name === "string"
          ? r.name
          : null,
    detail: typeof r.slug === "string" ? r.slug : null,
  }));
};

const listCommand = defineCommand({
  meta: { name: "list", description: "List connectors, grouped into catalog blocks" },
  args: {
    limit: { type: "string", description: "Max rows", default: "50" },
    category: { type: "string", description: "Only this catalog block" },
    driver: { type: "string", description: "Only this driver: http, graphql, postgres, s3, mcp" },
    flat: { type: "boolean", description: "One flat table instead of grouped blocks" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const { items, total, categories } = await client.listConnectors({
        limit: Number(args.limit),
        ...(args.category ? { category: args.category } : {}),
        ...(args.driver ? { driver: args.driver } : {}),
      });
      const rows = (items as Record<string, unknown>[]).map((r) => ({
        ...r,
        description: args.json ? r.description : shortDescription(r.description),
        name:
          typeof r.name === "string" && r.name
            ? r.name
            : typeof r.display_name === "string"
              ? r.display_name
              : "",
      }));
      const columns = CONNECTOR_LIST_COLUMNS;
      if (args.flat || !categories?.length) {
        emitList(!!args.json, columns, rows);
      } else {
        emitGroupedList(!!args.json, columns, rows, categories);
      }
      if (!args.json) {
        const blocks =
          !args.flat && categories?.length
            ? ` · ${categories.length} categor${categories.length === 1 ? "y" : "ies"}`
            : "";
        process.stdout.write(
          items.length < total
            ? `${pc.dim(`showing ${items.length} of ${total} connectors${blocks} — raise --limit to see all`)}\n`
            : `${pc.dim(`${total} connector${total === 1 ? "" : "s"} total${blocks}`)}\n`,
        );
      }
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a connector by id" },
  args: {
    id: { type: "positional", required: false, description: "Connector id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const id = await pickId({
        label: "connector id",
        argValue: args.id,
        fetch: () => fetchConnectorRows(client),
      });
      printJson(await client.getConnector(id));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

export function probeWarnings(value: unknown): Array<{ code: string; message: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    entry &&
    typeof entry === "object" &&
    typeof (entry as { code?: unknown }).code === "string" &&
    typeof (entry as { message?: unknown }).message === "string"
      ? [entry as { code: string; message: string }]
      : [],
  );
}

export function renderProbeOutcome(
  result: Record<string, unknown> & { ok?: unknown },
  jsonMode: boolean,
): boolean {
  if (jsonMode) {
    printJson(result);
    return result.ok === true;
  }
  const ok = result.ok === true;
  process.stdout.write(`ok: ${ok}\n`);
  if (!ok) {
    const code = typeof result.error_code === "string" ? result.error_code : null;
    const detail = typeof result.detail === "string" ? result.detail : null;
    if (code) process.stdout.write(`${pc.dim("reason:")} ${code}\n`);
    if (detail) process.stdout.write(`${pc.dim("detail:")} ${detail}\n`);
    if (typeof result.provider_action_url === "string") {
      process.stdout.write(`${pc.dim("fix:")} ${result.provider_action_url}\n`);
    }
  }
  for (const warning of probeWarnings(result.warnings)) {
    process.stdout.write(`${pc.yellow("warning:")} ${warning.message} (${warning.code})\n`);
  }
  return ok;
}

async function readDefinitionFile(path: string): Promise<Record<string, unknown>> {
  const { readFileSync } = await import("node:fs");
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

async function saveConnectorFromFile(
  target: { action: "create" } | { action: "patch"; id: string },
  args: Record<string, unknown>,
): Promise<void> {
  const client = makeClient();
  const jsonMode = Boolean(args.json);
  try {
    const file = await readDefinitionFile(String(args.file));
    const current =
      target.action === "patch"
        ? unwrapConnectorRecord(await client.getConnector(target.id))
        : undefined;
    const body = current ? connectorPatchBody(current, file) : file;
    const skip = Boolean(args["skip-checks"]);
    const name =
      typeof body.name === "string"
        ? body.name
        : current
          ? connectorDisplayName(current)
          : undefined;
    await renderIntent(
      {
        kind: "connector",
        action: target.action === "patch" ? "Update" : "Create",
        ...(name ? { name } : {}),
        ...(typeof body.template_slug === "string" ? { template_slug: body.template_slug } : {}),
      },
      { jsonMode },
    );

    let probe: ConnectorSummary["probe"];
    if (!skip) {
      const verdict = await client.validateConnectorDraft(
        current ? connectorPatchDraft(current, body) : body,
      );
      if (!verdict.ok) {
        await renderTaskList(
          [
            {
              id: "validate",
              label: "Validate",
              status: "failed",
              detail: verdict.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
            },
            { id: "probe", label: "Probe", status: "pending" },
            { id: "save", label: "Save", status: "pending" },
          ],
          { jsonMode },
        );
        process.exit(1);
      }

      if (target.action === "create" && body.driver === "mcp") {
        await renderTaskList(
          [
            { id: "validate", label: "Validate", status: "succeeded" },
            {
              id: "probe",
              label: "Probe",
              status: "warning",
              detail:
                "skipped — an mcp connector is probed after it is saved: `sk connectors probe <id>`",
            },
            { id: "save", label: "Save", status: "pending" },
          ],
          { jsonMode },
        );
      } else if (target.action === "create") {
        const credential = args.credential
          ? await readDefinitionFile(String(args.credential))
          : undefined;
        const result = await client.probeConnectorDraft({
          connector: body,
          ...(credential ? { credential } : {}),
        });
        probe = { ok: Boolean(result.ok) };
        if (!result.ok) {
          await renderTaskList(
            [
              { id: "validate", label: "Validate", status: "succeeded" },
              {
                id: "probe",
                label: "Probe",
                status: "failed",
                detail: typeof result.detail === "string" ? result.detail : "probe returned not-ok",
              },
              { id: "save", label: "Save", status: "pending" },
            ],
            { jsonMode },
          );
          process.exit(64);
        }
      }
    } else if (!jsonMode) {
      process.stderr.write(
        `${pc.yellow("warning:")} --skip-checks active; no validate or probe was run\n`,
      );
    }

    const saved = (
      target.action === "create"
        ? await client.createConnector(body)
        : await client.patchConnector(target.id, body)
    ) as Record<string, unknown> & { id?: string; slug?: string };
    printJson(saved);

    await renderSummary(
      {
        kind: "connector",
        action: target.action === "patch" ? "Updated" : "Created",
        id: typeof saved.id === "string" ? saved.id : "(unknown)",
        slug: typeof saved.slug === "string" ? saved.slug : "(unknown)",
        ...(typeof saved.template_slug === "string" ? { template_slug: saved.template_slug } : {}),
        ...(probe ? { probe } : {}),
      },
      { jsonMode },
    );

    if (!jsonMode && typeof saved.id === "string") {
      const authType = typeof saved.auth_type === "string" ? saved.auth_type : "";
      const next = authType.startsWith("oauth")
        ? `sk auth --connector-id ${saved.id}`
        : `sk connectors get ${saved.id}`;
      process.stderr.write(`\n${pc.dim("Next:")} ${next}\n`);
    }
  } catch (err) {
    reportCommandError(err, { json: jsonMode });
  }
}

const createCommand = defineCommand({
  meta: {
    name: "create",
    description:
      "Create a connector from a template slug (--template) or a definition file (--file). --file runs validate and probe against the unsaved definition first, so a broken connector is never created; pass --skip-checks to bypass.",
  },
  args: {
    template: { type: "string", description: "Template slug" },
    file: { type: "string", description: "Path to a connector definition JSON file" },
    credential: {
      type: "string",
      description:
        "Path to a credential JSON file used to sign the pre-save probe. Never stored — attach the credential with `sk credentials set` after create.",
    },
    name: { type: "string", description: "Override connector name (--template only)" },
    "skip-checks": {
      type: "boolean",
      description: "Skip the checks (NOT recommended).",
    },
    json: { type: "boolean", description: "JSON-only output (suppresses narration)" },
  },
  async run({ args }) {
    if (args.file && args.template) {
      process.stderr.write("error: pass either --template or --file, not both\n");
      process.exit(1);
    }
    if (args.file) return saveConnectorFromFile({ action: "create" }, args);
    if (!args.template) {
      process.stderr.write("error: --template or --file is required\n");
      process.exit(1);
    }

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

      if (!jsonMode && typeof created.id === "string") {
        const authType = typeof created.auth_type === "string" ? created.auth_type : "";
        const next = authType.startsWith("oauth")
          ? `sk auth --connector-id ${created.id}`
          : `sk "create a workflow using ${typeof created.slug === "string" ? created.slug : args.template}"`;
        process.stderr.write(`\n${pc.dim("Next:")} ${next}\n`);
      }
    } catch (err) {
      reportCommandError(err, { json: jsonMode });
    }
  },
});

const probeCommand = defineCommand({
  meta: {
    name: "probe",
    description:
      "Probe a connector's upstream boundary. With an id, probes the saved connector (alias of `test`); with --file, probes an unsaved definition and saves nothing.",
  },
  args: {
    id: { type: "positional", required: false, description: "Connector id" },
    file: {
      type: "string",
      description: "Path to a connector definition JSON file — probes it without saving it",
    },
    credential: {
      type: "string",
      description:
        "Path to a credential JSON file. Signs this probe only; never stored. Required when the definition's auth_type is not 'none'.",
    },
    json: { type: "boolean", description: "JSON-only output" },
  },
  async run({ args }) {
    const client = makeClient();
    const jsonMode = Boolean(args.json);
    try {
      if (args.file) {
        const connector = await readDefinitionFile(String(args.file));
        const credential = args.credential
          ? await readDefinitionFile(String(args.credential))
          : undefined;
        const result = await client.probeConnectorDraft({
          connector,
          ...(credential ? { credential } : {}),
        });
        printJson(result);
        if (!result.ok) process.exit(1);
        return;
      }

      const id = await pickId({
        label: "connector id",
        argValue: args.id,
        fetch: () => fetchConnectorRows(client),
      });
      const result = await client.testConnector(id);
      if (!renderProbeOutcome(result, jsonMode)) process.exit(1);
    } catch (err) {
      reportCommandError(err, { json: jsonMode });
    }
  },
});

const validateCommand = defineCommand({
  meta: {
    name: "validate",
    description:
      "Check a connector definition file against its driver's config schema. Saves nothing, reaches no upstream.",
  },
  args: {
    file: { type: "positional", required: true, description: "Path to a definition JSON file" },
    json: { type: "boolean", description: "JSON-only output" },
  },
  async run({ args }) {
    const client = makeClient();
    const jsonMode = Boolean(args.json);
    try {
      const verdict = await client.validateConnectorDraft(
        await readDefinitionFile(String(args.file)),
      );
      if (jsonMode) {
        printJson(verdict);
      } else if (verdict.ok) {
        process.stdout.write(`${pc.green("ok")}  connector definition validates cleanly\n`);
      } else {
        for (const issue of verdict.issues) {
          process.stderr.write(`  ${issue.path}  ${issue.message}\n`);
        }
      }
      if (!verdict.ok) process.exit(1);
    } catch (err) {
      reportCommandError(err, { json: jsonMode });
    }
  },
});

const importCommand = defineCommand({
  meta: {
    name: "import",
    description:
      "Turn an API specification into a connector. Parses the spec, shows the draft it produced, then creates it after confirmation (--yes to skip). Nothing is saved until you agree.",
  },
  args: {
    spec: {
      type: "string",
      required: true,
      description: "Path to the specification file, or a URL / curl command (see --source)",
    },
    source: {
      type: "string",
      required: true,
      description:
        "openapi | google_discovery | postman | har | graphql | graphql_introspection | curl",
    },
    name: { type: "string", description: "Override the connector name" },
    environment: { type: "string", description: "dev (default) or prod" },
    yes: { type: "boolean", description: "Create without asking (for non-interactive use)" },
    "dry-run": {
      type: "boolean",
      description: "Print the draft and stop. Nothing is created.",
    },
    json: { type: "boolean", description: "JSON-only output" },
  },
  async run({ args }) {
    const client = makeClient();
    const jsonMode = Boolean(args.json);
    try {
      const specArg = String(args.spec);
      let content = specArg;
      try {
        const { existsSync, readFileSync } = await import("node:fs");
        if (existsSync(specArg)) content = readFileSync(specArg, "utf8");
      } catch {}

      const imported = await client.importConnectorFromSpec({
        source: String(args.source),
        content,
        ...(args.name ? { name: args.name } : {}),
        ...(args.environment ? { environment: String(args.environment) } : {}),
      });

      const draft = imported.draft;
      if (!draft) {
        printJson(imported);
        return;
      }

      printJson(draft);
      if (args["dry-run"]) return;

      if (!args.yes) {
        if (!process.stdin.isTTY) {
          process.stderr.write(
            "error: refusing to create without confirmation — re-run with --yes, or --dry-run to inspect the draft\n",
          );
          process.exit(1);
        }
        const proceed = await prompts.confirm({ message: "Create this connector?" });
        if (prompts.isCancel(proceed) || !proceed) {
          process.stderr.write("cancelled; nothing was created\n");
          return;
        }
      }

      const created = (await client.createConnector(draft)) as Record<string, unknown> & {
        id?: string;
      };
      printJson(created);
      if (!jsonMode && typeof created.id === "string") {
        process.stderr.write(
          `\n${pc.dim("Next:")} sk credentials set --connector-id ${created.id} --mode <mode>\n`,
        );
      }
    } catch (err) {
      reportCommandError(err, { json: jsonMode });
    }
  },
});

const inspectCommand = defineCommand({
  meta: {
    name: "inspect",
    description: "Inspect a connector resource (alias of `get`).",
  },
  args: {
    id: { type: "positional", required: false, description: "Connector id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const id = await pickId({
        label: "connector id",
        argValue: args.id,
        fetch: () => fetchConnectorRows(client),
      });
      printJson(await client.getConnector(id));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const enableCommand = defineCommand({
  meta: { name: "enable", description: "Enable a connector (operator on switch)" },
  args: {
    id: { type: "positional", required: false, description: "Connector id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const id = await pickId({
        label: "connector id",
        argValue: args.id,
        fetch: () => fetchConnectorRows(client),
      });
      printJson(await client.enableConnector(id));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const disableCommand = defineCommand({
  meta: {
    name: "disable",
    description:
      "Disable a connector. It keeps its configuration and credentials and stops being offered for use.",
  },
  args: {
    id: { type: "positional", required: false, description: "Connector id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const id = await pickId({
        label: "connector id",
        argValue: args.id,
        fetch: () => fetchConnectorRows(client),
      });
      printJson(await client.disableConnector(id));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const mcpInspectCommand = defineCommand({
  meta: {
    name: "mcp-inspect",
    description:
      "mcp driver: force one handshake and list the tools, capabilities and instructions the remote actually serves.",
  },
  args: {
    id: { type: "positional", required: false, description: "Connector id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const id = await pickId({
        label: "connector id",
        argValue: args.id,
        fetch: () => fetchConnectorRows(client),
      });
      printJson(await client.inspectMcpConnector(id));
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const mcpAuthorizeCommand = defineCommand({
  meta: {
    name: "mcp-authorize",
    description:
      "mcp driver: begin the interactive OAuth 2.1 flow and print the URL to open in a browser.",
  },
  args: {
    id: { type: "positional", required: false, description: "Connector id" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const id = await pickId({
        label: "connector id",
        argValue: args.id,
        fetch: () => fetchConnectorRows(client),
      });
      const res = await client.authorizeMcpConnector(id);
      process.stdout.write(`open this URL to grant access:\n${res.authorization_url}\n`);
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const patchCommand = defineCommand({
  meta: {
    name: "patch",
    description:
      "Update a connector, from --file (a partial definition: only the fields it names change) or from --name, --description and --category. --file runs validate first.",
  },
  args: {
    id: { type: "positional", required: true, description: "Connector id" },
    file: { type: "string", description: "Path to a partial definition JSON file" },
    name: { type: "string", description: "New name" },
    ...catalogMetadataArgs,
    "skip-checks": { type: "boolean", description: "Skip validation (NOT recommended)." },
    json: { type: "boolean", description: "JSON-only output (suppresses narration)" },
  },
  async run({ args }) {
    if (args.file) return saveConnectorFromFile({ action: "patch", id: args.id }, args);
    const client = makeClient();
    const jsonMode = Boolean(args.json);
    try {
      const body: Record<string, unknown> = { ...catalogMetadataBody(args) };
      if (args.name) body.name = args.name;
      printJson(await client.patchConnector(args.id, body));
    } catch (err) {
      reportCommandError(err, { json: jsonMode });
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a connector" },
  args: {
    id: { type: "positional", required: false, description: "Connector id" },
    yes: { type: "boolean", description: "Skip confirmation" },
  },
  async run({ args }) {
    const client = makeClient();
    try {
      const id = await pickId({
        label: "connector id",
        argValue: args.id,
        fetch: () => fetchConnectorRows(client),
      });
      if (!args.yes) {
        const confirmed = await prompts.confirm({ message: `Delete connector "${id}"?` });
        if (!confirmed || prompts.isCancel(confirmed)) return;
      }
      await client.deleteConnector(id);
      process.stdout.write("deleted\n");
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const promoteCommand = defineCommand({
  meta: {
    name: "promote",
    description: "Promote a connector and its credentials from DEV to PROD",
  },
  args: {
    id: { type: "positional", required: false, description: "DEV connector id" },
    to: { type: "string", default: "prod", description: "Target environment (prod only)" },
    strategy: {
      type: "string",
      default: "copy",
      description: "Promotion strategy: copy or move",
    },
    "idempotency-key": {
      type: "string",
      description: "Stable retry key; generated when omitted",
    },
    yes: { type: "boolean", description: "Confirm a move without prompting" },
    json: { type: "boolean", description: "JSON output" },
  },
  async run({ args }) {
    const client = makeClient();
    const jsonMode = Boolean(args.json);
    try {
      const id = await pickId({
        label: "DEV connector id",
        argValue: args.id,
        fetch: () => fetchConnectorRows(client),
      });
      if (args.to !== "prod") throw new Error("--to must be prod");
      if (args.strategy !== "copy" && args.strategy !== "move") {
        throw new Error("--strategy must be copy or move");
      }
      if (args.strategy === "move" && !args.yes) {
        const confirmed = await prompts.confirm({
          message: `Move connector "${id}" from DEV to PROD? The DEV connector will not remain.`,
        });
        if (!confirmed || prompts.isCancel(confirmed)) return;
      }
      const idempotencyKey = args["idempotency-key"] ?? `sk-promote-${crypto.randomUUID()}`;
      const result = await client.promoteConnector(
        id,
        { target_environment: "prod", strategy: args.strategy },
        idempotencyKey,
      );
      if (jsonMode) {
        printJson({ idempotency_key: idempotencyKey, ...result });
      } else {
        process.stderr.write(`${pc.dim("Idempotency-Key:")} ${idempotencyKey}\n`);
        printJson(result);
      }
    } catch (err) {
      reportCommandError(err, { json: jsonMode });
    }
  },
});

const testCommand = defineCommand({
  meta: {
    name: "test",
    description:
      "Test a connector connection (alias of `probe`). Exits non-zero when the probe fails.",
  },
  args: {
    id: { type: "positional", required: false, description: "Connector id" },
    json: { type: "boolean", description: "JSON-only output" },
  },
  async run({ args }) {
    const client = makeClient();
    const jsonMode = Boolean(args.json);
    try {
      const id = await pickId({
        label: "connector id",
        argValue: args.id,
        fetch: () => fetchConnectorRows(client),
      });
      const result = await client.testConnector(id);
      if (!renderProbeOutcome(result, jsonMode)) process.exit(1);
    } catch (err) {
      reportCommandError(err, { json: jsonMode });
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
      reportCommandError(err);
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
      reportCommandError(err, { json: Boolean(args.json) });
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
      reportCommandError(err);
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
      reportCommandError(err);
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
    import: importCommand,
    validate: validateCommand,
    patch: patchCommand,
    enable: enableCommand,
    disable: disableCommand,
    "mcp-inspect": mcpInspectCommand,
    "mcp-authorize": mcpAuthorizeCommand,
    delete: deleteCommand,
    promote: promoteCommand,
    test: testCommand,
    probe: probeCommand,
    "docs-ingest": docsIngestCommand,
    "docs-list": docsListCommand,
    "docs-search": docsSearchCommand,
    "docs-delete": docsDeleteCommand,
  },
});
