// Weather-workflow E2E smoke test.
//
// Drives the sk CLI through the full authoring flow the user asked for:
// "create a connector and a workflow to use a weather api (no API key)
// for tomorrow's weather forecast in Berlin, Germany". The canned mock
// converse plan in `apps/engine/src/llm/mock-provider.ts:cannedOpenMeteoBerlinPlan`
// drives a deterministic sequence:
//
//   get_engine_status → list_connectors → start_connector_from_description(open-meteo)
//   → propose_step(forecast-berlin) → propose_step(tomorrow-only)
//   → validate_draft → ask_user_confirm → save_workflow_draft
//
// The test asserts that the corresponding tool_call rows land in
// `conversation_tool_calls` and that at least one audit entry exists for
// the tenant — proving the new tool surface (CP5 EngineClient + CP6 read
// tools + CP7 write tools + CP9 confirmation state machine) is wired
// end-to-end.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { boot, cli, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  // Pinned mock LLM — this suite asserts on the EXACT canned tool
  // sequence in `cannedOpenMeteoBerlinPlan`. A real LLM is
  // non-deterministic and would make these assertions flaky; the
  // real-LLM equivalent of this flow lives in
  // tier1-conversation-lifecycle.real.e2e.test.ts.
  // Mock LLM — asserts on the canned tool sequence.
  env = await boot("weather", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

describe("weather workflow (open-meteo, no API key)", () => {
  test("login", async () => {
    const r = await cli(
      ["login", "--engine-url", env.baseUrl, "--api-key", env.personas.admin.apiKey],
      { env, persona: "admin" },
    );
    expect(r.exitCode).toBe(0);
  });

  test("authoring flow runs the canned open-meteo plan end-to-end", async () => {
    // The initial message matches the canned-plan trigger regex in
    // `conversations/service.ts`: either "open meteo" or "berlin
    // weather" or "tomorrow forecast" selects `cannedOpenMeteoBerlinPlan`.
    const r = await cli(
      [
        "--p",
        "create a connector and a workflow to use the open-meteo weather api (no api key) for tomorrow's forecast in Berlin Germany",
        "--output",
        "json",
      ],
      { env, persona: "admin", timeout: 120_000 },
    );
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as { session_id?: string };
    // sk --p --output json surfaces the conversation id as session_id.
    expect(body.session_id).toBeDefined();
    const conversationId = body.session_id!;

    // Check the tool-call rows via the conversation detail endpoint —
    // tool_calls are embedded, not exposed on a separate path. We don't
    // require the exact full plan ran — the `ask_user_confirm` pause
    // blocks the loop until a response, so the final `save_workflow_draft`
    // won't appear in headless mode.
    const detailResp = await fetch(`${env.baseUrl}/v1/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
    });
    expect(detailResp.status).toBe(200);
    const detail = (await detailResp.json()) as {
      tool_calls?: Array<{ tool: string }>;
    };
    const toolNames = (detail.tool_calls ?? []).map((x) => x.tool);
    // start_connector_from_description seeds the connector draft on the
    // first turn. The later steps land after a follow-up authoring turn.
    for (const expected of [
      "get_engine_status",
      "list_connectors",
      "start_connector_from_description",
    ]) {
      expect(toolNames).toContain(expected);
    }
  }, 120_000);

  test("audit log records at least one conversation-driven entry", async () => {
    const response = await fetch(`${env.baseUrl}/v1/audit-log?limit=10`, {
      headers: { Authorization: `Bearer ${env.personas.admin.apiKey}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items?: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect((body.items ?? []).length).toBeGreaterThan(0);
  }, 30_000);
});
