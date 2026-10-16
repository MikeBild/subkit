import { describe, expect, test } from "bun:test";
import { EngineError } from "@cli-core/errors";
import { type AppSummary, type AppView, EngineClient } from "../engine-client.ts";
import { SUB_COMMANDS } from "../index.ts";
import {
  APP_LIST_COLUMNS,
  appListRows,
  appsCommand,
  budgetsToday,
  formatAppView,
  friendlyAppsError,
} from "./apps.ts";
import { userAppIds, userListQuery, userListRows } from "./users.ts";

const ASSISTANT_ID = "11111111-1111-4111-8111-111111111111";

const settings: NonNullable<AppSummary["settings"]> = {
  execution_environment: "prod",
  budget_bucket: "brain",
  assistant_workflow: { id: ASSISTANT_ID, name: "Assistant", slug: "assistant" },
  daily_limit: { bucket: "brain", limit_per_caller: 5, unit: "turn_id", tz: "Europe/Berlin" },
};

function summary(overrides: Partial<AppSummary>): AppSummary {
  return {
    id: "app",
    configured: true,
    ready: true,
    settings,
    sign_in_count: 1,
    workflow_count: 1,
    users: { count: 3, last_seen_at: "2026-01-10T08:00:00.000Z" },
    failing_checks: [],
    ...overrides,
  };
}

