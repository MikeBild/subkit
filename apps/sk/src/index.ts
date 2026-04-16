// `sk` — end-user CLI for subkit-backend, modeled after Claude Code /
// Codex CLI UX. See docs/27-sk-cli.md and the approved plan at
// /Users/mikebild/.claude/plans/swift-scribbling-petal.md for the
// rationale; this file is the command entry point only.
//
// Bare `sk` opens an interactive REPL against the active profile
// (Step 4 of the rollout — currently a stub that points the user to
// `-p`). `sk -p "..."` runs headless and prints via the chosen output
// format. `sk login`, `sk logout`, `sk tenants [use <id>]`, and
// `sk status` live here as top-level commands so scripts never need
// to enter the REPL.

import * as prompts from "@clack/prompts";
import { runBrowserLogin, runDeviceFlow } from "@cli-core/index.ts";
import { defineCommand, runCommand, showUsage } from "citty";
import { profileCommand } from "./commands/profile.ts";
import {
  configPath,
  DEFAULT_ENGINE_URL,
  loadConfig,
  resolveProfile,
  saveConfig,
  saveProfile,
} from "./config.ts";
import { EngineClient } from "./engine-client.ts";
import type { OutputFormat } from "./headless.ts";
import { runHeadless } from "./headless.ts";
import { runInkRepl } from "./ink-repl.ts";
import { runMcpProxy } from "./mcp-proxy.ts";
import { mostRecentSession } from "./sessions.ts";
import { renderHelp } from "./slash.ts";

const VERSION = "0.0.1";

// ---------- Shared arg shapes ----------

const commonArgs = {
  "engine-url": { type: "string" as const, description: "Engine base URL" },
  "api-key": { type: "string" as const, description: "API key (Bearer)" },
  tenant: { type: "string" as const, description: "Active tenant id" },
  profile: { type: "string" as const, description: "Profile name (~/.sk/config.json)" },
};

// ---------- `sk login` ----------

const DEFAULT_OIDC_SCOPE = "openid profile email offline_access";

