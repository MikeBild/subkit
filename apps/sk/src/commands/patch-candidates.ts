import { reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

const listCommand = defineCommand({
  meta: { name: "list", description: "List patch candidates" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const { items } = await client.listPatchCandidates({ limit: Number(args.limit) });
      emitList(
        !!args.json,
        ["id", "workflow_id", "summary", "status", "created_at"],
        items as Record<string, unknown>[],
      );
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Get a patch candidate by id" },
  args: {
    id: { type: "positional", required: true, description: "Patch candidate id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const candidate = await client.getPatchCandidate(args.id);
      printJson(candidate);
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const previewCommand = defineCommand({
  meta: { name: "preview", description: "Review the exact repair diff and approval digest" },
  args: { id: { type: "positional", required: true, description: "Patch candidate id" } },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      printJson(
        await client.request("GET", `/v1/patch-candidates/${encodeURIComponent(args.id)}/preview`),
      );
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const approveCommand = defineCommand({
  meta: { name: "approve", description: "Approve a patch candidate" },
  args: {
    id: { type: "positional", required: true, description: "Patch candidate id" },
    "review-digest": {
      type: "string",
      required: true,
      description: "Digest from the reviewed candidate preview",
    },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      await client.approvePatchCandidate(args.id, args["review-digest"]);
      process.stdout.write(`${pc.green("approved")}\n`);
    } catch (err) {
      reportCommandError(err);
    }
  },
});

const rejectCommand = defineCommand({
  meta: { name: "reject", description: "Reject a patch candidate" },
  args: {
    id: { type: "positional", required: true, description: "Patch candidate id" },
    reason: { type: "string", description: "Rejection reason" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const body: { reason?: string } = {};
      if (args.reason) body.reason = args.reason;
      await client.rejectPatchCandidate(args.id, body);
      process.stdout.write(`${pc.green("rejected")}\n`);
    } catch (err) {
      reportCommandError(err);
    }
  },
});

export const patchCandidatesCommand = defineCommand({
  meta: { name: "patch-candidates", description: "Manage patch candidates" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    preview: previewCommand,
    approve: approveCommand,
    reject: rejectCommand,
  },
});
