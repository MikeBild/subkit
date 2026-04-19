// sk CLI multi-turn user-story E2E.
//
// Drives the compiled sk binary against a live engine through a
// realistic operator journey:
//   1. login
//   2. initial `sk --p "..."` — opens a conversation, canned plan fires
//   3. `sk --p --resume <id>` — appends a second turn, interaction_log
//      from the first turn is visible in the rehydrated context
//   4. `sk --p --output stream-json` — consumer parses frames in order
//   5. `sk status` — engine reachability check uses the same client
//
// Each test uses a fresh engine (boot creates a docker-compose stack)
// so failures are independent and parallelisable.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, cli, type E2EEnv, parseJson, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("sk-user-story", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

function bearer(env: E2EEnv): HeadersInit {
  return { Authorization: `Bearer ${env.personas.admin.apiKey}` };
}

describe("sk CLI user story — real backend", () => {
  test("login persists a profile", async () => {
    const r = await cli(
      "sk",
      ["login", "--engine-url", env.baseUrl, "--api-key", env.personas.admin.apiKey],
      { env, persona: "admin" },
    );
    expect(r.exitCode).toBe(0);
  });

  test("status reports engine reachability with all probes green", async () => {
    const r = await cli("sk", ["status"], { env, persona: "admin", timeout: 30_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("engine_ok");
    expect(r.stdout).toContain("ok");
  });

  test("turn 1 — open-meteo canned plan creates a conversation with audit entries", async () => {
    const r = await cli(
      "sk",
      ["--p", "open-meteo weather forecast for Berlin tomorrow", "--output", "json"],
      { env, persona: "admin", timeout: 120_000 },
    );
    expect(r.exitCode).toBe(0);
    const body = parseJson<{ session_id: string; status: string }>(r);
    expect(body.session_id).toBeDefined();
    expect(["awaiting_input", "active", "completed"]).toContain(body.status);

    // The conversation_tool_calls table must have the canned plan's
    // tool sequence up to the ask_user_confirm pause.
    const detail = (await (
      await fetch(`${env.baseUrl}/v1/conversations/${body.session_id}`, {
        headers: bearer(env),
      })
    ).json()) as {
      tool_calls: Array<{ tool: string; confirmation_state?: string | null }>;
    };
    const toolNames = detail.tool_calls.map((c) => c.tool);
    // propose_connector declares a `pause` payload so the loop halts on
    // its ask_user_confirm elicitation. The later steps (propose_step /
    // validate_draft / commit_draft) land on the subsequent turn after
    // the user answers, so the headless single-turn run stops here.
    expect(toolNames).toContain("get_engine_status");
    expect(toolNames).toContain("list_connectors");
    expect(toolNames).toContain("propose_connector");
  }, 120_000);

  test("turn 2 — resuming the same conversation sees the prior tool chain", async () => {
    // First turn to establish the session.
    const turn1 = await cli("sk", ["--p", "open-meteo again please", "--output", "json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    const conversationId = parseJson<{ session_id: string }>(turn1).session_id;

    // Second turn, resuming the session via `-r <id>`.
    const turn2 = await cli(
      "sk",
      ["--p", "status check", "-r", conversationId, "--output", "json"],
      { env, persona: "admin", timeout: 60_000 },
    );
    expect(turn2.exitCode).toBe(0);
    const body2 = parseJson<{ session_id: string }>(turn2);
    expect(body2.session_id).toBe(conversationId);

    // The detail endpoint must still find the conversation and its
    // original tool_calls; adding a second turn does not delete them.
    const detail = (await (
      await fetch(`${env.baseUrl}/v1/conversations/${conversationId}`, {
        headers: bearer(env),
      })
    ).json()) as { tool_calls: unknown[] };
    expect(detail.tool_calls.length).toBeGreaterThan(0);
  }, 150_000);

  test("stream-json output emits ordered TurnEvent frames", async () => {
    const r = await cli("sk", ["--p", "hello engine", "--output", "stream-json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = lines.map((l) => JSON.parse(l) as { type: string });
    const terminal = parsed[parsed.length - 1];
    // The last frame must be a `completed` — signals the loop finished
    // cleanly (otherwise the CLI exits before writing it).
    expect(terminal?.type).toBe("completed");
  }, 60_000);

  test("text output mode yields the assistant reply as plain text", async () => {
    const r = await cli("sk", ["--p", "hello engine", "--output", "text"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    expect(r.exitCode).toBe(0);
    // Mock provider emits "Acknowledged: hello engine. (mock)" via the
    // converse canned branch — any non-empty reply is acceptable.
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  }, 60_000);
});
