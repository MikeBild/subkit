import * as prompts from "@clack/prompts";
import { exitCodeFor, isEngineError, wasReported } from "@cli-core/errors";
import { compatibilityWarning } from "@cli-core/release/compatibility.ts";
import { startUpdateNotifier } from "@cli-core/update-notifier.ts";
import { VERSION } from "@cli-core/version.ts";
import { type CommandDef, defineCommand, runCommand, type SubCommandsDef, showUsage } from "citty";
import pc from "picocolors";
import { agentCommand } from "./commands/agent.ts";
import { apiKeysCommand } from "./commands/apikeys.ts";
import { appsCommand } from "./commands/apps.ts";
import { auditCommand } from "./commands/audit.ts";
import { authCommand } from "./commands/auth.ts";
import { brandingCommand } from "./commands/branding.ts";
import { categoriesCommand } from "./commands/categories.ts";
import { chatCommand } from "./commands/chat.ts";
import { clipperCommand } from "./commands/clipper.ts";
import { connectorTemplatesCommand } from "./commands/connector-templates.ts";
import { connectorsCommand } from "./commands/connectors.ts";
import { diagnosticsCommand } from "./commands/diagnostics.ts";
import { discoveryCommand } from "./commands/discovery.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { eventsCommand } from "./commands/events.ts";
import { executionsCommand } from "./commands/executions.ts";
import { extractCommand } from "./commands/extract.ts";
import { attachCommand, filesCommand } from "./commands/files.ts";
import { healthCommand } from "./commands/health.ts";
import { hooksCommand } from "./commands/hooks.ts";
import { initCommand } from "./commands/init.ts";
import { installCommand } from "./commands/install.ts";
import { intakeCommand } from "./commands/intake.ts";
import { invitesCommand } from "./commands/invites.ts";
import { joinCommand } from "./commands/join.ts";
import { knowledgeSourcesCommand } from "./commands/knowledge-sources.ts";
import { logsCommand } from "./commands/logs.ts";
import { notificationsCommand } from "./commands/notifications.ts";
import { packagesCommand } from "./commands/packages.ts";
import { patchCandidatesCommand } from "./commands/patch-candidates.ts";
import { portalTokensCommand } from "./commands/portal-tokens.ts";
import { profileCommand } from "./commands/profile.ts";
import { rbacCommand } from "./commands/rbac.ts";
import { reviewCommand } from "./commands/review.ts";
import { schedulesCommand } from "./commands/schedules.ts";
import { selfHealingCommand } from "./commands/self-healing.ts";
import {
  sessionsCommand,
  subkitLs,
  subkitRename,
  subkitRm,
  subkitShow,
} from "./commands/sessions.ts";
import { settingsCommand } from "./commands/settings.ts";
import { skillCandidatesCommand } from "./commands/skill-candidates.ts";
import { skillsCommand } from "./commands/skills.ts";
import { statsCommand } from "./commands/stats.ts";
import { subscriptionsCommand } from "./commands/subscriptions.ts";
import { systemCommand } from "./commands/system.ts";
import { systemAccountsCommand } from "./commands/system-accounts.ts";
import { tasksCommand } from "./commands/tasks.ts";
import { updateCommand } from "./commands/update.ts";
import { usersCommand } from "./commands/users.ts";
import { vaultCommand } from "./commands/vault.ts";
import { workflowsCommand } from "./commands/workflows.ts";
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
import { profileOption, splitLeadingOptions } from "./lib/leading-options.ts";
import { riskSummaryLine } from "./lib/operator-digest.ts";
import { suggestCommand } from "./lib/suggest.ts";
import { runCliOAuthLogin } from "./login-oauth.ts";
import { runMcpProxy } from "./mcp-proxy.ts";
import { personaCanSee, recordPersonaHint } from "./persona-probe.ts";

type RunInkRepl = typeof import("./ink-repl.ts")["runInkRepl"];
async function loadInkRepl(): Promise<RunInkRepl> {
  const mod = await import("./ink-repl.ts");
  return mod.runInkRepl;
}

