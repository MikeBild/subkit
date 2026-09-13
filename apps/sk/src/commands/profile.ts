// `sk profile` — manage named profiles for different environments.
//
// Same UX as `subkit profile` for consistency. Uses sk's own config
// at ~/.sk/config.json.

import * as prompts from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";

import { configPath, DEFAULT_ENGINE_URL, loadConfig, saveConfig, saveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

const listCommand = defineCommand({
  meta: { name: "list", description: "List all saved profiles" },
  async run() {
    const cfg = loadConfig();
    const names = Object.keys(cfg.profiles);
    if (names.length === 0) {
      process.stdout.write("no profiles configured — run 'sk profile add' to create one\n");
      return;
    }
    for (const name of names) {
      const p = cfg.profiles[name]!;
      const marker = name === cfg.active_profile ? pc.green("*") : " ";
      const keyHint = p.api_key ? pc.dim("(key set)") : pc.yellow("(no key)");
      process.stdout.write(`  ${marker} ${pc.bold(name.padEnd(14))} ${p.engine_url}  ${keyHint}\n`);
    }
  },
});

const useCommand = defineCommand({
  meta: { name: "use", description: "Switch the active profile" },
  args: {
    name: { type: "positional", required: false, description: "Profile name to activate" },
  },
  async run({ args }) {
    const cfg = loadConfig();
    const names = Object.keys(cfg.profiles);

    let target = args.name as string | undefined;

    // Interactive selection when no name provided
    if (!target) {
      if (names.length === 0) {
        process.stdout.write("no profiles configured — run 'sk profile add' to create one\n");
        return;
      }
      const selected = await prompts.select({
        message: "Switch profile",
        options: names.map((n) => ({
          value: n,
          label: `${n === cfg.active_profile ? "* " : "  "}${n}`,
          hint: cfg.profiles[n]?.engine_url ?? "",
        })),
      });
      if (prompts.isCancel(selected)) return;
      target = selected as string;
    }

    if (!cfg.profiles[target]) {
      process.stderr.write(`${pc.red("error")}: profile "${target}" not found\n`);
      process.exit(1);
    }

    cfg.active_profile = target;
    saveConfig(cfg);
    const p = cfg.profiles[target]!;
    process.stdout.write(`${pc.green("ok")} switched to "${pc.bold(target)}" (${p.engine_url})\n`);
  },
});

const addCommand = defineCommand({
  meta: { name: "add", description: "Create a new profile (guided setup)" },
  args: {
    name: { type: "string", description: "Profile name" },
    "engine-url": { type: "string", description: "Engine base URL" },
    "api-key": { type: "string", description: "API key" },
  },
  async run({ args }) {
    let name = args.name as string | undefined;
    let engineUrl = args["engine-url"] as string | undefined;
    let apiKey = args["api-key"] as string | undefined;

    prompts.intro(pc.cyan("sk profile add"));

    // Interactive prompts for missing values
    if (!name) {
      const v = await prompts.text({
        message: "Profile name",
        placeholder: "e.g. local, prod, staging",
      });
      if (prompts.isCancel(v)) return;
      name = v as string;
    }

    if (!engineUrl) {
      const v = await prompts.text({
        message: "Engine URL",
        placeholder: DEFAULT_ENGINE_URL,
        defaultValue: DEFAULT_ENGINE_URL,
      });
      if (prompts.isCancel(v)) return;
      engineUrl = (v as string) || DEFAULT_ENGINE_URL;
    }

    if (!apiKey) {
      const method = await prompts.select({
        message: "Authentication method",
        options: [
          { value: "api-key", label: "API key", hint: "paste an existing key" },
          { value: "none", label: "Skip for now", hint: "configure later" },
        ],
      });
      if (prompts.isCancel(method)) return;

      if (method === "api-key") {
        const v = await prompts.password({ message: "API key" });
        if (prompts.isCancel(v)) return;
        apiKey = v as string;
      }
    }

    saveProfile({
      name,
      engine_url: engineUrl,
      api_key: apiKey ?? "",
      active_tenant_id: null,
    });

    prompts.log.success(`Profile "${name}" saved to ${configPath()}`);

    // Health check
    if (apiKey) {
      try {
        const client = new EngineClient({ engine_url: engineUrl, api_key: apiKey, tenant: null });
        const [h, ready] = await Promise.all([client.health(), client.ready()]);
        prompts.log.success(`Engine reachable — live: ${h.status}, ready: ${ready.status}`);
      } catch (err) {
        prompts.log.warn(
          `Could not reach ${engineUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    prompts.outro(`Use 'sk profile use ${name}' to activate`);
  },
});

const showCommand = defineCommand({
  meta: { name: "show", description: "Show profile details + health check" },
  args: {
    name: { type: "positional", required: false, description: "Profile name (default: active)" },
  },
  async run({ args }) {
    const cfg = loadConfig();
    const target = (args.name as string | undefined) ?? cfg.active_profile;
    const p = cfg.profiles[target];
    if (!p) {
      process.stderr.write(`${pc.red("error")}: profile "${target}" not found\n`);
      process.exit(1);
    }

    const active = target === cfg.active_profile ? pc.green(" (active)") : "";
    process.stdout.write(
      `${pc.bold(target)}${active}\n` +
        `  engine_url   ${p.engine_url}\n` +
        `  tenant       ${p.active_tenant_id ?? pc.dim("(none)")}\n` +
        `  api_key      ${p.api_key ? pc.green("(set)") : pc.yellow("(missing)")}\n`,
    );

    if (p.api_key) {
      try {
        const client = new EngineClient({
          engine_url: p.engine_url,
          api_key: p.api_key,
          tenant: p.active_tenant_id,
        });
        const [h, ready] = await Promise.all([client.health(), client.ready()]);
        process.stdout.write(`  health       live=${pc.green(h.status)} ready=${ready.status}\n`);
      } catch (err) {
        process.stdout.write(
          `  health       ${pc.red("unreachable")} (${err instanceof Error ? err.message : String(err)})\n`,
        );
      }
    }
  },
});

const deleteCommand = defineCommand({
  meta: { name: "delete", description: "Delete a saved profile" },
  args: {
    name: { type: "positional", required: true, description: "Profile name to delete" },
  },
  async run({ args }) {
    const target = args.name as string;
    const cfg = loadConfig();
    if (!cfg.profiles[target]) {
      process.stderr.write(`${pc.red("error")}: profile "${target}" not found\n`);
      process.exit(1);
    }

    const confirmed = await prompts.confirm({
      message: `Delete profile "${target}"?`,
    });
    if (!confirmed || prompts.isCancel(confirmed)) return;

    delete cfg.profiles[target];
    if (cfg.active_profile === target) {
      const remaining = Object.keys(cfg.profiles);
      cfg.active_profile = remaining[0] ?? "default";
    }
    saveConfig(cfg);
    process.stdout.write(`${pc.green("ok")} profile "${target}" deleted\n`);
  },
});

export const profileCommand = defineCommand({
  meta: { name: "profile", description: "Manage named profiles (environments)" },
  subCommands: {
    list: listCommand,
    use: useCommand,
    add: addCommand,
    show: showCommand,
    delete: deleteCommand,
  },
});
