import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { PatchCandidatePartialSchema } from "../engine-client/self-healing.ts";
import { EngineClient } from "../engine-client.ts";
import { parseAcceptedOperations } from "../lib/accepted-operations.ts";
import { withCommandErrors } from "./command-runtime.ts";

export const PATCH_CANDIDATE_COLUMNS = [
  "id",
  "workflow_id",
  "workflow_name",
  "classification",
  "status",
  "created_at",
];

const ACCEPT_ARG = {
  type: "string",
  description:
    "Only these changes of the repair, as zero-based numbers separated by commas (for example 0,2). Omit to take the whole repair.",
} as const;

function acceptedFrom(raw: string | undefined): number[] | undefined {
  const parsed = parseAcceptedOperations(raw);
  if (parsed.ok) return parsed.indices;
  process.stderr.write(`${pc.red("error")}: ${parsed.message}\n`);
  process.exit(1);
}

export function partialAcceptanceLines(candidate: unknown): string[] {
  const parsed = PatchCandidatePartialSchema.safeParse(candidate);
  if (!parsed.success) return [];
  const lines: string[] = [];
  const accepted = parsed.data.accepted_operations;
  if (accepted)
    lines.push(`accepted changes: ${accepted.length > 0 ? accepted.join(", ") : "none"}`);
  for (const entry of parsed.data.interaction_log ?? []) {
    const which = entry.accepted_operations?.length
      ? ` (changes ${entry.accepted_operations.join(", ")})`
      : "";
    lines.push(`${entry.at ? `${entry.at} ` : ""}${entry.action}${which}`);
  }
  return lines;
}

const listCommand = defineCommand({
  meta: { name: "list", description: "List patch candidates" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(
      async () => {
        const { items } = await client.listPatchCandidates({ limit: Number(args.limit) });
        emitList(!!args.json, PATCH_CANDIDATE_COLUMNS, items);
      },
      { json: Boolean(args.json) },
    );
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
    return withCommandErrors(async () => {
      const candidate = await client.getPatchCandidate(args.id);
      printJson(candidate);
      for (const line of partialAcceptanceLines(candidate))
        process.stderr.write(`${pc.dim(line)}\n`);
    });
  },
});

const previewCommand = defineCommand({
  meta: { name: "preview", description: "Review the exact repair diff and approval digest" },
  args: { id: { type: "positional", required: true, description: "Patch candidate id" } },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(async () => {
      printJson(await client.previewPatchCandidate(args.id));
    });
  },
});

const dryRunCommand = defineCommand({
  meta: {
    name: "dry-run",
    description: "Test the repair, or only some of its changes, without changing the workflow",
  },
  args: {
    id: { type: "positional", required: true, description: "Patch candidate id" },
    accept: ACCEPT_ARG,
  },
  async run({ args }) {
    const accepted = acceptedFrom(args.accept);
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(async () => {
      printJson(await client.dryRunPatchCandidate(args.id, accepted));
    });
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
    accept: ACCEPT_ARG,
  },
  async run({ args }) {
    const accepted = acceptedFrom(args.accept);
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    return withCommandErrors(async () => {
      await client.approvePatchCandidate(args.id, args["review-digest"], accepted);
      process.stdout.write(`${pc.green("approved")}\n`);
    });
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
    return withCommandErrors(async () => {
      const body: { reason?: string } = {};
      if (args.reason) body.reason = args.reason;
      await client.rejectPatchCandidate(args.id, body);
      process.stdout.write(`${pc.green("rejected")}\n`);
    });
  },
});

export const patchCandidatesCommand = defineCommand({
  meta: { name: "patch-candidates", description: "Manage patch candidates" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    preview: previewCommand,
    "dry-run": dryRunCommand,
    approve: approveCommand,
    reject: rejectCommand,
  },
});