import { watchEngineVersion } from "./engine-version-watch.ts";
import { mostRecentSession } from "./sessions.ts";
import { loadSettings } from "./settings.ts";
import { renderHelp } from "./slash.ts";

const commonArgs = {
  "engine-url": { type: "string" as const, description: "Engine base URL" },
  "api-key": { type: "string" as const, description: "API key (Bearer)" },
  tenant: { type: "string" as const, description: "Active tenant id" },
  profile: { type: "string" as const, description: "Profile name (~/.subkit/config.json)" },
};

const loginCommand = defineCommand({
  meta: { name: "login", description: "Authenticate against a subkit engine" },
  args: {
    ...commonArgs,
    "api-key": { type: "string", description: "Scripted API-key login (skips device flow)" },
    "portal-token": { type: "string", description: "Authenticate as a portal-token principal" },
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

    if (apiKey) {
      saveProfile({
        name: profileName,
        engine_url: engineUrl,
        api_key: apiKey,
        active_tenant_id: tenant,
      });
      process.stdout.write(`subkit: profile '${profileName}' saved to ${configPath()}\n`);
      try {
        const client = new EngineClient({ engine_url: engineUrl, api_key: apiKey, tenant });
        const [h, ready] = await Promise.all([client.health(), client.ready()]);
        process.stdout.write(`subkit: engine health: live=${h.status} ready=${ready.status}\n`);
        await recordPersonaHint(client, profileName, engineUrl, apiKey, tenant);
        const risk = await riskSummaryLine(client);
        if (risk) process.stdout.write(`subkit: ${risk}\n`);
      } catch (err) {
        process.stderr.write(
          `subkit: warning — could not reach ${engineUrl}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
      return;
    }

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
        `subkit: portal-token profile '${profileName}' saved to ${configPath()} (tenant locked)\n`,
      );
      return;
    }

    try {
      const result = await runCliOAuthLogin({
        engineUrl,
        tenantId: tenant ?? undefined,
        onAuthorizationUrl: (url) => {
          process.stdout.write(`subkit: complete sign-in in your browser:\n${url}\n`);
        },
        onBrowserLaunchError: () => {
          process.stderr.write("subkit: browser launch failed; open the URL above manually\n");
        },
      });
      const activeTenant = result.context_id;
      saveProfile({
        name: profileName,
        engine_url: engineUrl,
        api_key: result.api_key,
        active_tenant_id: activeTenant,
      });
      await recordPersonaHint(
        new EngineClient({ engine_url: engineUrl, api_key: result.api_key, tenant: activeTenant }),
        profileName,
        engineUrl,
        result.api_key,
        activeTenant,
      );
      process.stdout.write(
        `subkit: signed in as ${result.email || result.principal_id} — profile '${profileName}' saved\n`,
      );
    } catch (err) {
      process.stderr.write(
        `subkit: browser login failed: ${err instanceof Error ? err.message : String(err)}\n` +
          "subkit: use --api-key only for scripted or break-glass login\n",
      );
      process.exit(2);
    }
  },
});

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
      process.stdout.write(`subkit: profile '${target}' removed\n`);
    } else {
      process.stdout.write(`subkit: profile '${target}' not found — nothing to do\n`);
    }
  },
});

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
      `subkit status\n` +
        `  profile      ${profile.name}\n` +
        `  engine_url   ${profile.engine_url}\n` +
        `  tenant       ${profile.active_tenant_id ?? "(none)"}\n` +
        `  api_key      ${profile.api_key ? "(set)" : "(missing)"}\n` +
        `  portal_lock  ${profile.portal_locked ? "yes" : "no"}\n`,
    );
    if (!profile.api_key) {
      process.stdout.write(`  run 'subkit login' to authenticate.\n`);
      return;
    }
    try {
      const client = new EngineClient({
        engine_url: profile.engine_url,
        api_key: profile.api_key,
        tenant: profile.active_tenant_id,
      });
      const [h, ready] = await Promise.all([client.health(), client.ready()]);
      process.stdout.write(`  engine_ok    live=${h.status} ready=${ready.status}\n`);
    } catch (err) {
      process.stdout.write(
        `  engine_ok    unreachable (${err instanceof Error ? err.message : String(err)})\n`,
      );
    }
  },
});

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
      process.stderr.write("subkit: cannot switch tenants as a portal-token user\n");
      process.exit(2);
    }
    if (args.use) {
      const result = await runCliOAuthLogin({
        engineUrl: profile.engine_url,
        tenantId: String(args.use),
        onAuthorizationUrl: (url) => {
          process.stdout.write(`subkit: authorize this workspace in your browser:\n${url}\n`);
        },
        onBrowserLaunchError: () => {
          process.stderr.write("subkit: browser launch failed; open the URL above manually\n");
        },
      });
      saveProfile({
        name: profile.name,
        engine_url: profile.engine_url,
        api_key: result.api_key,
        active_tenant_id: result.context_id,
      });
      process.stdout.write(`subkit: active tenant set to ${result.context_id}\n`);
      return;
    }
    process.stdout.write(
      `subkit tenants: current active tenant = ${profile.active_tenant_id ?? "(none)"}\n` +
        `  manage memberships in your authenticated browser: ${new URL("/cockpit/", profile.engine_url).toString()}\n` +
        "  use 'subkit tenants <id>' to authorize and switch workspace.\n",
    );
  },
});

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
      process.stderr.write("subkit mcp: not logged in — run 'subkit login' first\n");
      process.exit(2);
    }
    await runMcpProxy(profile);
  },
});

async function runOnboarding(engineUrl: string): Promise<boolean> {
  prompts.intro("Welcome to subkit — let's connect you to an engine.");
  const choice = await prompts.select({
    message: "How would you like to get started?",
    options: [
      {
        value: "identity",
        label: "Use an identity provider",
        hint: "Configured browser or device flow",
      },
      { value: "api-key", label: "Paste an API key", hint: "wf_live_…" },
      { value: "init", label: "Point at an engine / bootstrap", hint: "subkit init" },
    ],
  });
  if (prompts.isCancel(choice)) {
    prompts.cancel("Onboarding cancelled.");
    return false;
  }

  if (choice === "api-key") {
    const key = await prompts.text({
      message: "Paste your API key",
      placeholder: "wf_live_…",
    });
    if (prompts.isCancel(key) || !String(key).trim()) {
      prompts.cancel("Onboarding cancelled.");
      return false;
    }
    await runCommand(loginCommand, {
      rawArgs: ["--api-key", String(key).trim(), "--engine-url", engineUrl],
    });
    return Boolean(resolveProfile().api_key);
  }

  if (choice === "init") {
    const url = await prompts.text({
      message: "Engine URL",
      placeholder: engineUrl,
      defaultValue: engineUrl,
    });
    if (prompts.isCancel(url)) {
      prompts.cancel("Onboarding cancelled.");
      return false;
    }
    const token = await prompts.text({
      message: "Bootstrap token (from the engine's first-boot banner)",
      placeholder: "tok_…",
    });
    if (prompts.isCancel(token) || !String(token).trim()) {
      prompts.cancel("Onboarding cancelled.");
      return false;
    }
    await runCommand(initCommand, {
      rawArgs: ["--token", String(token).trim(), "--engine-url", String(url).trim() || engineUrl],
    });
    return Boolean(resolveProfile().api_key);
  }

  await runCommand(loginCommand, { rawArgs: ["--engine-url", engineUrl] });
  return Boolean(resolveProfile().api_key);
}

const mainCommand = defineCommand({
  meta: {
    name: "subkit",
    version: VERSION,
    description: "End-user conversational CLI for subkit-backend",
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
    quiet: {
      type: "boolean",
      description: "Suppress non-critical headless warnings",
      default: false,
    },
    "max-turns": {
      type: "string",
      description: "Maximum model/tool steps for one headless turn",
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
      description: "Skip SK.md injection for this invocation",
      default: false,
    },
    connector: { type: "string", description: "Bind the new conversation to a connector slug" },
    workflow: { type: "string", description: "Bind the new conversation to a workflow id" },
    attach: {
      type: "string",
      description:
        "Upload a file and attach it to the conversation before the prompt runs (repeatable, headless -p only)",
    },
  },
  subCommands: {
    login: loginCommand,
    logout: logoutCommand,
    profile: profileCommand,
    status: statusCommand,
    tenants: tenantsCommand,
    mcp: mcpCommand,
    update: updateCommand,
    sessions: sessionsCommand,
    ls: subkitLs,
    show: subkitShow,
    rename: subkitRename,
    rm: subkitRm,
    health: healthCommand,
    doctor: doctorCommand,
    logs: logsCommand,
    settings: settingsCommand,
    branding: brandingCommand,
    extract: extractCommand,
    files: filesCommand,
    attach: attachCommand,
    auth: authCommand,
    agent: agentCommand,
    workflows: workflowsCommand,
    connectors: connectorsCommand,
    categories: categoriesCommand,
    chat: chatCommand,
    clipper: clipperCommand,
    "connector-templates": connectorTemplatesCommand,
    vault: vaultCommand,
    skills: skillsCommand,
    "skill-candidates": skillCandidatesCommand,
    "knowledge-sources": knowledgeSourcesCommand,
    discovery: discoveryCommand,
    executions: executionsCommand,
    schedules: schedulesCommand,
    tasks: tasksCommand,
    "patch-candidates": patchCandidatesCommand,
    review: reviewCommand,
    "self-healing": selfHealingCommand,
    hooks: hooksCommand,
    subscriptions: subscriptionsCommand,
    events: eventsCommand,
    notifications: notificationsCommand,
    packages: packagesCommand,
    diagnostics: diagnosticsCommand,
    stats: statsCommand,
    init: initCommand,
    intake: intakeCommand,
    install: installCommand,
    join: joinCommand,
    rbac: rbacCommand,
    audit: auditCommand,
    apikeys: apiKeysCommand,
    "portal-tokens": portalTokensCommand,
    apps: appsCommand,
    users: usersCommand,
    invites: invitesCommand,
    system: systemCommand,
    "system-accounts": systemAccountsCommand,
  },
  async run({ args }) {
    const positional = (args._ as string[] | undefined)?.[0];
    if (positional && Object.hasOwn(SUB_COMMANDS, positional)) return;
    let profile = resolveProfile({
      engine_url: args["engine-url"] as string | undefined,
      api_key: args["api-key"] as string | undefined,
      tenant: args.tenant as string | undefined,
      profile: args.profile as string | undefined,
    });
    if (!profile.api_key) {
      if (!process.stdout.isTTY) {
        process.stderr.write("subkit: not logged in — run 'subkit login --api-key <key>' first\n");
        process.exit(2);
      }
      const ok = await runOnboarding(profile.engine_url);
      if (!ok) {
        process.exit(2);
      }
      profile = resolveProfile({
        engine_url: args["engine-url"] as string | undefined,
        api_key: args["api-key"] as string | undefined,
        tenant: args.tenant as string | undefined,
        profile: args.profile as string | undefined,
      });
      if (!profile.api_key) {
        process.stderr.write("subkit: not logged in — run 'subkit login --api-key <key>' first\n");
        process.exit(2);
      }
    }
    const headlessPrompt = (args.p as string | undefined) ?? undefined;
    const interactivePrompt = (args.prompt as string | undefined) ?? undefined;
    const output = ((args.output as string | undefined) ?? "text") as OutputFormat;
    if (!["text", "json", "stream-json"].includes(output)) {
      process.stderr.write(`subkit: invalid --output '${output}'\n`);
      process.exit(2);
    }
    const maxTurnsRaw = args["max-turns"] as string | undefined;
    let maxTurns: number | undefined;
    if (maxTurnsRaw !== undefined) {
      const parsed = Number(maxTurnsRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 64) {
        process.stderr.write("subkit: --max-turns must be an integer between 1 and 64\n");
        process.exit(2);
      }
      maxTurns = parsed;
    }

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
        process.stderr.write("subkit -c: no prior session found in ~/.subkit/sessions/\n");
        process.exit(2);
      }
      resumeId = latest.conversation_id;
      process.stdout.write(`subkit: continuing ${resumeId.slice(0, 8)}\n`);
    }

    if (headlessPrompt) {
      const attachRaw = args.attach as string | string[] | undefined;
      const attach: readonly string[] =
        attachRaw === undefined
          ? []
          : Array.isArray(attachRaw)
            ? attachRaw.filter((p): p is string => typeof p === "string" && p.length > 0)
            : attachRaw.length > 0
              ? [attachRaw]
              : [];
      const result = await runHeadless({
        profile,
        prompt: headlessPrompt,
        output,
        noMemory: Boolean(args["no-memory"]),
        quiet: Boolean(args.quiet),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(resumeId ? { resume: resumeId } : {}),
        ...(args.connector ? { connector_id: String(args.connector) } : {}),
        ...(args.workflow ? { workflow_id: String(args.workflow) } : {}),
        ...(attach.length > 0 ? { attach } : {}),
      });
      process.exit(result.exitCode);
    }

    void renderHelp;
    const runInkRepl = await loadInkRepl();
    const exit = await runInkRepl({
      profile,
      ...(interactivePrompt ? { initialPrompt: interactivePrompt } : {}),
      ...(resumeId ? { resumeConversationId: resumeId } : {}),
      noMemory: Boolean(args["no-memory"]),
    });
    process.exit(exit);
  },
});

const rawArgs = process.argv.slice(2);

interface SubEntry {
  command: SubCommandsDef[string];
  requires?: string;
}

export const SUB_COMMANDS: Record<string, SubEntry> = {
  login: { command: loginCommand },
  logout: { command: logoutCommand },
  profile: { command: profileCommand },
  status: { command: statusCommand },
  tenants: { command: tenantsCommand },
  mcp: { command: mcpCommand },
  update: { command: updateCommand },
  sessions: { command: sessionsCommand },
  ls: { command: subkitLs },
  show: { command: subkitShow },
  rename: { command: subkitRename },
  rm: { command: subkitRm },
  health: { command: healthCommand },
  doctor: { command: doctorCommand },
  logs: { command: logsCommand, requires: "audit:read" },
  settings: { command: settingsCommand, requires: "settings:read" },
  branding: { command: brandingCommand },
  extract: { command: extractCommand, requires: "conversation:write" },
  files: { command: filesCommand, requires: "file:read" },
  attach: { command: attachCommand, requires: "file:write" },
  auth: { command: authCommand, requires: "connector:write" },
  agent: { command: agentCommand, requires: "skill:read" },
  workflows: { command: workflowsCommand, requires: "workflow:read" },
  connectors: { command: connectorsCommand, requires: "connector:read" },
  categories: { command: categoriesCommand, requires: "workflow:read" },
  chat: { command: chatCommand, requires: "chat_workspace:read" },
  clipper: { command: clipperCommand },
  "connector-templates": { command: connectorTemplatesCommand, requires: "connector:read" },
  vault: { command: vaultCommand },
  skills: { command: skillsCommand, requires: "skill:read" },
  "skill-candidates": { command: skillCandidatesCommand, requires: "skill:read" },
  "knowledge-sources": { command: knowledgeSourcesCommand, requires: "knowledge:read" },
  discovery: { command: discoveryCommand, requires: "discovery:read" },
  executions: { command: executionsCommand, requires: "execution:read" },
  schedules: { command: schedulesCommand, requires: "workflow:read" },
  tasks: { command: tasksCommand, requires: "task:read" },
  "patch-candidates": { command: patchCandidatesCommand, requires: "workflow:read" },
  review: { command: reviewCommand, requires: "workflow:read" },
  "self-healing": { command: selfHealingCommand, requires: "workflow:write" },
  hooks: { command: hooksCommand, requires: "inbound_hook:read" },
  subscriptions: { command: subscriptionsCommand, requires: "subscription:read" },
  events: { command: eventsCommand, requires: "audit:read" },
  notifications: { command: notificationsCommand, requires: "notification:read" },
  packages: { command: packagesCommand, requires: "package:import" },
  diagnostics: { command: diagnosticsCommand, requires: "audit:read" },
  stats: { command: statsCommand, requires: "stats:read" },
  init: { command: initCommand },
  intake: { command: intakeCommand, requires: "intake:read" },
  install: { command: installCommand, requires: "connector:write" },
  join: { command: joinCommand },
  rbac: { command: rbacCommand, requires: "rbac:read" },
  audit: { command: auditCommand, requires: "audit:read" },
  apikeys: { command: apiKeysCommand, requires: "api_key:read" },
  "portal-tokens": { command: portalTokensCommand, requires: "portal_token:read" },
  apps: { command: appsCommand, requires: "settings:read" },
  users: { command: usersCommand, requires: "identity:read" },
  invites: { command: invitesCommand, requires: "identity:read" },
  system: { command: systemCommand, requires: "system:restart" },
  "system-accounts": { command: systemAccountsCommand, requires: "identity:read" },
};

function warnOnIncompatibleEngine(): void {
  watchEngineVersion((engineVersion) => {
    const warning = compatibilityWarning(VERSION, engineVersion);
    if (warning) process.stderr.write(`${pc.yellow(`warning: ${warning}`)}\n`);
  });
}

function startUpdateHint(): void {
  const command = rawArgs.find((arg) => !arg.startsWith("-"));
  startUpdateNotifier({
    command,
    machineReadable: rawArgs.includes("--json") || rawArgs.includes("-p"),
    enabledInSettings: loadSettings().merged.updateCheck !== false,
  });
}

async function dispatch(): Promise<void> {
  startUpdateHint();

  if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    const positionals = rawArgs.filter((a) => !a.startsWith("-"));
    const topName = positionals[0];
    const topEntry = topName ? SUB_COMMANDS[topName] : undefined;
    if (topEntry) {
      const topCmd = topEntry.command as CommandDef & {
        subCommands?: Record<string, CommandDef>;
      };
      const subName = positionals[1];
      const leafCmd = subName && topCmd.subCommands ? topCmd.subCommands[subName] : undefined;
      if (leafCmd) {
        await showUsage(leafCmd, topCmd);
      } else {
        await showUsage(topCmd);
      }
      return;
    }
    const personaHint = loadConfig().profiles[loadConfig().active_profile]?.persona_hint ?? null;
    const visible = Object.fromEntries(
      Object.entries(SUB_COMMANDS)
        .filter(([, e]) => personaCanSee(personaHint, e.requires))
        .map(([k, e]) => [k, e.command]),
    );
    const filteredMain = defineCommand({
      ...mainCommand,
      subCommands: visible,
    });
    await showUsage(filteredMain);
    return;
  }
  const {
    leading,
    command: first,
    rest,
  } = splitLeadingOptions(rawArgs, mainCommand.args as Record<string, { type?: string }>);
  const sub = first ? SUB_COMMANDS[first] : undefined;
  const profile = profileOption(rawArgs);
  if (profile) process.env.SUBKIT_PROFILE = profile;
  if (sub) {
    warnOnIncompatibleEngine();
    const separator = rest.indexOf("--");
    const subArgs =
      separator === -1
        ? [...rest, ...leading]
        : [...rest.slice(0, separator), ...leading, ...rest.slice(separator)];
    await runCommand(sub.command as CommandDef, { rawArgs: subArgs });
    return;
  }
  if (first && leading.length === 0 && !first.includes(" ")) {
    const suggestion = suggestCommand(first, Object.keys(SUB_COMMANDS));
    if (suggestion) {
      process.stderr.write(`subkit: unknown command '${first}' — did you mean '${suggestion}'?\n`);
      process.exitCode = 2;
      return;
    }
  }
  await runCommand(mainCommand, { rawArgs });
}

if (import.meta.main) {
  dispatch().catch((err: unknown) => {
    if (!wasReported(err)) {
      const lines = [`subkit: ${err instanceof Error ? err.message : String(err)}`];
      if (isEngineError(err)) {
        if (err.hint) lines.push(pc.dim(`  hint: ${err.hint}`));
        if (err.trace_id) lines.push(pc.dim(`  trace: ${err.trace_id}`));
      }
      process.stderr.write(`${lines.join("\n")}\n`);
    }
    process.exitCode = exitCodeFor(err);
  });
}
