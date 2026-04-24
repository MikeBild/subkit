// User story: As a REPL user, every REST-backed slash command
// (/compact, /resume, /model, /skills, /mcp, /permissions,
// /audit, /clear, /new, /status, /cost) actually hits the engine
// and returns a readable banner line. This is the shared
// `handleSlash` handler's contract test — if it breaks, both the
// Ink and readline REPLs break at once.
//
// Acceptance criteria:
//
//   AC1. /status reports the active profile + session.
//   AC2. /clear resets the session id via setConversationId(null).
//   AC3. /compact on an active session calls the engine's compact
//        endpoint and surfaces `compacted N message(s)`.
//   AC4. /model <id> calls PATCH /v1/conversations/:id with the new
//        model and reports `model switched to <id>`.
//   AC5. /resume without an active session attaches to the most
//        recent owner=me conversation.
//   AC6. /skills returns the seeded skills list.
//   AC7. /mcp returns populated prompts + resources + tools.
//   AC8. /permissions lists the allowedPermissions array.
//   AC9. /audit with admin perms returns a non-empty list of rows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { initialSessionState, type SkSessionState } from "@cli-core/index.ts";
import type { ResolvedProfile } from "../../../../sk/src/config.ts";
import { EngineClient } from "../../../../sk/src/engine-client.ts";
import { handleSlash } from "../../../../sk/src/repl/slash-handler.ts";
import * as conversationsSvc from "../../conversations/service.ts";
import { skills } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;
let client: EngineClient;
let profile: ResolvedProfile;
let session: SkSessionState;

function setConversationId(id: string | null): void {
  session = initialSessionState(id);
}

const ALLOWED = [
  "conversation:read",
  "conversation:write",
  "conversation:approve",
  "conversation:cancel",
  "conversation:list",
  "memory:write",
  "mcp:read",
  "skill:read",
  "audit:read",
  "identity:read",
];

function slashCtx() {
  return {
    client,
    profile,
    session,
    setConversationId,
    allowedPermissions: ALLOWED,
  };
}

describe("journey: sk-cli slash handler", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-14-slash");
    profile = {
      name: "journey",
      engine_url: ctx.baseUrl,
      api_key: ctx.apiKey,
      active_tenant_id: ctx.tenantId,
      persona_hint: "admin",
    };
    client = new EngineClient({
      engine_url: profile.engine_url,
      api_key: profile.api_key,
      tenant: profile.active_tenant_id,
      user_agent: "sk-cli/0.0.1 (test)",
    });

    // Seed one skill so /skills + /mcp prompts return non-empty.
    await ctx.db.insert(skills).values({
      tenant_id: ctx.tenantId,
      scope: "global",
      title: "Prefer list-users response shapes",
      body: "Keep list responses under 100 rows per page.",
      lifecycle: "active",
      version: 1,
    });

    session = initialSessionState(null);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  test("AC1: /status reports profile + persona + session (multi-line when no openPane host)", async () => {
    const line = await handleSlash("status", [], slashCtx());
    expect(line).not.toBeNull();
    // The readline-fallback format is `<label>  <value>` — assert
    // each field survives on its own line.
    expect(line).toMatch(/profile\s+journey/);
    expect(line).toMatch(/persona\s+admin/);
    expect(line).toMatch(/engine\s+http/);
    expect(line).toMatch(/tenant/);
  });

  test("AC1b: /status in an Ink host opens a StatusPane via openPane", async () => {
    // When the host supplies `openPane`, /status delegates rendering
    // to the modal slot and returns null (no inline banner).
    const opened: Array<Parameters<NonNullable<Parameters<typeof handleSlash>[2]["openPane"]>>[0]> =
      [];
    const line = await handleSlash("status", [], {
      ...slashCtx(),
      openPane: (spec) => opened.push(spec),
    });
    expect(line).toBeNull();
    expect(opened.length).toBe(1);
    const spec = opened[0];
    if (spec?.kind !== "status") throw new Error("expected status pane");
    const labels = spec.rows.map(([label]) => label);
    expect(labels).toContain("profile");
    expect(labels).toContain("persona");
    expect(labels).toContain("engine");
    expect(labels).toContain("tenant");
  });

  test("AC2: /clear resets the session id", async () => {
    setConversationId("fake-id");
    const line = await handleSlash("clear", [], slashCtx());
    expect(line).toBe("session cleared");
    expect(session.conversationId).toBeNull();
  });

  test("AC3: /compact on an active session calls the engine and reports the count", async () => {
    // Create a conversation with a couple messages first.
    const outcome = await conversationsSvc.createConversation(
      {
        tenant_id: ctx.tenantId,
        actor_id: ctx.userId,
        initial_message: "list users",
      },
      ctx.db,
    );
    setConversationId(outcome.conversation.id);
    const line = await handleSlash("compact", [], slashCtx());
    // Readline-fallback body: "compact" title + blank + "collapsed N
    // message(s)" + summary. The Ink host opens it as a modal pane;
    // the banner form is checked here since the test ctx doesn't
    // supply `openPane`.
    expect(line).toMatch(/collapsed \d+ message/);
  });

  test("AC4: /model <id> patches the conversation and reports the switch", async () => {
    const outcome = await conversationsSvc.createConversation(
      { tenant_id: ctx.tenantId, actor_id: ctx.userId },
      ctx.db,
    );
    setConversationId(outcome.conversation.id);
    const line = await handleSlash("model", ["anthropic:claude-opus-4-6"], slashCtx());
    expect(line).toBe("model switched to anthropic:claude-opus-4-6");
  });

  test("AC5: /resume without an active session attaches to the most recent", async () => {
    setConversationId(null);
    const line = await handleSlash("resume", [], slashCtx());
    expect(typeof line).toBe("string");
    expect(session.conversationId).not.toBeNull();
  });

  test("AC6: /skills lists seeded skills", async () => {
    const line = await handleSlash("skills", [], slashCtx());
    expect(line).toContain("Prefer list-users response shapes");
  });

  test("AC7: /mcp renders prompts / resources / callable entries sections", async () => {
    const line = await handleSlash("mcp", [], slashCtx());
    expect(line).toContain("prompts (");
    expect(line).toContain("resources (");
    expect(line).toContain("callable entries (");
    // the seeded skill shows up as an MCP prompt entry
    expect(line).toContain("/mcp__skill.");
  });

  test("AC8: /permissions lists the granted permissions", async () => {
    const line = await handleSlash("permissions", [], slashCtx());
    // Banner form: "permissions" header + blank line + "  <permission>"
    // rows. The "granted" count arrives via the pane's subtitle when
    // an Ink host supplies `openPane`.
    expect(line).toContain("permissions");
    for (const p of ALLOWED) expect(line).toContain(p);
  });

  test("AC9: /audit tails the audit log for an admin", async () => {
    const line = await handleSlash("audit", [], slashCtx());
    // Admin has visibility; lines carry `<ts> <action> <rid>`.
    expect(line).not.toBe("no audit rows visible to this principal");
    expect(typeof line).toBe("string");
    expect((line as string).split("\n").length).toBeGreaterThan(0);
  });
});
