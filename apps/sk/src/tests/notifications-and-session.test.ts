// Push notifications + /session QR (M12 of #159).

import { describe, expect, mock, test } from "bun:test";
import type { SkSessionState } from "@cli-core/index.ts";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { inQuietHoursWindow, notify, shouldNotify } from "../repl/notifications/index.ts";
import { handleSlash, type SlashHandlerContext } from "../repl/slash/handler.ts";

class FakeStream {
  written: string[] = [];
  isTTY = true;
  write(s: string): boolean {
    this.written.push(s);
    return true;
  }
}

describe("notifications — env wiring contract (G3 of #159 M12 follow-up)", () => {
  test("SK_PUSH_NOTIFY=1 turns shouldNotify on at the default threshold", () => {
    // The contract verified here is what ink-app.tsx applyEventStream
    // reads at turn-end. Documented in apps/sk/src/repl/notifications/.
    const prev = process.env.SK_PUSH_NOTIFY;
    try {
      process.env.SK_PUSH_NOTIFY = "1";
      const enabled = process.env.SK_PUSH_NOTIFY === "1";
      expect(enabled).toBe(true);
      expect(shouldNotify(60_000, { enabled, thresholdMs: 30_000 })).toBe(true);
    } finally {
      if (prev !== undefined) process.env.SK_PUSH_NOTIFY = prev;
      else delete process.env.SK_PUSH_NOTIFY;
    }
  });

  test("SK_PUSH_NOTIFY_THRESHOLD_MS overrides the default", () => {
    const prev = process.env.SK_PUSH_NOTIFY_THRESHOLD_MS;
    try {
      process.env.SK_PUSH_NOTIFY_THRESHOLD_MS = "60000";
      const t = Number(process.env.SK_PUSH_NOTIFY_THRESHOLD_MS);
      expect(t).toBe(60_000);
      // 45s elapsed should NOT fire when threshold is 60s.
      expect(shouldNotify(45_000, { enabled: true, thresholdMs: t })).toBe(false);
    } finally {
      if (prev !== undefined) process.env.SK_PUSH_NOTIFY_THRESHOLD_MS = prev;
      else delete process.env.SK_PUSH_NOTIFY_THRESHOLD_MS;
    }
  });
});

describe("notifications — inQuietHoursWindow (H1 closure)", () => {
  test("empty start or end disables the window", () => {
    expect(inQuietHoursWindow("", "08:00", new Date("2026-05-09T03:00:00"))).toBe(false);
    expect(inQuietHoursWindow("22:00", "", new Date("2026-05-09T23:00:00"))).toBe(false);
  });

  test("non-wrapping window (09:00 → 17:00) — inside vs outside", () => {
    expect(inQuietHoursWindow("09:00", "17:00", new Date("2026-05-09T12:30:00"))).toBe(true);
    expect(inQuietHoursWindow("09:00", "17:00", new Date("2026-05-09T08:00:00"))).toBe(false);
    expect(inQuietHoursWindow("09:00", "17:00", new Date("2026-05-09T17:00:00"))).toBe(false);
  });

  test("midnight-wrapping window (22:00 → 08:00)", () => {
    expect(inQuietHoursWindow("22:00", "08:00", new Date("2026-05-09T23:30:00"))).toBe(true);
    expect(inQuietHoursWindow("22:00", "08:00", new Date("2026-05-09T03:00:00"))).toBe(true);
    expect(inQuietHoursWindow("22:00", "08:00", new Date("2026-05-09T12:00:00"))).toBe(false);
  });

  test("malformed strings are treated as 'no window'", () => {
    expect(inQuietHoursWindow("not-a-time", "08:00", new Date())).toBe(false);
    expect(inQuietHoursWindow("25:00", "08:00", new Date())).toBe(false);
    expect(inQuietHoursWindow("09:60", "08:00", new Date())).toBe(false);
  });
});