const view: AppView = {
  id: "app",
  configured: true,
  ready: false,
  settings,
  sign_in_count: 1,
  workflow_count: 1,
  users: { count: 3, last_seen_at: "2026-01-10T08:00:00.000Z" },
  sign_in: [
    {
      id: "app-accounts",
      label: "App account",
      protocol: "oidc_bearer",
      issuer_url: "https://idp.example.test",
      tenant_slug: "default",
      audience: "app-audience",
      algorithms: ["ES256"],
      required_claims: [{ path: "idp", equals: "primary" }],
      reject_anonymous: true,
    },
  ],
  workflows: [
    {
      id: ASSISTANT_ID,
      slug: "assistant",
      name: "Assistant",
      lifecycle: "active",
      is_assistant: true,
      definition_valid: true,
    },
  ],
  budget_today: {
    bucket: "brain",
    day: "2026-01-10",
    tz: "Europe/Berlin",
    resets_at: "2026-01-10T23:00:00.000Z",
    consumed: 2,
    reserved: 1,
    refusals_today: 4,
  },
  checks: [
    { key: "product_configured", ok: true, message: "products entry present", next_action: null },
    {
      key: "execution_authority",
      ok: false,
      message: "no live execution authority",
      next_action: "Approve the assistant workflow in Cockpit",
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capturingClient(body: unknown, urls: string[]): EngineClient {
  return new EngineClient({
    engine_url: "http://engine.test",
    api_key: "k",
    fetchImpl: ((url: string) => {
      urls.push(url);
      return Promise.resolve(jsonResponse(body));
    }) as unknown as typeof fetch,
  });
}

describe("sk apps — command surface", () => {
  test("registers list and show, gated by settings:read", () => {
    const cmd = appsCommand as unknown as { subCommands: Record<string, unknown> };
    expect(Object.keys(cmd.subCommands).sort()).toEqual(["list", "show"]);
    expect(SUB_COMMANDS.apps?.requires).toBe("settings:read");
  });
});

describe("sk apps list rows", () => {
  test("columns are app, environment, users, budget today and readiness", () => {
    expect(APP_LIST_COLUMNS).toEqual(["app", "environment", "users", "budget_today", "readiness"]);
  });

  test("a ready app shows its environment, users and today's budget", () => {
    const budgets = new Map([["app", view.budget_today]]);
    expect(appListRows([summary({})], budgets)).toEqual([
      {
        app: "app",
        environment: "prod",
        users: 3,
        budget_today: "2 used · 1 reserved · 4 refused (5 per caller)",
        readiness: "ready",
      },
    ]);
  });

  test("without today's figures the cell shows only the limit", () => {
    expect(appListRows([summary({})])[0]?.budget_today).toBe("5 per caller");
  });

  test("today's budget is read per configured app with a daily limit, and a failed read is skipped", async () => {
    const asked: string[] = [];
    const client = {
      getApp: async (id: string) => {
        asked.push(id);
        if (id === "broken") throw new EngineError(500, { code: "internal" });
        return { ...view, id };
      },
    };
    const budgets = await budgetsToday(client, [
      summary({ id: "app" }),
      summary({ id: "broken" }),
      summary({ id: "orphan", configured: false, settings: null }),
      summary({ id: "unguarded", settings: { ...settings, daily_limit: null } }),
    ]);
    expect(asked.sort()).toEqual(["app", "broken"]);
    expect([...budgets.keys()]).toEqual(["app"]);
  });

  test("an app with failing checks names them", () => {
    const [row] = appListRows([
      summary({ ready: false, failing_checks: ["execution_authority", "credentials"] }),
    ]);
    expect(row?.readiness).toBe("needs attention: execution_authority, credentials");
  });

  test("an app without a products entry reads as not configured", () => {
    const [row] = appListRows([
      summary({
        configured: false,
        ready: false,
        settings: null,
        failing_checks: ["product_configured"],
      }),
    ]);
    expect(row).toMatchObject({
      environment: "—",
      budget_today: "no daily limit",
      readiness: "not configured: product_configured",
    });
  });
});

describe("sk apps show", () => {
  const text = formatAppView(view);

  test("prints every section of the app", () => {
    for (const heading of [
      "Settings",
      "Sign-in (1)",
      "Workflows (1)",
      "Users",
      "Budget today",
      "Readiness",
    ]) {
      expect(text).toContain(`\n${heading}\n`);
    }
    expect(text).toContain("App app — needs attention: execution_authority");
    expect(text).toContain("https://idp.example.test");
    expect(text).toContain("refusals   4");
  });

  test("a failing check carries its next action, and the first one is repeated last", () => {
    expect(text).toContain("FAIL  execution_authority  no live execution authority");
    expect(text).toContain("next: Approve the assistant workflow in Cockpit");
    expect(text).toContain("Next action: Approve the assistant workflow in Cockpit");
    expect(text).toContain("set replaces the whole value");
  });

  test("a ready app says no action is needed", () => {
    const ready = formatAppView({
      ...view,
      ready: true,
      checks: [{ key: "credentials", ok: true, message: "usable", next_action: null }],
    });
    expect(ready).toContain("App app — ready");
    expect(ready).toContain("Next action: none, the app is ready.");
  });
});

describe("sk apps errors", () => {
  test("403 names the missing permission", () => {
    expect(friendlyAppsError(new EngineError(403, { code: "forbidden" }))).toContain(
      "settings:read",
    );
  });

  test("404 on show points to sk apps list", () => {
    expect(friendlyAppsError(new EngineError(404, { code: "not_found" }), "ghost")).toBe(
      'no app "ghost" is visible in this workspace. sk apps list shows the visible ids.',
    );
  });

  test("other failures fall through to the generic reporter", () => {
    expect(friendlyAppsError(new EngineError(500, { code: "internal" }))).toBeNull();
    expect(friendlyAppsError(new Error("boom"))).toBeNull();
  });
});

describe("EngineClient apps methods", () => {
  test("listApps reads GET /v1/apps", async () => {
    const urls: string[] = [];
    const out = await capturingClient({ items: [summary({})] }, urls).listApps();
    expect(urls).toEqual(["http://engine.test/v1/apps"]);
    expect(out.items[0]?.id).toBe("app");
  });

  test("getApp reads GET /v1/apps/{id}", async () => {
    const urls: string[] = [];
    await capturingClient(view, urls).getApp("app");
    expect(urls).toEqual(["http://engine.test/v1/apps/app"]);
  });
});

describe("sk users apps column", () => {
  test("lists each app a user signed in to once, sorted", () => {
    const user = {
      id: "u",
      identities: [
        { provider_id: "b", product_id: "zeta", last_seen_at: "2026-01-10T00:00:00.000Z" },
        { provider_id: "a", product_id: "alpha", last_seen_at: "2026-01-10T00:00:00.000Z" },
        { provider_id: "c", product_id: "alpha", last_seen_at: "2026-01-10T00:00:00.000Z" },
        { provider_id: "d", product_id: null, last_seen_at: "2026-01-10T00:00:00.000Z" },
      ],
    };
    expect(userAppIds(user)).toEqual(["alpha", "zeta"]);
    expect(userListRows([user, { id: "v" }]).map((row) => row.apps)).toEqual(["alpha, zeta", ""]);
  });

  test("the app filter is sent as product_id", async () => {
    expect(userListQuery({ app: "app", limit: "5" })).toEqual({ product_id: "app", limit: 5 });
    expect(userListQuery({})).toEqual({});
    const urls: string[] = [];
    await capturingClient({ items: [] }, urls).listIdentityUsers(userListQuery({ app: "app" }));
    expect(urls).toEqual(["http://engine.test/v1/identity/users?product_id=app"]);
  });
});
