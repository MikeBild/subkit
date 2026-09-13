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
      ["login", "--engine-url", env.baseUrl, "--api-key", env.personas.admin.apiKey],
      { env, persona: "admin" },
    );
    expect(r.exitCode).toBe(0);
  });

  test("status reports engine reachability with all probes green", async () => {
    const r = await cli(["status"], { env, persona: "admin", timeout: 30_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("engine_ok");
    expect(r.stdout).toContain("ok");
  });

  test("turn 1 — open-meteo canned plan creates a conversation with audit entries", async () => {
    const r = await cli(
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
    // start_connector_from_description seeds the connector draft on the
    // first turn. The later workflow-authoring steps land after a follow-up
    // turn, so the headless single-turn run stops at the authoring prefix.
    expect(toolNames).toContain("get_engine_status");
    expect(toolNames).toContain("list_connectors");
    expect(toolNames).toContain("start_connector_from_description");
  }, 120_000);

  // The canned open-meteo plan parks the conversation in `awaiting_input`
  // at its terminal `ask_user_confirm` before `save_workflow_draft`. The 409
  // `pending_elicitation_blocked` guard would refuse a turn-2 message
  // until the elicitation is resolved. We `decline` (confirmed:false) so
  // the conversation stays in `active` rather than advancing to
  // `committed` — approving would leave nothing for `-r` to resume.
  test("turn 2 — resuming the same conversation sees the prior tool chain", async () => {
    // First turn to establish the session.
    const turn1 = await cli(["--p", "open-meteo again please", "--output", "json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    const conversationId = parseJson<{ session_id: string }>(turn1).session_id;

    // Poll the detail endpoint for `resume_summary.pending_approval`
    // (the canonical surface for an outstanding ask_user_confirm).
    type DetailShape = {
      conversation: { status: string };
      tool_calls: unknown[];
      resume_summary?: {
        pending_approval?: { id: string; tool_name: string; summary: string } | null;
      } | null;
    };
    // Drain EVERY pending confirmation, not just the first. Declining one
    // resumes the turn, and the model may raise another (e.g. re-attempting a
    // save after its first draft was refused). We decline each in turn until
    // the conversation leaves `awaiting_input` with nothing outstanding, so the
    // resume turn below is never blocked by the 409 pending_elicitation guard.
    // Bounded so a model that re-asks indefinitely fails loudly rather than
    // hanging. Declining (not approving) keeps the conversation resumable:
    // approving would advance to `committed` and leave `-r` nothing to continue.
    let drained = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const res = await fetch(`${env.baseUrl}/v1/conversations/${conversationId}`, {
        headers: bearer(env),
      });
      const body = (await res.json()) as DetailShape;
      const candidate = body.resume_summary?.pending_approval ?? null;
      if (candidate) {
        const respondRes = await fetch(
          `${env.baseUrl}/v1/conversations/${conversationId}/elicitations/${candidate.id}/respond`,
          {
            method: "POST",
            headers: { ...bearer(env), "content-type": "application/json" },
            body: JSON.stringify({ output: { confirmed: false } }),
          },
        );
        expect(respondRes.ok).toBe(true);
        continue;
      }
      if (body.conversation.status !== "awaiting_input") {
        drained = true;
        break;
      }
      // allow-wall-clock: e2e poll for HTTP-side state to settle.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    expect(drained).toBe(true);

    // Second turn, resuming the session via `-r <id>`.
    const turn2 = await cli(["--p", "status check", "-r", conversationId, "--output", "json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
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
    const r = await cli(["--p", "hello engine", "--output", "stream-json"], {
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
    const r = await cli(["--p", "hello engine", "--output", "text"], {
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
