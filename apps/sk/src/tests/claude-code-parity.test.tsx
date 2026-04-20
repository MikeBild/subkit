import { afterEach, describe, expect, test } from "bun:test";
import type { TurnEvent } from "@cli-core/index.ts";
import { cleanup, render } from "ink-testing-library";
import { InkApp, type InkAppProps } from "../ink-app.tsx";
import type { PersonaProbe } from "../slash.ts";

async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const ev of events) yield ev;
}

function stripAnsi(frame: string): string {
  const ansiPattern = `${String.fromCharCode(27)}\\[[0-9;]*m`;
  return frame.replace(new RegExp(ansiPattern, "g"), "");
}

const ADMIN: PersonaProbe = { allows: () => true };

function defaultProps(overrides: Partial<InkAppProps> = {}): InkAppProps {
  return {
    persona: {
      label: "admin",
      tenant: "acme",
      engineUrl: "http://localhost:8080",
      profileName: "parity",
      probe: ADMIN,
    },
    statusLineConfig: {
      format: "",
      refreshMs: 999_999,
    },
    initialConversationId: null,
    model: "claude-sonnet-4-6",
    cwd: "/tmp/parity",
    onPrompt: async () => ({
      events: framesOf({ type: "completed", status: "active" }),
      conversationId: "c-parity-0000-0000-0000-000000000000",
    }),
    ...overrides,
  };
}

async function tick(ms = 30): Promise<void> {
  // allow-wall-clock: ink's keypress parser needs real ms to
  // disambiguate Esc (\x1b) from the prefix of an arrow key.
  await new Promise((r) => setTimeout(r, ms));
}

async function type(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (const ch of text) {
    instance.stdin.write(ch);
    await new Promise((r) => setImmediate(r));
  }
  await tick(5);
}

async function pressEnter(instance: ReturnType<typeof render>): Promise<void> {
  instance.stdin.write("\r");
  await tick(40);
}

function renderApp(overrides: Partial<InkAppProps> = {}) {
  return render(<InkApp {...defaultProps(overrides)} />);
}

afterEach(() => {
  cleanup();
});

describe("chat-first parity", () => {
  test("first paint shows the compact welcome card, composer, and footer", async () => {
    const instance = renderApp();
    await tick();
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toMatch(/sk[\s·]+v\d+\.\d+\.\d+(?:-[\w.-]+)?/);
    expect(frame).toContain("Resume work, connect a system");
    expect(frame).toContain("❯");
    expect(frame).toContain("session new");
    expect(frame).toContain("ask");
    expect(frame).toContain("chat");
    instance.unmount();
  });

  test("banner disappears after the first assistant turn", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          { type: "message", role: "assistant", content: { text: "ok" } },
          { type: "completed", status: "active" },
        ),
        conversationId: "c-banner-gone",
      }),
    });
    await tick();
    await type(instance, "hi");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("Resume work, connect a system");
    expect(frame).toContain("ok");
    instance.unmount();
  });

  test("Ctrl-O toggles between chat and inspect", async () => {
    const instance = renderApp();
    await tick();
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("chat");
    expect(frame).toContain("ctrl-o inspect");
    instance.stdin.write("\x0f");
    await tick(40);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("inspect");
    expect(frame).toContain("ctrl-o chat");
    instance.unmount();
  });

  test("assistant markdown is rendered without raw emphasis markers", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "message",
            role: "assistant",
            content: { text: "**Ready**\n\n- Connect a system\n- Build a workflow" },
          },
          { type: "completed", status: "active" },
        ),
        conversationId: "c-markdown",
      }),
    });
    await tick();
    await type(instance, "hello");
    await pressEnter(instance);
    await tick(80);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("Ready");
    expect(frame).toContain("Connect a system");
    expect(frame).not.toContain("**Ready**");
    instance.unmount();
  });

  test("footer stays visible after a streamed turn", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          { type: "message", role: "assistant", content: { text: "hello" } },
          { type: "completed", status: "active" },
        ),
        conversationId: "abcd1234-0000-0000-0000-000000000000",
      }),
    });
    await tick();
    await type(instance, "hi");
    await pressEnter(instance);
    await tick(80);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("session abcd1234");
    expect(frame).toContain("chat");
    expect(frame).toContain("❯");
    instance.unmount();
  });
});
