// `subkit` CLI entrypoint. Uses citty for command parsing, routes every
// command through a typed engine client (see ./engine-client.ts), and
// lazy-loads ink only when `subkit chat` is invoked.
//
// Every subcommand also exposes `--engine-url`, `--api-key`, `--tenant`,
// and `--json` so scripts can operate without a saved profile.

import { notifyIfUpdateAvailable } from "@cli-core/update-notifier.ts";
import { VERSION } from "@cli-core/version.ts";
import { defineCommand, runCommand, showUsage } from "citty";
import { apikeysCommand } from "./commands/apikeys.ts";
import { auditCommand } from "./commands/audit.ts";
import { chatCommand } from "./commands/chat.ts";
import { connectorsCommand } from "./commands/connectors.ts";
import { credentialsCommand } from "./commands/credentials.ts";
import { discoveryCommand } from "./commands/discovery.ts";
import { eventsCommand } from "./commands/events.ts";
import { executionsCommand } from "./commands/executions.ts";
import { extractCommand } from "./commands/extract.ts";
import { healthCommand } from "./commands/health.ts";
import { hooksCommand } from "./commands/hooks.ts";
import { knowledgeSourcesCommand } from "./commands/knowledge-sources.ts";
import { loginCommand } from "./commands/login.ts";
import { mcpCommand } from "./commands/mcp.ts";
import { notificationsCommand } from "./commands/notifications.ts";
import { portalTokensCommand } from "./commands/portal-tokens.ts";
import { profileCommand } from "./commands/profile.ts";
import { rbacCommand } from "./commands/rbac.ts";
import { schedulesCommand } from "./commands/schedules.ts";
import { skillCandidatesCommand } from "./commands/skill-candidates.ts";
import { skillsCommand } from "./commands/skills.ts";
import { subscriptionsCommand } from "./commands/subscriptions.ts";
import { summarizeCommand } from "./commands/summarize.ts";
import { tenantsCommand } from "./commands/tenants.ts";
import { tunnelAgentCommand } from "./commands/tunnel-agent.ts";
import { tunnelsCommand } from "./commands/tunnels.ts";
import { updateCommand } from "./commands/update.ts";
import { workflowsCommand } from "./commands/workflows.ts";
import { exitCodeFor, formatError } from "./utils/errors.ts";

export const main = defineCommand({
  meta: {
    name: "subkit",
    version: VERSION,
    description: "Command-line interface for the subkit workflow engine",
  },
  subCommands: {
    login: loginCommand,
    profile: profileCommand,
    tenants: tenantsCommand,
    health: healthCommand,
    workflows: workflowsCommand,
    connectors: connectorsCommand,
    credentials: credentialsCommand,
    schedules: schedulesCommand,
    skills: skillsCommand,
    "skill-candidates": skillCandidatesCommand,
    "knowledge-sources": knowledgeSourcesCommand,
    discovery: discoveryCommand,
    executions: executionsCommand,
    hooks: hooksCommand,
    subscriptions: subscriptionsCommand,
    events: eventsCommand,
    notifications: notificationsCommand,
    tunnels: tunnelsCommand,
    "tunnel-agent": tunnelAgentCommand,
    apikeys: apikeysCommand,
    "portal-tokens": portalTokensCommand,
    rbac: rbacCommand,
    audit: auditCommand,
    extract: extractCommand,
    summarize: summarizeCommand,
    chat: chatCommand,
    mcp: mcpCommand,
    update: updateCommand,
  },
});

// We dispatch via citty's `runCommand` directly so the top-level
// catch can format errors through our typed mapper. citty's `runMain`
// helper wraps the dispatch in its own try/catch + `console.error` and
// would swallow our error formatting.
//
// Tests never import this file; they pull from ./commands/* directly.
const rawArgs = process.argv.slice(2);

type CittyCommand = typeof main;

async function resolveSubCommand(
  cmd: CittyCommand,
  args: string[],
): Promise<{ cmd: CittyCommand; remaining: string[] }> {
  const subs = (cmd as { subCommands?: Record<string, CittyCommand> }).subCommands;
  if (!subs) return { cmd, remaining: args };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && !a.startsWith("-") && subs[a]) {
      return resolveSubCommand(subs[a] as CittyCommand, args.slice(i + 1));
    }
  }
  return { cmd, remaining: args };
}

async function dispatch(): Promise<void> {
  notifyIfUpdateAvailable("subkit");

  // Top-level --version
  if (rawArgs.length === 1 && (rawArgs[0] === "--version" || rawArgs[0] === "-v")) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  // --help anywhere: walk to the deepest matching subcommand, render its usage.
  if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    const { cmd } = await resolveSubCommand(main, rawArgs);
    await showUsage(cmd);
    return;
  }
  await runCommand(main, { rawArgs });
}

dispatch().catch((err: unknown) => {
  process.stderr.write(`${formatError(err)}\n`);
  process.exit(exitCodeFor(err));
});
