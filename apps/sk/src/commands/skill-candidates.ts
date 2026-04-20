import { exitCodeFor } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

const listCommand = defineCommand({
  meta: { name: "list", description: "List skill candidates" },
  args: {
    limit: { type: "string", description: "Max rows", default: "20" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const { items } = await client.listSkillCandidates({ limit: Number(args.limit) });
      emitList(
        !!args.json,
        ["id", "title", "source", "status", "created_at"],
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
  meta: { name: "get", description: "Get a skill candidate by id" },
  args: {
    id: { type: "positional", required: true, description: "Candidate id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const candidate = await client.getSkillCandidate(args.id);
      printJson(candidate);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

const approveCommand = defineCommand({
  meta: { name: "approve", description: "Approve a skill candidate" },
  args: {
    id: { type: "positional", required: true, description: "Candidate id" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      await client.approveSkillCandidate(args.id);
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
  meta: { name: "reject", description: "Reject a skill candidate" },
  args: {
    id: { type: "positional", required: true, description: "Candidate id" },
    reason: { type: "string", description: "Rejection reason" },
  },
  async run({ args }) {
    const { engine_url, api_key, active_tenant_id } = resolveProfile();
    const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
    try {
      const body: { reason?: string } = {};
      if (args.reason) body.reason = args.reason;
      await client.rejectSkillCandidate(args.id, body);
      process.stdout.write(`${pc.green("rejected")}\n`);
    } catch (err) {
      process.stderr.write(
        `${pc.red("error")}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(exitCodeFor(err));
    }
  },
});

export const skillCandidatesCommand = defineCommand({
  meta: { name: "skill-candidates", description: "Manage skill candidates" },
  subCommands: {
    list: listCommand,
    get: getCommand,
    approve: approveCommand,
    reject: rejectCommand,
  },
});
