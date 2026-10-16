import { exitCodeFor, isEngineError, reportCommandError } from "@cli-core/errors";
import { emitList, printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { type AppSummary, type AppView, EngineClient } from "../engine-client.ts";

export const APP_LIST_COLUMNS = ["app", "environment", "users", "budget_today", "readiness"];

function makeClient() {
  const profile = resolveProfile();
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
  });
}

function readiness(app: Pick<AppSummary, "configured" | "ready">, failing: string[]): string {
  if (!app.configured)
    return `not configured${failing.length > 0 ? `: ${failing.join(", ")}` : ""}`;
  if (app.ready) return "ready";
  return `needs attention: ${failing.join(", ")}`;
}

function budgetToday(
  settings: AppSummary["settings"],
  budget: AppView["budget_today"] | undefined,
): string {
  const limit = settings?.daily_limit;
  if (!limit) return "no daily limit";
  const cap = `${limit.limit_per_caller} per caller`;
  if (!budget) return cap;
  return `${budget.consumed} used · ${budget.reserved} reserved · ${budget.refusals_today} refused (${cap})`;
}

export function appListRows(
  items: AppSummary[],
  budgets: ReadonlyMap<string, AppView["budget_today"]> = new Map(),
): Record<string, string | number>[] {
  return items.map((app) => ({
    app: app.id,
    environment: app.settings?.execution_environment ?? "—",
    users: app.users.count,
    budget_today: budgetToday(app.settings, budgets.get(app.id)),
    readiness: readiness(app, app.failing_checks),
  }));
}

export async function budgetsToday(
  client: Pick<EngineClient, "getApp">,
  items: AppSummary[],
): Promise<Map<string, AppView["budget_today"]>> {
  const limited = items.filter((app) => app.configured && app.settings?.daily_limit);
  const views = await Promise.allSettled(limited.map((app) => client.getApp(app.id)));
  const budgets = new Map<string, AppView["budget_today"]>();
  for (const result of views) {
    if (result.status === "fulfilled") budgets.set(result.value.id, result.value.budget_today);
  }
  return budgets;
}

function section(title: string, rows: Array<[string, string]>): string[] {
  if (rows.length === 0) return [title, "  (none)"];
  const width = Math.max(...rows.map(([key]) => key.length));
  return [title, ...rows.map(([key, value]) => `  ${key.padEnd(width)}  ${value}`)];
}

export function formatAppView(view: AppView): string {
  const failing = view.checks.filter((check) => !check.ok);
  const lines: string[] = [
    `App ${view.id} — ${readiness(
      view,
      failing.map((check) => check.key),
    )}`,
    "",
  ];

  const settings = view.settings;
  lines.push(
    ...section(
      "Settings",
      settings
        ? [
            ["environment", settings.execution_environment],
            ["budget bucket", settings.budget_bucket],
            [
              "assistant",
              `${settings.assistant_workflow.slug ?? "(missing workflow)"} (${settings.assistant_workflow.id})`,
            ],
            [
              "daily limit",
              settings.daily_limit
                ? `${settings.daily_limit.limit_per_caller} per caller and ${settings.daily_limit.unit}, day in ${settings.daily_limit.tz}`
                : "none",
            ],
          ]
        : [["products entry", "missing"]],
    ),
    "",
  );

  lines.push(
    ...section(
      `Sign-in (${view.sign_in.length})`,
      view.sign_in.map((provider) => [
        provider.id,
        [
          provider.protocol,
          provider.issuer_url,
          provider.audience ? `audience ${provider.audience}` : null,
          `workspace ${provider.tenant_slug}`,
          provider.required_claims.length > 0
            ? `${provider.required_claims.length} required claim(s)`
            : "no required claims",
        ]
          .filter((part): part is string => part !== null)
          .join(" · "),
      ]),
    ),
    "",
  );

  lines.push(
    ...section(
      `Workflows (${view.workflows.length})`,
      view.workflows.map((workflow) => [
        workflow.slug,
        [
          workflow.lifecycle,
          workflow.is_assistant ? "assistant" : null,
          workflow.definition_valid ? null : "invalid definition",
          workflow.id,
        ]
          .filter((part): part is string => part !== null)
          .join(" · "),
      ]),
    ),
    "",
  );

  lines.push(
    ...section("Users", [
      ["signed in", String(view.users.count)],
      ["last seen", view.users.last_seen_at ?? "never"],
    ]),
    "",
  );

  const budget = view.budget_today;
  lines.push(
    ...section(
      "Budget today",
      budget
        ? [
            ["day", `${budget.day} (${budget.tz})`],
            ["consumed", String(budget.consumed)],
            ["reserved", String(budget.reserved)],
            ["refusals", String(budget.refusals_today)],
            ["resets at", budget.resets_at],
          ]
        : [["guard", "no daily limit on the assistant workflow"]],
    ),
    "",
  );

  lines.push("Readiness");
  for (const check of view.checks) {
    lines.push(`  ${check.ok ? "ok  " : "FAIL"}  ${check.key}  ${check.message}`);
    if (!check.ok && check.next_action) lines.push(`        next: ${check.next_action}`);
  }

  const next = failing.find((check) => check.next_action)?.next_action;
  lines.push("");
  lines.push(next ? `Next action: ${next}` : "Next action: none, the app is ready.");
  lines.push(
    "Change it with sk settings get products --json, then sk settings set products '<whole object>'; set replaces the whole value.",
  );
  return `${lines.join("\n")}\n`;
}

export function friendlyAppsError(err: unknown, id?: string): string | null {
  if (!isEngineError(err)) return null;
  if (err.status === 403) {
    return "forbidden: sk apps needs the settings:read permission. Ask an admin to grant it to your role (admins have it by default).";
  }
  if (err.status === 404 && id !== undefined) {
    return `no app "${id}" is visible in this workspace. sk apps list shows the visible ids.`;
  }
  return null;
}

function fail(err: unknown, asJson: boolean, id?: string): never {
  const friendly = asJson ? null : friendlyAppsError(err, id);
  if (friendly) {
    process.stderr.write(`${friendly}\n`);
    process.exit(exitCodeFor(err));
  }
  reportCommandError(err, { json: asJson });
}

const listCmd = defineCommand({
  meta: {
    name: "list",
    description:
      "List the apps of this workspace with environment, users, budget today and readiness",
  },
  args: { json: { type: "boolean", description: "JSON output", default: false } },
  async run({ args }) {
    try {
      const client = makeClient();
      const { items } = await client.listApps();
      if (args.json) {
        printJson(items);
        return;
      }
      emitList(false, APP_LIST_COLUMNS, appListRows(items, await budgetsToday(client, items)));
    } catch (err) {
      fail(err, Boolean(args.json));
    }
  },
});

const showCmd = defineCommand({
  meta: {
    name: "show",
    description:
      "Show one app: settings, sign-in, workflows, users, today's budget and readiness with the next action",
  },
  args: {
    id: { type: "positional", required: true, description: "App id (the product_id)" },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    const id = String(args.id);
    try {
      const view = await makeClient().getApp(id);
      if (args.json) {
        printJson(view);
        return;
      }
      process.stdout.write(formatAppView(view));
    } catch (err) {
      fail(err, Boolean(args.json), id);
    }
  },
});

export const appsCommand = defineCommand({
  meta: {
    name: "apps",
    description:
      "Read-only view of the apps that sign their users in and call SubKit (products settings, sign-in providers, workflows, users, budget)",
  },
  subCommands: { list: listCmd, show: showCmd },
});
