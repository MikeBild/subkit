// subkit-tunnel-agent — entrypoint for the compiled tunnel agent binary.
//
// Usage:
//   subkit-tunnel-agent \
//     --engine-url wss://engine.example.com \
//     --api-key wf_live_abc \
//     --targets name=http://localhost:3000/,other=http://localhost:9090/
//
// Env fallback:
//   SUBKIT_ENGINE_URL, SUBKIT_API_KEY, SUBKIT_TARGETS
//
// The binary is produced by `bun build --compile` — see package.json:
//   "build:agent": "bun build apps/agent/src/index.ts --compile --outfile dist/tunnel-agent"

import { VERSION } from "@cli-core/version.ts";
import { type AgentTargetConfig, TunnelAgentClient } from "./client.ts";
import { log } from "./logger.ts";

interface ParsedArgs {
  engine_url: string;
  api_key: string;
  targets: AgentTargetConfig[];
}

function parseTargets(raw: string): AgentTargetConfig[] {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.map((entry) => {
    const eq = entry.indexOf("=");
    if (eq < 0) {
      throw new Error(`bad --targets entry '${entry}' — expected name=url`);
    }
    const name = entry.slice(0, eq).trim();
    const url = entry.slice(eq + 1).trim();
    if (!name || !url) {
      throw new Error(`bad --targets entry '${entry}' — name and url required`);
    }
    return { name, local_base_url: url };
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = "true";
      }
    }
  }
  const engine_url = flags["engine-url"] ?? process.env.SUBKIT_ENGINE_URL ?? "";
  const api_key = flags["api-key"] ?? process.env.SUBKIT_API_KEY ?? "";
  const rawTargets = flags.targets ?? process.env.SUBKIT_TARGETS ?? "";
  if (!engine_url) throw new Error("missing --engine-url / SUBKIT_ENGINE_URL");
  if (!api_key) throw new Error("missing --api-key / SUBKIT_API_KEY");
  if (!rawTargets) throw new Error("missing --targets / SUBKIT_TARGETS");
  return { engine_url, api_key, targets: parseTargets(rawTargets) };
}

async function main(): Promise<void> {
  // --check-update: check for updates without installing, exit.
  if (process.argv.includes("--check-update")) {
    const { checkForUpdate, defaultUpdaterConfig } = await import("@cli-core/updater.ts");
    const info = await checkForUpdate(defaultUpdaterConfig("tunnel-agent", VERSION), true);
    if (info) {
      log.info("update available", { current: VERSION, latest: info.version });
      process.exit(0);
    }
    log.info("already at latest version", { version: VERSION });
    process.exit(0);
  }

  // --self-update: download newer binary, replace, exit.
  // Checked before parseArgs since it doesn't need --engine-url etc.
  if (process.argv.includes("--self-update")) {
    const { runAgentSelfUpdate } = await import("./update.ts");
    try {
      await runAgentSelfUpdate();
      process.exit(0);
    } catch (err) {
      log.error("update failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    log.error("invalid invocation", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(2);
  }

  // Non-blocking startup update check
  if (process.env.NO_UPDATE_CHECK !== "1") {
    import("./update.ts")
      .then((m) => m.checkAndLogUpdate())
      .catch(() => {
        /* silent */
      });
  }

  log.info("tunnel agent starting", {
    engine_url: parsed.engine_url,
    targets: parsed.targets.map((t) => t.name),
  });

  const client = new TunnelAgentClient({
    engine_url: parsed.engine_url,
    api_key: parsed.api_key,
    targets: parsed.targets,
    agent_version: VERSION,
  });
  const shutdown = (signal: string): void => {
    log.info("shutdown", { signal });
    client.stop();
    setTimeout(() => process.exit(0), 250).unref?.();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  await client.start();
  log.info("tunnel agent registered");

  // Start periodic 24h update check after successful registration
  if (process.env.NO_UPDATE_CHECK !== "1") {
    const { startPeriodicUpdateCheck } = await import("./update.ts");
    startPeriodicUpdateCheck();
  }

  await new Promise<void>(() => {});
}

main().catch((err) => {
  log.error("tunnel agent crashed", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