describe("notifications — shouldNotify (M12)", () => {
  test("suppresses when disabled", () => {
    expect(shouldNotify(60_000, { enabled: false, thresholdMs: 30_000 })).toBe(false);
  });
  test("suppresses below threshold", () => {
    expect(shouldNotify(10_000, { enabled: true, thresholdMs: 30_000 })).toBe(false);
  });
  test("fires above threshold when enabled and not in quiet hours", () => {
    expect(shouldNotify(60_000, { enabled: true, thresholdMs: 30_000 })).toBe(true);
  });
  test("respects quiet hours", () => {
    expect(
      shouldNotify(60_000, {
        enabled: true,
        thresholdMs: 30_000,
        quietHours: () => true,
      }),
    ).toBe(false);
  });
});

describe("notifications — notify writes OSC 9 + BEL (M12)", () => {
  test("emits OSC 9 then BEL on a TTY", () => {
    const s = new FakeStream();
    const ok = notify("subkit", "execution complete", 60_000, {
      enabled: true,
      thresholdMs: 30_000,
      stream: s as unknown as NodeJS.WriteStream,
    });
    expect(ok).toBe(true);
    expect(s.written.join("")).toContain("\x1b]9;subkit — execution complete\x07");
    expect(s.written.join("")).toContain("\x07");
  });

  test("no-op on non-TTY", () => {
    const s = new FakeStream();
    s.isTTY = false;
    const ok = notify("subkit", undefined, 60_000, {
      enabled: true,
      thresholdMs: 30_000,
      stream: s as unknown as NodeJS.WriteStream,
    });
    expect(ok).toBe(false);
    expect(s.written.length).toBe(0);
  });

  test("title-only message has no separator", () => {
    const s = new FakeStream();
    notify("subkit", undefined, 60_000, {
      enabled: true,
      thresholdMs: 30_000,
      stream: s as unknown as NodeJS.WriteStream,
    });
    expect(s.written[0]).toBe("\x1b]9;subkit\x07");
  });
});

function makeCtx(client: EngineClient): SlashHandlerContext {
  return {
    client,
    profile: {
      name: "default",
      engine_url: "http://localhost:3000/",
    } as ResolvedProfile,
    session: {
      conversationId: "conv-1",
      status: "idle",
      messages: [],
      toolCalls: [],
      usage: null,
    } as unknown as SkSessionState,
    setConversationId: () => {},
    allowedPermissions: ["portal_token:read"],
  };
}

describe("/session slash (M12)", () => {
  test("rejects without workflow id (argsSchema validation)", async () => {
    const client = {} as EngineClient;
    const out = await handleSlash("session", [], makeCtx(client));
    expect(out).toContain("/session");
    expect(out).toMatch(/invalid args|usage/);
  });

  test("calls issuePortalToken with the workflow scope and 15-min TTL", async () => {
    const issuePortalToken = mock(async (body: Record<string, unknown>) => ({
      id: "pt-1",
      plaintext_token: "secret-token-123",
      prefix: "pt_",
      expires_at: "2026-05-09T15:00:00Z",
      _body: body,
    }));
    const whoami = mock(async () => ({
      id: "u1",
      kind: "user" as const,
      tenant_id: "t1",
      tenant_slug: "acme",
      email: "u@a.test",
      role_name: "admin",
      provider: "firebase",
    }));
    const client = { issuePortalToken, whoami } as unknown as EngineClient;
    const out = await handleSlash("session", ["wf-7"], makeCtx(client));
    expect(typeof out).toBe("string");
    expect(out).toContain("portal token issued");
    expect(out).toContain("/portal#token=secret-token-123");
    expect(out).toContain("expires at 2026-05-09T15:00:00Z");
    expect(issuePortalToken.mock.calls.length).toBe(1);
    const sent = issuePortalToken.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      user_id: "u1",
      allowed_workflows: ["wf-7"],
      ttl_minutes: 15,
    });
  });

  test("surfaces engine error verbatim", async () => {
    const client = {
      issuePortalToken: mock(async () => {
        throw new Error("forbidden — workflow not found");
      }),
      whoami: mock(async () => ({
        id: "u1",
        kind: "user",
        tenant_id: "t1",
        tenant_slug: "acme",
        email: null,
        role_name: null,
        provider: "firebase",
      })),
    } as unknown as EngineClient;
    const out = await handleSlash("session", ["wf-bad"], makeCtx(client));
    expect(out).toContain("/session failed");
    expect(out).toContain("forbidden");
  });
});
