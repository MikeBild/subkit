import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";

import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";
import { detectMime } from "../utils/mime.ts";
import { uploadPath } from "./files.ts";

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
      reportCommandError(err, { json: Boolean(args.json) });
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
      reportCommandError(err);
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
      reportCommandError(err, { json: Boolean(args.json) });
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
      reportCommandError(err);
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
      reportCommandError(err);
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
      // First register each file in the unified `files` table so the
      // discovery run carries a dedup-able audit trail. The legacy
      // multipart route is still the persistence path until the
      // engine accepts file_ids directly — the file rows + links
      // ensure every CLI surface funnels through `uploadInline` /
      // `batchCreateFiles` (the upload-paths-parity guarantee).
      const fileRows = await Promise.all(paths.map((p) => uploadPath(client, p, { quiet: true })));
      const files = paths.map((p: string) => ({
        name: basename(p),
        content: readFileSync(p),
        mime_type: detectMime(p),
      }));
      const run = (await client.createDiscoveryRun(files, args.label)) as Record<string, unknown>;
      const runId = typeof run.id === "string" ? run.id : null;
      if (runId) {
        for (const f of fileRows) {
          try {
            await client.linkFile(f.id, {
              resource_type: "discovery_run",
              resource_id: runId,
            });
          } catch {
            /* best-effort — the run already owns its bytes */
          }
        }
      }
      printJson(run);
    } catch (err) {
      reportCommandError(err);
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
