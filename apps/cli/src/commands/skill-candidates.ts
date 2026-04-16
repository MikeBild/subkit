// `subkit skill-candidates ...`

import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

const listCmd = defineCommand({
  meta: { name: "list", description: "List skill improvement suggestions" },
  args: {
    ...clientArgs,
    status: { type: "string", description: "Filter: proposed|approved|rejected|superseded" },
    confidence: { type: "string", description: "Filter: low|medium|high" },
    scope: { type: "string", description: "Filter: global|connector|workflow" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.listSkillCandidates({
      status: args.status as string | undefined,
      confidence: args.confidence as string | undefined,
      scope: args.scope as string | undefined,
    });
    emitList(
      asJson,
      ["id", "title", "pattern_kind", "confidence", "status", "evidence_count"],
      body.items as unknown as Record<string, unknown>[],
    );
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Fetch a skill candidate" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Candidate id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const c = await client.getSkillCandidate(args.id as string);
    emitOne(asJson, c as unknown as Record<string, unknown>);
  },
});

const approveCmd = defineCommand({
  meta: { name: "approve", description: "Approve a candidate and promote to skill" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Candidate id", required: true },
    title: { type: "string", description: "Override skill title" },
    status: { type: "string", description: "Skill status: draft (default) or active" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body: Record<string, unknown> = {};
    if (args.title) body.title = args.title;
    if (args.status) body.status = args.status;
    const result = await client.approveSkillCandidate(args.id as string, body);
    emitOne(asJson, result as unknown as Record<string, unknown>);
  },
});

const rejectCmd = defineCommand({
  meta: { name: "reject", description: "Reject a skill candidate" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Candidate id", required: true },
    reason: { type: "string", description: "Rejection reason" },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    const body: Record<string, unknown> = {};
    if (args.reason) body.reason = args.reason;
    await client.rejectSkillCandidate(args.id as string, body as { reason?: string });
    process.stdout.write("rejected\n");
  },
});

export const skillCandidatesCommand = defineCommand({
  meta: { name: "skill-candidates", description: "Skill improvement suggestions" },
  subCommands: {
    list: listCmd,
    get: getCmd,
    approve: approveCmd,
    reject: rejectCmd,
  },
});
