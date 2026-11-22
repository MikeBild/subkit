import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import type {
  SelfHealingScanListQuery,
  SelfHealingScanRequest,
} from "../engine-client/self-healing.ts";
import { EngineClient } from "../engine-client.ts";
import { withCommandErrors } from "./command-runtime.ts";

const SCAN_STATUSES = ["running", "succeeded", "failed"] as const satisfies readonly NonNullable<
  SelfHealingScanListQuery["status"]
>[];
const SCAN_SOURCES = ["scheduler", "admin_http", "mcp"] as const satisfies readonly NonNullable<
  SelfHealingScanListQuery["source"]
>[];

function oneOf<T extends string>(flag: string, allowed: readonly T[], value: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (!match) throw new Error(`--${flag} must be one of ${allowed.join(", ")}`);
  return match;
}

export function scanListQuery(args: {
  limit: string;
  status?: string | undefined;
  source?: string | undefined;
}): SelfHealingScanListQuery {
  const query: SelfHealingScanListQuery = { limit: Number(args.limit) };
  if (args.status) query.status = oneOf("status", SCAN_STATUSES, String(args.status));
  if (args.source) query.source = oneOf("source", SCAN_SOURCES, String(args.source));
  return query;
}

const scanCommand = defineCommand({
  meta: {
    name: "scan",
    description: "Trigger a proactive self-healing drift scan",
  },
  args: {
    workflow: { type: "string", description: "Scope validation-drift to this workflow id" },
    connector: { type: "string", description: "Scope schema-drift to this connector id" },
    "idempotency-key": {
      type: "string",
      description:
        "Replay-safe key; a second call within 24h with the same key returns the original result",
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const body: SelfHealingScanRequest = {};
        if (args.workflow) body.workflow_id = String(args.workflow);
        if (args.connector) body.connector_id = String(args.connector);
        const opts: { idempotencyKey?: string } = {};
        const key = args["idempotency-key"];
        if (typeof key === "string" && key.length > 0) opts.idempotencyKey = key;
        const result = await client.triggerSelfHealingScan(body, opts);
        if (args.json) {
          printJson(result);
          return;
        }
        const scanId = result.scan_id ?? "";
        const signals = result.signals_detected ?? 0;
        const candidates = result.candidates_created ?? 0;
        const unanchored = result.unanchored_detected ?? 0;
        const duration = result.duration_ms ?? 0;
        const replay = result.idempotent_replay === true;
        const unanchoredFragment =
          unanchored > 0 ? `, ${pc.yellow(`${unanchored} unanchored`)}` : "";
        process.stdout.write(
          `${pc.green("scan")} ${scanId} — ${signals} signal(s), ${candidates} candidate(s)${unanchoredFragment}, ${duration}ms${
            replay ? pc.yellow(" (idempotent replay)") : ""
          }\n`,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

const listCommand = defineCommand({
  meta: { name: "list", description: "List proactive drift scans" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    status: { type: "string", description: "Filter by status (running/succeeded/failed)" },
    source: { type: "string", description: "Filter by source (scheduler/admin_http/mcp)" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const { items } = await client.listSelfHealingScans(scanListQuery(args));
        emitList(
          !!args.json,
          [
            "id",
            "source",
            "status",
            "signals_detected",
            "candidates_created",
            "unanchored_detected",
            "created_at",
          ],
          items,
        );
      },
      { json: Boolean(args.json) },
    );
  },
});

const showCommand = defineCommand({
  meta: { name: "show", description: "Show a proactive drift scan by id" },
  args: {
    id: { type: "positional", required: true, description: "Scan id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(async () => {
      const scan = await client.getSelfHealingScan(args.id);
      printJson(scan);
    });
  },
});

export const selfHealingCommand = defineCommand({
  meta: {
    name: "self-healing",
    description: "Trigger and review proactive drift scans (admin)",
  },
  subCommands: {
    scan: scanCommand,
    list: listCommand,
    show: showCommand,
  },
});
