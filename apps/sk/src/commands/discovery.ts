import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

const MIME_MAP: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function detectMime(filePath: string): string {
  return MIME_MAP[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List discovery runs" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const { items } = await client.listDiscoveryRuns({ limit: Number(args.limit) });
      emitList(
        !!args.json,
        ["id", "label", "status", "created_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a discovery run" },
  args: {
    "run-id": { type: "positional", required: true, description: "Run id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const run = await client.getDiscoveryRun(args["run-id"]);
      printJson(run);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const artifactsCommand = defineCommand({
  meta: { name: "artifacts", description: "List artifacts for a discovery run" },
  args: {
    "run-id": { type: "positional", required: true, description: "Run id" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const { items } = await client.listDiscoveryArtifacts(args["run-id"]);
      emitList(!!args.json, ["id", "kind", "title", "status"], items as Record<string, unknown>[]);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const approveCommand = defineCommand({
  meta: { name: "approve", description: "Approve a discovery artifact" },
  args: {
    "artifact-id": { type: "positional", required: true, description: "Artifact id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      await client.approveDiscoveryArtifact(args["artifact-id"]);
      process.stdout.write(`${pc.green("approved")}\n`);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const rejectCommand = defineCommand({
  meta: { name: "reject", description: "Reject a discovery artifact" },
  args: {
    "artifact-id": { type: "positional", required: true, description: "Artifact id" },
    reason: { type: "string", description: "Rejection reason" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const body: { reason?: string } = {};
      if (args.reason) body.reason = args.reason;
      await client.rejectDiscoveryArtifact(args["artifact-id"], body);
      process.stdout.write(`${pc.green("rejected")}\n`);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const createCommand = defineCommand({
  meta: { name: "create", description: "Start a discovery run from one or more files" },
  args: {
    file: { type: "string", required: true, description: "File path(s), comma-separated" },
    label: { type: "string", description: "Optional label for the run" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const paths = args.file
        .split(",")
        .map((p: string) => p.trim())
        .filter(Boolean);
      const files = paths.map((p: string) => ({
        name: basename(p),
        content: readFileSync(p),
        mime_type: detectMime(p),
      }));
      const run = await client.createDiscoveryRun(files, args.label);
      printJson(run);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

export const discoveryCommand = defineCommand({
  meta: { name: "discovery", description: "Manage discovery runs and artifacts" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    artifacts: artifactsCommand,
    approve: approveCommand,
    reject: rejectCommand,
    create: createCommand,
  },
});
