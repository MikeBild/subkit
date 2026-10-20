import { afterEach, describe, expect, test } from "bun:test";
import type { TurnEvent } from "@cli-core/index.ts";
import { cleanup, render } from "ink-testing-library";
import type { ConversationDetail } from "./engine-client.ts";
import { hydrateConversation } from "./ink-app/hydrate-conversation.ts";
import { InkApp, type InkAppProps } from "./ink-app.tsx";
import type { PersonaProbe } from "./slash.ts";

async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const event of events) yield event;
}

const persona = { allows: () => true } as PersonaProbe;

function props(overrides: Partial<InkAppProps> = {}): InkAppProps {
  return {
    persona: {
      label: "admin",
      tenant: "tenant-alpha",
      engineUrl: "http://localhost:8080",
      profileName: "default",
      probe: persona,
    },
    initialConversationId: "conversation-old",
    sessionVersion: 0,
    onPrompt: async () => ({
      events: framesOf(
        { type: "message", role: "assistant", content: { text: "old reply" } },
        { type: "completed", status: "active" },
      ),
      conversationId: "conversation-old",
    }),
    ...overrides,
  };
}

async function tick(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms)); // allow-wall-clock: Ink input parsing and render commits use real timers
}

async function type(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (const char of text) instance.stdin.write(char);
  await tick();
}

async function waitForFrame(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 50 && !instance.lastFrame()?.includes(text); attempt++) {
    await tick(20);
  }
  expect(instance.lastFrame()).toContain(text);
}

afterEach(() => cleanup());

describe("Ink REPL lifecycle", () => {
  test("hydrates a resumed pending confirmation and dispatches its answer", async () => {
    const detail = {
      conversation: { id: "conversation-pending", status: "awaiting_input" },
      messages: [
        {
          id: "assistant-message",
          role: "assistant",
          parts: [{ type: "text", text: "Ready to save." }],
          created_at: "2026-10-11T08:00:00.000Z",
        },
      ],
      tool_calls: [
        {
          id: "tool-call",
          tool: "save_workflow_draft",
          input: {},
          output: null,
          outcome: "pending",
          parent_message_id: "assistant-message",
        },
      ],
      draft: null,
      resume_summary: {
        pending_approval: {
          id: "elicitation-id",
          tool_call_id: "tool-call",
          tool_name: "ask_user_confirm",
          summary: "Save the draft?",
          prompt: { question: "Should I save this draft?" },
        },
      },
    } as unknown as ConversationDetail;
    const decisions: Array<{ id: string; output: unknown }> = [];
    const session = hydrateConversation(detail);
    const instance = render(
      <InkApp
        {...props({ initialConversationId: "conversation-pending", initialSession: session })}
        onElicitResponse={async (id, output) => {
          decisions.push({ id, output });
          return { events: framesOf({ type: "completed", status: "completed" }) };
        }}
      />,
    );
    await tick();
    expect(instance.lastFrame()).toContain("Should I save this draft?");
    instance.stdin.write("y");
    await tick(80);
    expect(decisions).toEqual([{ id: "elicitation-id", output: { confirmed: true } }]);
  });

  test("shows a profile switch notice after the new Ink session mounts", async () => {
    const instance = render(
      <InkApp
        {...props({
          initialConversationId: null,
          profileNotice: { version: 1, message: 'switched to "member"' },
        })}
      />,
    );
    await tick();
    expect(instance.lastFrame()).toContain('switched to "member"');
  });

  test("resets the visible session when the conversation target changes", async () => {
    const initial = props();
    const instance = render(<InkApp key="session-0" {...initial} />);
    await tick();
    await type(instance, "old prompt");
    instance.stdin.write("\r");
    await tick(80);
    expect(instance.lastFrame()).toContain("old reply");

    const resumed = props({
      initialConversationId: "conversation-new",
      sessionVersion: 1,
      onPrompt: async () => ({
        events: framesOf(
          { type: "message", role: "assistant", content: { text: "new reply" } },
          { type: "completed", status: "active" },
        ),
        conversationId: "conversation-new",
      }),
    });
    instance.rerender(<InkApp key="session-1" {...resumed} />);
    await tick();
    expect(instance.lastFrame()).not.toContain("old reply");

    await type(instance, "new prompt");
    instance.stdin.write("\r");
    await waitForFrame(instance, "new reply");
    expect(instance.lastFrame()).not.toContain("old reply");
  });

  test("shows a briefing status received after startup", async () => {
    const initial = props({ initialConversationId: null });
    const instance = render(<InkApp {...initial} />);
    await tick();
    instance.rerender(
      <InkApp {...props({ initialConversationId: null, initialContextStatus: "✓ SubKit" })} />,
    );
    await tick();
    expect(instance.lastFrame()).toContain("✓ SubKit");
  });
});
