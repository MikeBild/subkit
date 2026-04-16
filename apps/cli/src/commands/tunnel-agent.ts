// `subkit tunnel-agent run` — thin wrapper that forwards to the same
// TunnelAgentClient the standalone `tunnel-agent` binary uses.

import { defineCommand } from "citty";
import { type AgentTargetConfig, TunnelAgentClient } from "../../../agent/src/client.ts";

function parseTargets(raw: string): AgentTargetConfig[] {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.map((entry) => {
    const eq = entry.indexOf("=");
    if (eq < 0) throw new Error(`bad targets entry '${entry}' — expected name=url`);
    const name = entry.slice(0, eq).trim();
    const url = entry.slice(eq + 1).trim();
    if (!name || !url) throw new Error(`bad targets entry '${entry}'`);
    return { name, local_base_url: url };
  });
}

const runCmd = defineCommand({
  meta: { name: "run", description: "Run the tunnel agent in-process" },
  args: {
    "engine-url": { type: "string", required: true },
    "api-key": { type: "string", required: true },
    targets: { type: "string", required: true, description: "name=url,other=url" },
  },
  async run({ args }) {
    const targets = parseTargets(args.targets as string);
    const client = new TunnelAgentClient({
      engine_url: args["engine-url"] as string,
      api_key: args["api-key"] as string,
      targets,
      agent_version: "0.0.1",
    });
    const shutdown = () => {
      client.stop();
      setTimeout(() => process.exit(0), 250).unref?.();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    await client.start();
    process.stdout.write(`tunnel-agent registered for ${targets.map((t) => t.name).join(",")}\n`);
    await new Promise<void>(() => {});
  },
});

export const tunnelAgentCommand = defineCommand({
  meta: { name: "tunnel-agent", description: "Run the tunnel agent" },
  subCommands: { run: runCmd },
});
