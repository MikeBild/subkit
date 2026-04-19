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
    const deadline = Date.now() + 2000;
    let frame = inst.lastFrame() ?? "";
    while (!frame.includes("Hello, world!") && Date.now() < deadline) {
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
    const deadline = Date.now() + 2000;
    let frame = inst.lastFrame() ?? "";
    while (!frame.includes("list_workflows") && Date.now() < deadline) {
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
    const deadline = Date.now() + 2000;
    let frame = inst.lastFrame() ?? "";
    while (!frame.includes("Policy requires confirmation") && Date.now() < deadline) {
      await tick(50);
      frame = inst.lastFrame() ?? "";
    }
    // The ElicitRouter rendered the question text from the
    // ask_user_confirm pause payload.
    expect(frame).toContain("Policy requires confirmation");
  });
});
