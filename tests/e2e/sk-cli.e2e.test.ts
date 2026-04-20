// E2E test suite for the `sk` CLI.
//
// Exercises headless mode, conversation continuation, output formats,
// and profile management against a real engine.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, cli, type E2EEnv, expectSuccess, run, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("sk-cli", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

// ---------------------------------------------------------------------------
// login + status
// ---------------------------------------------------------------------------
describe("login + status", () => {
  test("login with --api-key stores profile", async () => {
    const result = await cli(
      ["login", "--engine-url", env.baseUrl, "--api-key", env.personas.admin.apiKey],
      { env, persona: "admin" },
    );
    expectSuccess(result, "sk login");
    expect(result.stdout).toContain("saved");
  });

  test("status shows engine reachability", async () => {
    const out = await run(["status"], { env, persona: "admin" });
    expect(out).toContain("engine_ok");
    expect(out).toContain("ok");
  });
});

// ---------------------------------------------------------------------------
// headless mode (--p)
// ---------------------------------------------------------------------------
describe("headless mode", () => {
  test("--output text returns plain text", async () => {
    const out = await run(["--p", "what is 2+2? reply with just the number", "--output", "text"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    // Mock provider returns "Acknowledged: [conv:...] what is 2+2..."
    expect(out.trim().length).toBeGreaterThan(0);
  });

  test("--output json returns structured JSON", async () => {
    const result = await cli(["--p", "say hello", "--output", "json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    expectSuccess(result, "sk --p json");
    const data = JSON.parse(result.stdout) as {
      session_id: string;
      status: string;
      assistant_text: string;
      messages: unknown[];
      usage: unknown;
    };
    expect(data.session_id).toBeTruthy();
    expect(data.status).toBe("completed");
    expect(data.assistant_text.length).toBeGreaterThan(0);
    expect(data.messages.length).toBeGreaterThanOrEqual(2); // user + assistant
  });

  test("--output stream-json emits one event per line", async () => {
    const result = await cli(["--p", "ping", "--output", "stream-json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    expectSuccess(result, "sk --p stream-json");
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // Each line should be valid JSON.
    for (const line of lines) {
      const ev = JSON.parse(line) as { type: string };
      expect(typeof ev.type).toBe("string");
    }
    // Should contain a "completed" event.
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain("completed");
  });
});

// ---------------------------------------------------------------------------
// conversation continuation (--r)
// ---------------------------------------------------------------------------
describe("conversation continuation", () => {
  let sessionId: string;

  test("first turn creates a session", async () => {
    const result = await cli(
      ["--p", "remember: the secret word is pineapple", "--output", "json"],
      { env, persona: "admin", timeout: 60_000 },
    );
    expectSuccess(result, "sk first turn");
    const data = JSON.parse(result.stdout) as { session_id: string };
    sessionId = data.session_id;
    expect(sessionId).toBeTruthy();
  });

  test("--r resumes the session with history", async () => {
    if (!sessionId) return;
    const result = await cli(
      ["--r", sessionId, "--p", "what is the secret word?", "--output", "json"],
      { env, persona: "admin", timeout: 60_000 },
    );
    expectSuccess(result, "sk --r continuation");
    const data = JSON.parse(result.stdout) as {
      session_id: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(data.session_id).toBe(sessionId);
    // Should have 4 messages: user1, assistant1, user2, assistant2.
    expect(data.messages.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// tenants
// ---------------------------------------------------------------------------
describe("tenants", () => {
  test("lists current tenant", async () => {
    const out = await run(["tenants"], { env, persona: "admin" });
    expect(out.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// profile management
// ---------------------------------------------------------------------------
describe("profile", () => {
  test("profile list shows saved profiles", async () => {
    // First login to create a profile.
    await cli(["login", "--engine-url", env.baseUrl, "--api-key", env.personas.member.apiKey], {
      env,
      persona: "member",
    });

    const out = await run(["profile", "list"], { env, persona: "member" });
    expect(out).toContain("default");
  });
});
