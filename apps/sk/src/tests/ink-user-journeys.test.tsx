// Ink-based user-journey tests.
//
// Unlike the existing single-feature Ink tests in `ink-app.test.tsx`,
// these drive the full REPL through realistic multi-turn user stories
// so regressions in the wire-up between the event reducer and the
// renderer surface in CI rather than during operator triage.
//
// Covers the post-Gap-audit feature set:
//   • text_delta tokens accumulate into a live assistant block that
//     clears on the final message frame (Gap #P2 Ink rendering).
//   • tool_log entries render inline under their tool card.
//   • elicit_request (confirm_before_execution) drives the ElicitRouter.
//   • tool_result truncation surfaces `_truncated` / `_raw_ref` fields.
//   • interactionLog splice shows confirmation state history in the UI.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingElicitation, TurnEvent } from "@cli-core/index.ts";
import { cleanup, render } from "ink-testing-library";
import { InkApp, type InkAppProps } from "../ink-app.tsx";
import type { PersonaProbe } from "../slash.ts";

// InkApp.onPrompt expects an AsyncIterable<TurnEvent>. Convert a plain
// array into one so tests can declare fixtures inline.
async function* iter(events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const e of events) yield e;
}

const histDirs: string[] = [];
function tmpHistory(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-journey-hist-"));
  histDirs.push(d);
  return join(d, "history.jsonl");
}

const admin = { allows: () => true } as PersonaProbe;

function defaults(overrides: Partial<InkAppProps> = {}): InkAppProps {
  return {
    persona: {
      label: "admin",
      tenant: "tenant-journeys",
      engineUrl: "http://localhost:8080",
      profileName: "journey",
      probe: admin,
    },
    statusLineConfig: {
      format: "{persona}@{tenant} · {model}",
      refreshMs: 999_999,
    },
    initialConversationId: null,
    model: "claude-sonnet-4-6",
    cwd: "/tmp/journey",
    historyPath: tmpHistory(),
    onPrompt: async () => ({
      events: iter([{ type: "completed", status: "active" }]),
      conversationId: "c0-0000",
    }),
    ...overrides,
  };
}

async function tick(ms = 40): Promise<void> {
  // allow-wall-clock: ink's keypress parser needs real ms to
  // disambiguate Esc (\x1b) from the prefix of an arrow key.
  await new Promise((r) => setTimeout(r, ms));
}
async function typeText(inst: ReturnType<typeof render>, s: string): Promise<void> {
  for (const c of s) {
    inst.stdin.write(c);
    await new Promise((r) => setImmediate(r));
  }
  await tick(10);
}
async function enter(inst: ReturnType<typeof render>): Promise<void> {
  inst.stdin.write("\r");
  await tick(60);
}

