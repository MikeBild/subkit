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
      [
        "--p",
        "Create a connector for open-meteo weather forecast for Berlin tomorrow",
        "--output",
        "json",
      ],
      { env, persona: "admin", timeout: 120_000 },
    );
    expect(r.exitCode).toBe(0);
    const body = parseJson<{ session_id: string; status: string }>(r);
    expect(body.session_id).toBeDefined();
    expect(["awaiting_input", "active", "completed"]).toContain(body.status);

    const detail = (await (
      await fetch(`${env.baseUrl}/v1/conversations/${body.session_id}`, {
        headers: bearer(env),
      })
    ).json()) as {
      tool_calls: Array<{ tool: string; confirmation_state?: string | null }>;
    };
    const toolNames = detail.tool_calls.map((c) => c.tool);
    expect(toolNames).toContain("get_engine_status");
    expect(toolNames).toContain("list_connectors");
    expect(toolNames).toContain("start_connector_from_description");
  }, 120_000);

  test("turn 2 — resuming the same conversation sees the prior tool chain", async () => {
    const turn1 = await cli(["--p", "Create a connector for open-meteo", "--output", "json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    const conversationId = parseJson<{ session_id: string }>(turn1).session_id;

    type DetailShape = {
      conversation: { status: string };
      tool_calls: unknown[];
      resume_summary?: {
        pending_approval?: { id: string; tool_name: string; summary: string } | null;
      } | null;
    };
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

    const turn2 = await cli(["--p", "status check", "-r", conversationId, "--output", "json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    expect(turn2.exitCode).toBe(0);
    const body2 = parseJson<{ session_id: string }>(turn2);
    expect(body2.session_id).toBe(conversationId);

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
    expect(terminal?.type).toBe("completed");
  }, 60_000);

  test("text output mode yields the assistant reply as plain text", async () => {
    const r = await cli(["--p", "hello engine", "--output", "text"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  }, 60_000);
});
