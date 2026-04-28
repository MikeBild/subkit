// `sk settings` — list, read, write engine settings.
//
// Three subcommands map onto /v1/settings, /v1/settings/{key} GET/PUT.
// Secrets come back masked from the engine; the CLI never prints them.
//
//   sk settings list                  — show every registered setting
//   sk settings get <key>             — read one
//   sk settings set <key> <json>      — write one (value must be valid JSON)

import { exitCodeFor } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { resolveProfile } from "../config.ts";
import { EngineClient, SkEngineError, SkTransportError } from "../engine-client.ts";

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
  json: { type: "boolean" as const, description: "JSON output" },
};

const listCommand = defineCommand({
  meta: { name: "list", description: "List every setting with its resolved value" },
  args: commonArgs,
  async run({ args }) {
    const client = buildClient(args);
    try {
      const { items } = await client.listSettings();
      if (args.json) return printJson({ items });
      let category: string | null = null;
      for (const it of items) {
        if (it.category !== category) {
          category = it.category;
          process.stdout.write(`\n${pc.bold(category)}\n`);
        }
        const flag = it.is_default ? pc.dim("(default)") : pc.green("(set)");
        const secret = it.secret ? pc.yellow(" secret") : "";
        process.stdout.write(
          `  ${pc.cyan(it.key.padEnd(38))} ${String(JSON.stringify(it.value)).slice(0, 60).padEnd(62)} ${flag}${secret}\n`,
        );
      }
    } catch (err) {
      reportError(err);
    }
  },
});

const getCommand = defineCommand({
  meta: { name: "get", description: "Read one setting" },
  args: {
    key: { type: "positional" as const, required: true, description: "Setting key" },
    ...commonArgs,
  },
  async run({ args }) {
    const client = buildClient(args);
    try {
      const out = await client.getSetting(args.key as string);
      if (args.json) return printJson(out);
      process.stdout.write(`${pc.cyan(out.key)} ${pc.dim(`(${out.scope})`)}\n`);
      process.stdout.write(`  value:      ${JSON.stringify(out.value)}\n`);
      process.stdout.write(`  is_default: ${out.is_default}\n`);
      if (out.secret) process.stdout.write(`  ${pc.yellow("secret — value is masked")}\n`);
    } catch (err) {
      reportError(err);
    }
  },
});

const setCommand = defineCommand({
  meta: {
    name: "set",
    description: "Write one setting. <value> must be valid JSON ('\"abc\"', 42, true, null).",
  },
  args: {
    key: { type: "positional" as const, required: true, description: "Setting key" },
    value: { type: "positional" as const, required: true, description: "Value as JSON" },
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
      const out = await client.setSetting(args.key as string, parsed);
      if (args.json) return printJson(out);
      process.stdout.write(`${pc.green("✔")} ${pc.cyan(out.key)} ${pc.dim(`(${out.scope})`)}\n`);
      process.stdout.write(`  value:      ${JSON.stringify(out.value)}\n`);
      if (out.secret)
        process.stdout.write(`  ${pc.yellow("secret — value is masked in output")}\n`);
    } catch (err) {
      reportError(err);
    }
  },
});

export const settingsCommand = defineCommand({
  meta: {
    name: "settings",
    description: "List, read, and write engine + tenant settings (secrets are always masked)",
  },
  subCommands: {
    list: listCommand,
    get: getCommand,
    set: setCommand,
  },
});