const loginCommand = defineCommand({
  meta: { name: "login", description: "Authenticate against a subkit engine" },
  args: {
    ...commonArgs,
    "api-key": { type: "string", description: "Scripted API-key login (skips device flow)" },
    "portal-token": { type: "string", description: "Authenticate as a portal-token principal" },
    "issuer-url": { type: "string", description: "OIDC issuer URL (device flow)" },
    "client-id": { type: "string", description: "OIDC client id (device flow)" },
    scope: { type: "string", description: "OIDC scope override" },
  },
  async run({ args }) {
    const profileName = (args.profile as string | undefined) ?? "default";
    const engineUrl =
      (args["engine-url"] as string | undefined) ??
      process.env.SUBKIT_ENGINE_URL ??
      DEFAULT_ENGINE_URL;
    const tenant = (args.tenant as string | undefined) ?? null;
    const apiKey = args["api-key"] as string | undefined;
    const portalToken = args["portal-token"] as string | undefined;

    // Path 1: scripted API key.
    if (apiKey) {
      saveProfile({
        name: profileName,
        engine_url: engineUrl,
        api_key: apiKey,
        active_tenant_id: tenant,
      });
      process.stdout.write(`sk: profile '${profileName}' saved to ${configPath()}\n`);
      try {
        const client = new EngineClient({ engine_url: engineUrl, api_key: apiKey, tenant });
        const h = await client.health();
        process.stdout.write(`sk: engine health: ${h.status} db=${h.db_connected}\n`);
      } catch (err) {
        process.stderr.write(
          `sk: warning — could not reach ${engineUrl}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      return;
    }

    // Path 2: portal token.
    if (portalToken) {
      saveProfile({
        name: profileName,
        engine_url: engineUrl,
        api_key: portalToken,
        active_tenant_id: tenant,
        portal_locked: true,
        persona_hint: "portal",
      });
      process.stdout.write(
        `sk: portal-token profile '${profileName}' saved to ${configPath()} (tenant locked)\n`,
      );
      return;
    }

    // Path 3: Discover providers from the engine and use the best available method.
    interface AuthProvider {
      type: string;
      name: string;
      login_url?: string;
      issuer?: string;
    }
    let providers: AuthProvider[] = [];
    try {
      const res = await fetch(`${engineUrl}/v1/identity/providers`);
      if (res.ok) {
        const data = (await res.json()) as { providers: AuthProvider[] };
        providers = data.providers.filter((p) => p.type !== "api-key");
      }
    } catch {
      /* engine unreachable — fall through to manual OIDC */
    }

    // If we have browser-based providers, use them
    if (providers.length > 0) {
      let provider: AuthProvider;
      if (providers.length === 1) {
        provider = providers[0]!;
      } else {
        const selected = await prompts.select({
          message: "Sign in with",
          options: providers.map((p) => ({
            value: p.type,
            label: p.name,
            hint: p.login_url ?? p.issuer ?? "",
          })),
        });
        if (prompts.isCancel(selected)) {
          process.stdout.write("sk: login cancelled\n");
          return;
        }
        provider = providers.find((p) => p.type === selected)!;
      }

      // Firebase / browser-based
      if (provider.type === "firebase" && provider.login_url) {
        process.stdout.write(`sk: signing in via ${provider.name}...\n`);
        try {
          const result = await runBrowserLogin({
            login_url: provider.login_url,
            engine_url: engineUrl,
          });
          saveProfile({
            name: profileName,
            engine_url: engineUrl,
            api_key: result.api_key,
            active_tenant_id: result.tenant_id,
          });
          process.stdout.write(
            `sk: signed in as ${result.email || result.sub} — profile '${profileName}' saved\n`,
          );
          return;
        } catch (err) {
          process.stderr.write(
            `sk: login failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(2);
        }
      }

      // OIDC device flow provider
      if (provider.type === "oidc" && provider.issuer) {
        let clientId =
          (args["client-id"] as string | undefined) ?? process.env.SUBKIT_OIDC_CLIENT_ID ?? "";
        const scope = (args.scope as string | undefined) ?? DEFAULT_OIDC_SCOPE;
        if (!clientId) {
          const v = await prompts.text({ message: "OIDC client id", placeholder: "subkit-cli" });
          if (prompts.isCancel(v)) {
            process.stdout.write("sk: login cancelled\n");
            return;
          }
          clientId = v as string;
        }
        try {
          const result = await runDeviceFlow({
            issuer_url: provider.issuer,
            client_id: clientId,
            engine_url: engineUrl,
            scope,
          });
          saveProfile({
            name: profileName,
            engine_url: engineUrl,
            api_key: result.api_key,
            active_tenant_id: tenant ?? result.tenant_id ?? null,
          });
          process.stdout.write(`sk: signed in as ${result.sub} — profile '${profileName}' saved\n`);
          return;
        } catch (err) {
          process.stderr.write(
            `sk: device-flow login failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          process.exit(2);
        }
      }
    }

    // Fallback: manual OIDC device flow (no providers discovered)
    let issuer = (args["issuer-url"] as string | undefined) ?? process.env.SUBKIT_OIDC_ISSUER ?? "";
    let clientId =
      (args["client-id"] as string | undefined) ?? process.env.SUBKIT_OIDC_CLIENT_ID ?? "";
    const scope = (args.scope as string | undefined) ?? DEFAULT_OIDC_SCOPE;
    try {
      if (!issuer) {
        const v = await prompts.text({
          message: "OIDC issuer URL",
          placeholder: "https://login.example.com/realms/main",
        });
        if (prompts.isCancel(v)) {
          process.stdout.write("sk: login cancelled\n");
          return;
        }
        issuer = v as string;
      }
      if (!clientId) {
        const v = await prompts.text({ message: "OIDC client id", placeholder: "subkit-cli" });
        if (prompts.isCancel(v)) {
          process.stdout.write("sk: login cancelled\n");
          return;
        }
        clientId = v as string;
      }
    } catch {
      process.stdout.write("sk: login cancelled\n");
      return;
    }

    try {
      const result = await runDeviceFlow({
        issuer_url: issuer,
        client_id: clientId,
        engine_url: engineUrl,
        scope,
      });
      saveProfile({
        name: profileName,
        engine_url: engineUrl,
        api_key: result.api_key,
        active_tenant_id: tenant ?? result.tenant_id ?? null,
      });
      process.stdout.write(
        `sk: signed in as ${result.sub} — profile '${profileName}' saved to ${configPath()}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `sk: device-flow login failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    }
  },
});

// ---------- `sk logout` ----------

const logoutCommand = defineCommand({
  meta: { name: "logout", description: "Drop the active profile" },
  args: {
    profile: { type: "string", description: "Profile name to clear (default: active)" },
  },
  async run({ args }) {
    const cfg = loadConfig();
    const target = (args.profile as string | undefined) ?? cfg.active_profile;
    if (cfg.profiles[target]) {
      delete cfg.profiles[target];
      if (cfg.active_profile === target) {
        const remaining = Object.keys(cfg.profiles);
        cfg.active_profile = remaining[0] ?? "default";
      }
      saveConfig(cfg);
      process.stdout.write(`sk: profile '${target}' removed\n`);
    } else {
      process.stdout.write(`sk: profile '${target}' not found — nothing to do\n`);
    }
  },
});

// ---------- `sk status` ----------

const statusCommand = defineCommand({
  meta: { name: "status", description: "Print the active profile + engine reachability" },
  args: { ...commonArgs },
  async run({ args }) {
    const profile = resolveProfile({
      engine_url: args["engine-url"] as string | undefined,
      api_key: args["api-key"] as string | undefined,
      tenant: args.tenant as string | undefined,
      profile: args.profile as string | undefined,
    });
    process.stdout.write(
      `sk status\n` +
        `  profile      ${profile.name}\n` +
        `  engine_url   ${profile.engine_url}\n` +
        `  tenant       ${profile.active_tenant_id ?? "(none)"}\n` +
        `  api_key      ${profile.api_key ? "(set)" : "(missing)"}\n` +
        `  portal_lock  ${profile.portal_locked ? "yes" : "no"}\n`,
    );
    if (!profile.api_key) {
      process.stdout.write(`  run 'sk login' to authenticate.\n`);
      return;
    }
    try {
      const client = new EngineClient({
        engine_url: profile.engine_url,
        api_key: profile.api_key,
        tenant: profile.active_tenant_id,
      });
      const h = await client.health();
      process.stdout.write(`  engine_ok    ${h.status} db=${h.db_connected}\n`);
    } catch (err) {
      process.stdout.write(
        `  engine_ok    unreachable (${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  },
});

// ---------- `sk tenants [use <id>]` ----------

const tenantsCommand = defineCommand({
  meta: { name: "tenants", description: "List tenants you belong to or switch the active one" },
  args: {
    ...commonArgs,
    use: { type: "positional", required: false, description: "Tenant id to switch to" },
  },
  async run({ args }) {
    const profile = resolveProfile({
      engine_url: args["engine-url"] as string | undefined,
      api_key: args["api-key"] as string | undefined,
      tenant: args.tenant as string | undefined,
      profile: args.profile as string | undefined,
    });
    if (profile.portal_locked) {
      process.stderr.write("sk: cannot switch tenants as a portal-token user\n");
      process.exit(2);
    }
    if (args.use) {
      saveProfile({ ...profile, active_tenant_id: String(args.use) });
      process.stdout.write(`sk: active tenant set to ${args.use}\n`);
      return;
    }
    process.stdout.write(
      `sk tenants: current active tenant = ${profile.active_tenant_id ?? "(none)"}\n` +
        "  use 'sk tenants <id>' to switch.\n",
    );
  },
});

// ---------- `sk mcp` ----------

const mcpCommand = defineCommand({
  meta: { name: "mcp", description: "Run a stdio MCP server proxied to the engine" },
  args: { ...commonArgs },
  async run({ args }) {
    const profile = resolveProfile({
      engine_url: args["engine-url"] as string | undefined,
      api_key: args["api-key"] as string | undefined,
      tenant: args.tenant as string | undefined,
      profile: args.profile as string | undefined,
    });
    if (!profile.api_key) {
      process.stderr.write("sk mcp: not logged in — run 'sk login' first\n");
      process.exit(2);
    }
    await runMcpProxy(profile);
  },
});

// ---------- Top-level `sk` ----------

const mainCommand = defineCommand({
  meta: {
    name: "sk",
    version: VERSION,
    description: "End-user CLI for subkit-backend (Claude Code / Codex CLI style)",
  },
  args: {
    ...commonArgs,
    p: {
      type: "string",
      description: "Headless mode: run a single prompt and print the result",
    },
    prompt: {
      type: "positional",
      required: false,
      description: "Initial prompt (REPL or headless with -p)",
    },
    output: {
      type: "string",
      description: "Output format for headless: text|json|stream-json (default: text)",
      default: "text",
    },
    c: {
      type: "boolean",
      description: "Continue the most recent session",
      default: false,
    },
    r: {
      type: "string",
      description: "Resume a specific conversation id",
    },
    "session-id": { type: "string", description: "Attach to a specific conversation id" },
    "no-memory": {
      type: "boolean",
      description: "Skip SUBKIT.md injection for this invocation",
      default: false,
    },
    connector: { type: "string", description: "Bind the new conversation to a connector slug" },
    workflow: { type: "string", description: "Bind the new conversation to a workflow id" },
  },
  subCommands: {
    login: loginCommand,
    logout: logoutCommand,
    profile: profileCommand,
    status: statusCommand,
    tenants: tenantsCommand,
    mcp: mcpCommand,
  },
  async run({ args }) {
    const profile = resolveProfile({
      engine_url: args["engine-url"] as string | undefined,
      api_key: args["api-key"] as string | undefined,
      tenant: args.tenant as string | undefined,
      profile: args.profile as string | undefined,
    });
    if (!profile.api_key) {
      process.stderr.write("sk: not logged in — run 'sk login --api-key <key>' first\n");
      process.exit(2);
    }
    const headlessPrompt = (args.p as string | undefined) ?? undefined;
    const interactivePrompt = (args.prompt as string | undefined) ?? undefined;
    const output = ((args.output as string | undefined) ?? "text") as OutputFormat;
    if (!["text", "json", "stream-json"].includes(output)) {
      process.stderr.write(`sk: invalid --output '${output}'\n`);
      process.exit(2);
    }

    // Resolve --resume / --session-id / -c → effective conversation id.
    const sessionIdFlag = args["session-id"] as string | undefined;
    const resumeFlag = args.r as string | undefined;
    const continueFlag = Boolean(args.c);
    let resumeId: string | undefined;
    if (typeof sessionIdFlag === "string" && sessionIdFlag.length > 0) {
      resumeId = sessionIdFlag;
    } else if (typeof resumeFlag === "string" && resumeFlag.length > 0) {
      resumeId = resumeFlag;
    } else if (continueFlag) {
      const latest = mostRecentSession({
        engine_url: profile.engine_url,
        tenant_id: profile.active_tenant_id,
      });
      if (!latest) {
        process.stderr.write("sk -c: no prior session found in ~/.sk/sessions/\n");
        process.exit(2);
      }
      resumeId = latest.conversation_id;
      process.stdout.write(`sk: continuing ${resumeId.slice(0, 8)}\n`);
    }

    if (headlessPrompt) {
      const result = await runHeadless({
        profile,
        prompt: headlessPrompt,
        output,
        noMemory: Boolean(args["no-memory"]),
        ...(resumeId ? { resume: resumeId } : {}),
        ...(args.connector ? { connector_id: String(args.connector) } : {}),
        ...(args.workflow ? { workflow_id: String(args.workflow) } : {}),
      });
      process.exit(result.exitCode);
    }

    // Interactive REPL — runInkRepl renders an Ink rich UI when
    // stdout is a TTY and falls back to the line-based readline loop
    // for piped stdout / test harnesses.
    void renderHelp; // keep the import live for tests
    const exit = await runInkRepl({
      profile,
      ...(interactivePrompt ? { initialPrompt: interactivePrompt } : {}),
      ...(resumeId ? { resumeConversationId: resumeId } : {}),
      noMemory: Boolean(args["no-memory"]),
    });
    process.exit(exit);
  },
});

// ---------- Dispatch ----------

const rawArgs = process.argv.slice(2);

// Subcommands that should NOT fall through to the REPL.
// biome-ignore lint/suspicious/noExplicitAny: citty command types are complex
const SUB_COMMANDS: Record<string, any> = {
  login: loginCommand,
  logout: logoutCommand,
  profile: profileCommand,
  status: statusCommand,
  tenants: tenantsCommand,
  mcp: mcpCommand,
};

async function dispatch(): Promise<void> {
  if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    await showUsage(mainCommand);
    return;
  }
  // Dispatch known subcommands directly to prevent citty from also
  // running mainCommand.run() (which starts the REPL).
  const first = rawArgs[0];
  if (first && !first.startsWith("-") && SUB_COMMANDS[first]) {
    await runCommand(SUB_COMMANDS[first]!, { rawArgs: rawArgs.slice(1) });
    return;
  }
  await runCommand(mainCommand, { rawArgs });
}

dispatch().catch((err: unknown) => {
  process.stderr.write(`sk: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
});
