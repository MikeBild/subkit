import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChatAdapterRegistry } from "../../../chat/registry.ts";
import { FakeAdapter } from "../../../notifications/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "../../tests/setup.ts";

let ctx: HttpTestServer;
const chatRegistry = new ChatAdapterRegistry();
const slackAdapter = new FakeAdapter();

function auth(): Record<string, string> {
  return { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" };
}

async function send(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${ctx.baseUrl}${path}`, {
    method,
    headers: auth(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Rule = {
  id: string;
  name: string;
  event_pattern: string;
  severity: string;
  target_workspace_id: string;
  target_channel_id: string;
  active: boolean;
};

beforeAll(async () => {
  ctx = await createHttpTestServer("notification-rules-edit", { appOptions: { chatRegistry } });
  chatRegistry.register(
    { tenant_id: ctx.tenantId, platform: "slack", workspace_id: "W_RULE_TEST" },
    slackAdapter,
  );
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("PATCH /v1/notifications/rules/{id}", () => {
  test("a rule's events, urgency and target change in place, and it pauses and resumes", async () => {
    const created = await send("/v1/notifications/rules", "POST", {
      name: "Fehler",
      event_pattern: "execution.failed",
      severity: "error",
      target_workspace_id: "_cli",
      target_channel_id: "_inbox",
    });
    expect(created.status).toBe(201);
    const rule = (await created.json()) as Rule;

    const edited = await send(`/v1/notifications/rules/${rule.id}`, "PATCH", {
      event_pattern: "connector.health_changed",
      severity: "critical",
      target_workspace_id: "T1",
      target_channel_id: "C1",
    });
    expect(edited.status).toBe(200);
    const after = (await edited.json()) as Rule;
    expect(after).toMatchObject({
      id: rule.id,
      name: "Fehler",
      event_pattern: "connector.health_changed",
      severity: "critical",
      target_workspace_id: "T1",
      target_channel_id: "C1",
      active: true,
    });

    const paused = (await (
      await send(`/v1/notifications/rules/${rule.id}`, "PATCH", { active: false })
    ).json()) as Rule;
    expect(paused.active).toBe(false);
    const resumed = (await (
      await send(`/v1/notifications/rules/${rule.id}`, "PATCH", { active: true })
    ).json()) as Rule;
    expect(resumed.active).toBe(true);
    expect(resumed.event_pattern).toBe("connector.health_changed");
  });

  test("an unknown rule is not found", async () => {
    const response = await send(
      "/v1/notifications/rules/00000000-0000-4000-8000-000000000000",
      "PATCH",
      { active: false },
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /v1/notifications/rules/{id}/test", () => {
  test("a test event reaches the registered chat adapter instead of being skipped", async () => {
    const created = await send("/v1/notifications/rules", "POST", {
      name: "Rule test delivery",
      event_pattern: "rule.test.delivery",
      severity: "error",
      target_workspace_id: "W_RULE_TEST",
      target_channel_id: "C_RULE_TEST",
    });
    expect(created.status).toBe(201);
    const rule = (await created.json()) as Rule;

    const tested = await send(`/v1/notifications/rules/${rule.id}/test`, "POST", {
      event_type: "rule.test.delivery",
      severity: "error",
    });
    expect(tested.status).toBe(200);
    const outcome = (await tested.json()) as {
      matched: number;
      delivered: number;
      outcomes: Array<{ rule_id: string; status: string; reason?: string }>;
    };
    expect(outcome.matched).toBe(1);
    expect(outcome.delivered).toBe(1);
    expect(outcome.outcomes).toEqual([
      expect.objectContaining({ rule_id: rule.id, status: "sent" }),
    ]);
    expect(slackAdapter.sends).toHaveLength(1);
    expect(slackAdapter.sends[0]).toMatchObject({
      workspace_id: "W_RULE_TEST",
      channel_id: "C_RULE_TEST",
    });
  });
});
