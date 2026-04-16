// `subkit discovery ...`

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitList, emitOne } from "../utils/format.ts";

const runCmd = defineCommand({
  meta: { name: "run", description: "Analyze files for systems, rules, and knowledge" },
  args: {
    ...clientArgs,
    files: { type: "string", description: "File paths (comma-separated or glob)", required: true },
    label: { type: "string", description: "Run label" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const rawPaths = (args.files as string).split(",").map((s) => s.trim());

    // Expand paths (simple — no glob, just file/directory)
    const filePaths: string[] = [];
    for (const p of rawPaths) {
      const resolved = resolve(p);
      try {
        const st = statSync(resolved);
        if (st.isDirectory()) {
          const entries = readdirSync(resolved);
          for (const e of entries) {
            const ep = resolve(resolved, e);
            if (statSync(ep).isFile()) filePaths.push(ep);
          }
        } else {
          filePaths.push(resolved);
        }
      } catch {
        process.stderr.write(`warning: skipping ${p} (not found)\n`);
      }
    }

    if (filePaths.length === 0) {
      process.stderr.write("error: no files found\n");
      process.exit(1);
    }

    const files = filePaths.map((fp) => ({
      name: basename(fp),
      content: readFileSync(fp),
    }));

    const result = await client.createDiscoveryRun(
      files,
      args.label as string | undefined,
    );
    emitOne(asJson, result as unknown as Record<string, unknown>);
  },
});

const listCmd = defineCommand({
  meta: { name: "list", description: "List discovery runs" },
  args: {
    ...clientArgs,
    status: { type: "string", description: "Filter: pending|analyzing|completed|failed" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.listDiscoveryRuns({
      status: args.status as string | undefined,
    });
    emitList(
      asJson,
      ["id", "status", "label", "file_count", "artifact_count", "created_at"],
      body.items as unknown as Record<string, unknown>[],
    );
  },
});

const getCmd = defineCommand({
  meta: { name: "get", description: "Get a discovery run" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Run id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const r = await client.getDiscoveryRun(args.id as string);
    emitOne(asJson, r as unknown as Record<string, unknown>);
  },
});

const artifactsCmd = defineCommand({
  meta: { name: "artifacts", description: "List artifacts for a discovery run" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Run id", required: true },
    kind: { type: "string", description: "Filter: connector|skill|knowledge_source" },
    status: { type: "string", description: "Filter: proposed|approved|rejected" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const body = await client.listDiscoveryArtifacts(args.id as string, {
      kind: args.kind as string | undefined,
      status: args.status as string | undefined,
    });
    emitList(
      asJson,
      ["id", "kind", "status", "title", "confidence"],
      body.items as unknown as Record<string, unknown>[],
    );
  },
});

const approveCmd = defineCommand({
  meta: { name: "approve", description: "Approve a discovery artifact" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Artifact id", required: true },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    const result = await client.approveDiscoveryArtifact(args.id as string);
    emitOne(asJson, result as unknown as Record<string, unknown>);
  },
});

const rejectCmd = defineCommand({
  meta: { name: "reject", description: "Reject a discovery artifact" },
  args: {
    ...clientArgs,
    id: { type: "positional", description: "Artifact id", required: true },
    reason: { type: "string", description: "Rejection reason" },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    const body: Record<string, unknown> = {};
    if (args.reason) body.reason = args.reason;
    await client.rejectDiscoveryArtifact(args.id as string, body as { reason?: string });
    process.stdout.write("rejected\n");
  },
});

export const discoveryCommand = defineCommand({
  meta: { name: "discovery", description: "File-driven onboarding and system discovery" },
  subCommands: {
    run: runCmd,
    list: listCmd,
    get: getCmd,
    artifacts: artifactsCmd,
    approve: approveCmd,
    reject: rejectCmd,
  },
});