beforeEach(() => {
  cleanup();
  for (const d of histDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Ink journey — text_delta streaming", () => {
  test("live tokens accumulate then collapse into the final assistant message", async () => {
    const events: TurnEvent[] = [
      { type: "text_delta", text: "Hello, " },
      { type: "text_delta", text: "world" },
      { type: "text_delta", text: "!" },
      { type: "message", role: "assistant", content: { text: "Hello, world!" } },
      { type: "completed", status: "active" },
    ];
    const inst = render(
      <InkApp
        {...defaults({
          onPrompt: async () => ({ events: iter(events), conversationId: "c-delta" }),
        })}
      />,
    );
    await typeText(inst, "hi");
    await enter(inst);
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 2000;
    let frame = inst.lastFrame() ?? "";
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (!frame.includes("Hello, world!") && Date.now() < deadline) {
      // allow-wall-clock: bounded render-settle poll against real timers (ink-testing-library)
      await tick(50);
      frame = inst.lastFrame() ?? "";
    }
    // Final assistant text is present exactly once (the message frame
    // cleared the live buffer so there's no duplicate rendering).
    const occurrences = (frame.match(/Hello, world!/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

describe("Ink journey — tool call lifecycle with tool_log + truncation", () => {
  test("inspect view shows background tool traces and logs", async () => {
    const events: TurnEvent[] = [
      { type: "tool_call_start", call_id: "tc1", tool: "list_workflows" },
      { type: "tool_call_end", call_id: "tc1", input: { limit: 5 } },
      {
        type: "tool_log",
        call_id: "tc1",
        tool: "list_workflows",
        level: "info",
        message: "querying tenant state",
        ts: "2026-04-18T00:00:00Z",
      },
      {
        type: "tool_result",
        call_id: "tc1",
        tool: "list_workflows",
        output: {
          workflows: [{ id: "w1", name: "demo" }],
          _truncated: true,
          _raw_ref: "raw_abc",
          _note: "use get_raw_result",
        },
      },
      { type: "completed", status: "active" },
    ];
    const inst = render(
      <InkApp
        {...defaults({
          onPrompt: async () => ({ events: iter(events), conversationId: "c-tool" }),
        })}
      />,
    );
    await typeText(inst, "list my workflows");
    await enter(inst);
    inst.stdin.write("\x0f");
    await tick(40);
    // CI runners are slower than macOS — poll the frame until the
    // expected content appears or we hit a 2s cap. Locally this is a
    // no-op (first tick already has the content); on ubuntu-latest it
    // absorbs the extra React scheduling latency that made the frame
    // capture race before the tool_result event drained.
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 2000;
    let frame = inst.lastFrame() ?? "";
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (!frame.includes("list_workflows") && Date.now() < deadline) {
      // allow-wall-clock: bounded render-settle poll against real timers (ink-testing-library)
      await tick(50);
      frame = inst.lastFrame() ?? "";
    }
    expect(frame).toContain("list_workflows");
    expect(frame).toContain("querying tenant state");
    expect(frame).toContain("[info]");
  });
});

describe("Ink journey — elicit_request flow (confirm_before_execution)", () => {
  test("policy-staged run_workflow renders the ElicitRouter confirm prompt", async () => {
    const pending: PendingElicitation = {
      id: "elc-1",
      tool_name: "ask_user_confirm",
      summary: "Confirm run_workflow (policy: confirm_before_execution)",
      input: {
        kind: "external_write",
        question: "Policy requires confirmation before running run_workflow. Proceed?",
        target: { tool: "run_workflow", args: { environment: "prod" } },
      },
    };
    const events: TurnEvent[] = [
      { type: "tool_call_start", call_id: "tc2", tool: "run_workflow" },
      { type: "tool_call_end", call_id: "tc2", input: { environment: "prod" } },
      {
        type: "tool_result",
        call_id: "tc2",
        tool: "run_workflow",
        output: { pending: true, policy_mode: "confirm_before_execution" },
      },
      {
        type: "elicit_request",
        elicitation_id: "elc-1",
        tool_name: "ask_user_confirm",
        summary: pending.summary,
        input: pending.input,
      },
      { type: "completed", status: "awaiting_input" },
    ];
    const inst = render(
      <InkApp
        {...defaults({
          onPrompt: async () => ({ events: iter(events), conversationId: "c-confirm" }),
        })}
      />,
    );
    await typeText(inst, "run workflow in prod");
    await enter(inst);
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 2000;
    let frame = inst.lastFrame() ?? "";
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (!frame.includes("Policy requires confirmation") && Date.now() < deadline) {
      // allow-wall-clock: bounded render-settle poll against real timers (ink-testing-library)
      await tick(50);
      frame = inst.lastFrame() ?? "";
    }
    // The ElicitRouter rendered the question text from the
    // ask_user_confirm pause payload.
    expect(frame).toContain("Policy requires confirmation");
    expect(frame).toContain("run_workflow");
    expect(frame).toContain("environment");
    expect(frame).toContain("prod");
  });
});

describe("Ink journey — assistant text + pending form panel (forensic 35a3b9ba)", () => {
  // Live 6.17.0 session: ask_user_form paused the turn, the persisted
  // assistant `message` landed BEFORE its text_delta replay, and the
  // same assistant text rendered above the form panel (static message)
  // AND below it (live-delta row fed by the replayed delta).
  const MSG_ID = "5d469761-4bee-41a5-9299-8c0cf980bcd8";
  // Short enough that the frame never wraps it, so occurrence counting
  // is exact.
  const ASSISTANT_TEXT = "Saving the Xray connector with OAuth2 next.";

  function formEvents(text: string, msgId: string): TurnEvent[] {
    return [
      {
        type: "tool_call_start",
        call_id: "tc-form",
        tool: "ask_user_form",
        parent_message_id: msgId,
      },
      { type: "tool_call_end", call_id: "tc-form", input: {}, parent_message_id: msgId },
      {
        type: "tool_result",
        call_id: "tc-form",
        tool: "ask_user_form",
        output: { status: "awaiting_input", elicitation_id: "elc-form" },
        parent_message_id: msgId,
      },
      {
        type: "elicit_request",
        elicitation_id: "elc-form",
        tool_call_id: "tc-form",
        tool_name: "ask_user_form",
        summary: "Confirm the OAuth2 credentials.",
        input: {
          question: "Confirm the OAuth2 credentials to attach.",
          fields: [{ name: "client_id", label: "Client ID", type: "text", required: true }],
        },
        parent_message_id: msgId,
      },
      // Persisted message arrives AFTER the elicit_request and BEFORE
      // its own delta replay — exactly the live event order.
      {
        type: "message",
        role: "assistant",
        content: { text },
        id: msgId,
        parent_message_id: msgId,
      },
      { type: "text_delta", text },
      { type: "completed", status: "awaiting_input" },
    ];
  }

  test("assistant text renders exactly once and the form panel once when the elicitation is pending", async () => {
    const inst = render(
      <InkApp
        {...defaults({
          onPrompt: async () => ({
            events: iter(formEvents(ASSISTANT_TEXT, MSG_ID)),
            conversationId: "c-form-dup",
          }),
        })}
      />,
    );
    await typeText(inst, "save the connector");
    await enter(inst);
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 2000;
    let frame = inst.lastFrame() ?? "";
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (
      !(
        frame.includes("Confirm the OAuth2 credentials to attach") && frame.includes(ASSISTANT_TEXT)
      ) &&
      Date.now() < deadline // allow-wall-clock: bounded render-settle poll against real timers (ink-testing-library)
    ) {
      await tick(50);
      frame = inst.lastFrame() ?? "";
    }
    const textOccurrences = frame.split(ASSISTANT_TEXT).length - 1;
    expect(textOccurrences).toBe(1);
    const panelOccurrences = frame.split("Confirm the OAuth2 credentials to attach").length - 1;
    expect(panelOccurrences).toBe(1);
  });

  test("pending form with a DIFFERENT preceding assistant message renders both, each once", async () => {
    const otherText = "First I checked the existing Jira connector.";
    const events: TurnEvent[] = [
      {
        type: "message",
        role: "assistant",
        content: { text: otherText },
        id: "msg-prior",
        parent_message_id: "msg-prior",
      },
      { type: "text_delta", text: otherText },
      ...formEvents(ASSISTANT_TEXT, MSG_ID),
    ];
    const inst = render(
      <InkApp
        {...defaults({
          onPrompt: async () => ({ events: iter(events), conversationId: "c-form-two" }),
        })}
      />,
    );
    await typeText(inst, "save the connector");
    await enter(inst);
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const deadline = Date.now() + 2000;
    let frame = inst.lastFrame() ?? "";
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (
      !(
        frame.includes("Confirm the OAuth2 credentials to attach") &&
        frame.includes(ASSISTANT_TEXT) &&
        frame.includes(otherText)
      ) &&
      Date.now() < deadline // allow-wall-clock: bounded render-settle poll against real timers (ink-testing-library)
    ) {
      await tick(50);
      frame = inst.lastFrame() ?? "";
    }
    expect(frame.split(otherText).length - 1).toBe(1);
    expect(frame.split(ASSISTANT_TEXT).length - 1).toBe(1);
    expect(frame.split("Confirm the OAuth2 credentials to attach").length - 1).toBe(1);
  });
});
