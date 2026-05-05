// `sk settings` — list, read, write, and interactively configure engine
// settings.
//
// Subcommands map onto /v1/settings, /v1/settings/{path} GET/PUT.
// Secrets come back masked from the engine; the CLI never prints raw
// values.
//
//   sk settings list                       — show every leaf with its
//                                            resolved value
//   sk settings get <path>                 — read one leaf
//   sk settings set <path> <json>          — write one leaf
//   sk settings configure                  — interactive Ink form
//
// Every subcommand accepts `--tenant <id>` to operate on a tenant
// overlay (only `scope: "tenant"` leaves may be written).

import { exitCodeFor } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient, SkEngineError, SkTransportError } from "../engine-client.ts";
import { runSettingsApp } from "../settings-ui/index.ts";

function buildClient(args: Record<string, unknown>): EngineClient {
  const profile = resolveProfile({
    engine_url: args["engine-url"] as string | undefined,
    api_key: args["api-key"] as string | undefined,
    profile: args.profile as string | undefined,
  });
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

function reportError(err: unknown): never {
  if (err instanceof SkEngineError) {
    process.stderr.write(`sk: HTTP ${err.status} ${err.code} — ${err.message}\n`);
  } else if (err instanceof SkTransportError) {
    process.stderr.write(`sk: cannot reach engine — ${err.message}\n`);
  } else {
    process.stderr.write(`sk: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(exitCodeFor(err));
}

const commonArgs = {
  "engine-url": { type: "string" as const, description: "Engine base URL" },
  "api-key": { type: "string" as const, description: "API key" },
  profile: { type: "string" as const, description: "Profile name" },
  tenant: { type: "string" as const, description: "Tenant id (writes a tenant overlay)" },
  json: { type: "boolean" as const, description: "JSON output" },
};

const listCommand = defineCommand({
  meta: { name: "list", description: "List every leaf with its resolved value" },
  args: commonArgs,
  async run({ args }) {
    const client = buildClient(args);
    try {
      const tenantOpt: { tenant?: string } = args.tenant ? { tenant: args.tenant as string } : {};
      const res = await client.listSettings(tenantOpt);
      if (args.json) return printJson(res);
      let section: string | null = null;
      for (const it of res.items) {
        const head = it.path.split(".")[0] ?? "";
        if (head !== section) {
          section = head;
          process.stdout.write(`\n${pc.bold(section)}\n`);
        }
        const flag =
          it.meta.source === "default" ? pc.dim("(default)") : pc.green(`(${it.meta.source})`);
        const secret = it.meta.sensitive ? pc.yellow(" secret") : "";
        const restart = it.meta.requiresRestart ? pc.red(" restart") : "";
        process.stdout.write(
          `  ${pc.cyan(it.path.padEnd(44))} ${String(JSON.stringify(it.value)).slice(0, 48).padEnd(50)} ${flag}${secret}${restart}\n`,
        );
      }
      if (res.diagnostics.pending_restart_keys.length > 0) {
        process.stdout.write(
          `\n${pc.yellow("pending restart:")} ${res.diagnostics.pending_restart_keys.join(", ")}\n`,
        );
      }
      if (res.diagnostics.override_keys.length > 0) {
        process.stdout.write(
          `${pc.dim("active overrides:")} ${res.diagnostics.override_keys.join(", ")}\n`,
        );
      }
    } catch (err) {
      reportError(err);
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Read one leaf by dotted path" },
  args: {
    path: {
      type: "positional" as const,
      required: true,
      description: "Setting path (e.g. llm.api_key)",
    },
    ...commonArgs,
  },
  async run({ args }) {
    const client = buildClient(args);
    try {
      const tenantOpt: { tenant?: string } = args.tenant ? { tenant: args.tenant as string } : {};
      const out = await client.getSetting(args.path as string, tenantOpt);
      if (args.json) return printJson(out);
      process.stdout.write(
        `${pc.cyan(out.path)} ${pc.dim(`(${out.meta.scope}/${out.meta.source})`)}\n`,
      );
      process.stdout.write(`  value:           ${JSON.stringify(out.value)}\n`);
      process.stdout.write(`  kind:            ${out.meta.kind}\n`);
      if (out.meta.sensitive)
        process.stdout.write(`  ${pc.yellow("sensitive — value is masked")}\n`);
      if (out.meta.requiresRestart)
        process.stdout.write(`  ${pc.red("requiresRestart — set with --force in production")}\n`);
      if (out.meta.description)
        process.stdout.write(`  description:     ${out.meta.description}\n`);
    } catch (err) {
      reportError(err);
    }
  },
});

const setCommand = defineCommand({
  meta: {
    name: "set",
    description: "Write one leaf. <value> must be valid JSON ('\"abc\"', 42, true, null).",
  },
  args: {
    path: { type: "positional" as const, required: true, description: "Setting path" },
    value: { type: "positional" as const, required: true, description: "Value as JSON" },
    force: { type: "boolean" as const, description: "Bypass requiresRestart guard in production" },
    ...commonArgs,
  },
  async run({ args }) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args.value as string);
    } catch (err) {
      process.stderr.write(
        `sk: --value must be valid JSON. Did you forget to quote it? (${err instanceof Error ? err.message : String(err)})\n`,
      );
      process.exit(2);
    }
    const client = buildClient(args);
    try {
      const opts: { tenant?: string; force?: boolean } = {};
      if (args.tenant) opts.tenant = args.tenant as string;
      if (args.force) opts.force = true;
      const out = await client.setSetting(args.path as string, parsed, opts);
      if (args.json) return printJson(out);
      process.stdout.write(`${pc.green("✔")} ${pc.cyan(args.path as string)}\n`);
      process.stdout.write(`  value:           ${JSON.stringify(out.value)}\n`);
      if (out.requiresRestart)
        process.stdout.write(
          `  ${pc.red("requiresRestart — restart the engine for this to take effect")}\n`,
        );
    } catch (err) {
      reportError(err);
    }
  },
});

const configureCommand = defineCommand({
  meta: {
    name: "configure",
    description:
      "Interactive Ink form for editing settings (Tab to switch sections, Enter to edit, Esc to exit)",
  },
  args: {
    tab: {
      type: "string" as const,
      description: "Open directly on a section (e.g. llm, auth, observability)",
    },
    ...commonArgs,
  },
  async run({ args }) {
    const client = buildClient(args);
    try {
      const tenant = (args.tenant as string | undefined) ?? undefined;
      const tab = (args.tab as string | undefined) ?? undefined;
      const opts: { client: EngineClient; tenant?: string; initialTab?: string } = { client };
      if (tenant) opts.tenant = tenant;
      if (tab) opts.initialTab = tab;
      const exitCode = await runSettingsApp(opts);
      process.exit(exitCode);
    } catch (err) {
      reportError(err);
    }
  },
});

export const settingsCommand = defineCommand({
  meta: {
    name: "settings",
    description:
      "List, read, write, or interactively configure engine settings (secrets always masked)",
  },
  subCommands: {
    list: listCommand,
    get: getCommand,
    set: setCommand,
    configure: configureCommand,
  },
});
