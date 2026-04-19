// End-to-end parity tests — lock the Claude-Code-style look-and-feel
// of the sk REPL while keeping every surface subkit-native (no cwd /
// model chrome, subkit-flavored permission labels, mascot on first
// paint).
//
// Every test mounts <InkApp> via ink-testing-library with stubbed
// callbacks (no network, no SSE). Assertions target stable substrings
// only so cosmetic tweaks do not churn the suite.

import { afterEach, describe, expect, test } from "bun:test";
import type { TurnEvent } from "@cli-core/index.ts";
import { cleanup, render } from "ink-testing-library";
import { InkApp, type InkAppProps } from "../ink-app.tsx";
import { LOGO_ROWS } from "../repl/logo.tsx";
import type { PersonaProbe } from "../slash.ts";

// ---------- Helpers ----------

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
      // Keep the default subkit-native template dormant for these
      // visual tests so the footer dominates the last rows.
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

// ---------- 1. Logo parity ----------

describe("parity: logo", () => {
  test("mascot rows 1-2 appear on first paint", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain((LOGO_ROWS[0] ?? "").trimEnd());
    expect(frame).toContain((LOGO_ROWS[1] ?? "").trimEnd());
    instance.unmount();
  });

  test("meta panel shows `sk · v<semver>`", async () => {
    const instance = renderApp();
    await tick();
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toMatch(/sk[\s·]+v\d+\.\d+\.\d+(?:-[\w.-]+)?/);
    instance.unmount();
  });

  test("meta panel shows persona@tenant", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("admin@acme");
    instance.unmount();
  });

  test("meta panel shows engine url", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("http://localhost:8080");
    instance.unmount();
  });

  test("meta panel shows profile when passed", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("parity");
    instance.unmount();
  });

  test("meta panel does NOT surface cwd or model (subkit is not an IDE)", async () => {
    const instance = renderApp({ cwd: "/tmp/parity", model: "claude-sonnet-4-6" });
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("/tmp/parity");
    // The composer / transcript may still reference the model slug in
    // engine hooks; the meta panel itself must not.
    const [bannerSlice] = frame.split("❯");
    expect(bannerSlice).not.toContain("claude-sonnet-4-6");
    instance.unmount();
  });

  test("banner disappears after the first turn", async () => {
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
    // Banner-specific phrase; should be gone once a message lands.
    expect(frame).not.toContain("subkit conversation CLI");
    instance.unmount();
  });
});

// ---------- 2. Bordered composer ----------

describe("parity: bordered composer", () => {
  test("top rule of `─` is rendered before the prompt", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    const idx = frame.indexOf("❯");
    expect(idx).toBeGreaterThan(0);
    const before = frame.slice(0, idx);
    expect(before).toMatch(/─{8,}/);
    instance.unmount();
  });

  test("bottom rule of `─` is rendered after the prompt", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    const idx = frame.indexOf("❯");
    expect(idx).toBeGreaterThan(0);
    const after = frame.slice(idx);
    expect(after).toMatch(/─{8,}/);
    instance.unmount();
  });

  test("prompt glyph is `❯` when idle", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("❯");
    instance.unmount();
  });

  test("prompt glyph rotates to a spinner frame when busy", async () => {
    const instance = renderApp({
      onPrompt: async () => {
        // Never resolves during this test — keep the REPL busy.
        await new Promise(() => {});
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "never",
        };
      },
    });
    await tick();
    await type(instance, "hang");
    await pressEnter(instance);
    await tick(160);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/⣾|⣽|⣻|⢿|⡿|⣟|⣯|⣷/);
    instance.unmount();
  });

  test("typed input is echoed between the two rules", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "draft a workflow");
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("❯ draft a workflow");
    instance.unmount();
  });
});

// ---------- 3. Footer line 1 — subkit identity ----------

describe("parity: footer line 1 (subkit identity)", () => {
  test("renders persona @ tenant on the left", async () => {
    const instance = renderApp();
    await tick();
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toMatch(/admin\s+@\s+acme/);
    instance.unmount();
  });

  test("renders the engine host without the scheme", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("localhost:8080");
    // Footer line should strip the `http://` scheme.
    const lines = frame.split("\n");
    // The banner also prints the raw engine url — isolate the footer
    // line (it's the one carrying `session …`) to assert the scheme
    // has been stripped there.
    const footerLine = lines.find((l) => l.includes("session") && l.includes("localhost")) ?? "";
    expect(footerLine).not.toContain("http://");
    instance.unmount();
  });

  test("shows `session new` before any turn", async () => {
    const instance = renderApp();
    await tick();
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("session new");
    instance.unmount();
  });

  test("shows short session id after a turn", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf({ type: "completed", status: "active" }),
        conversationId: "abcd1234-0000-0000-0000-000000000000",
      }),
    });
    await tick();
    await type(instance, "hi");
    await pressEnter(instance);
    await tick(60);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("session abcd1234");
    instance.unmount();
  });

  test("no IDE chrome leaks (no filesystem paths, no model slug)", async () => {
    const instance = renderApp({ cwd: "/Users/tester/my-proj", model: "claude-sonnet-4-6" });
    await tick();
    const frame = instance.lastFrame() ?? "";
    const lines = frame.split("\n");
    const footerBlock = lines.slice(-3).join("\n");
    expect(footerBlock).not.toContain("/Users/tester");
    expect(footerBlock).not.toContain("claude-sonnet");
    instance.unmount();
  });

  test("tenant null from persona surfaces as `(no tenant)`", async () => {
    const instance = renderApp({
      persona: {
        label: "admin",
        tenant: null,
        engineUrl: "http://localhost:8080",
        profileName: "parity",
        probe: ADMIN,
      },
    });
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("(no tenant)");
    instance.unmount();
  });
});

// ---------- 4. Footer line 2 — mode + cycle hint ----------

describe("parity: footer line 2 (permission mode)", () => {
  test("default mode is `ask approval`", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("⏵⏵");
    expect(frame).toContain("ask approval");
    expect(frame).toContain("shift+tab mode");
    expect(frame).toContain("ctrl-o compact transcript");
    instance.unmount();
  });

  test("Shift-Tab cycles ask → auto-approve on", async () => {
    const instance = renderApp();
    await tick();
    // Shift-Tab is a reverse-tab escape sequence; ink parses it via
    // useInput's `key.shift` + `key.tab`. `\x1b[Z` is the CSI cue.
    instance.stdin.write("\x1b[Z");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("auto-approve on");
    expect(frame).not.toContain("ask approval");
    instance.unmount();
  });

  test("Shift-Tab twice cycles to `plan mode (read-only)`", async () => {
    const instance = renderApp();
    await tick();
    instance.stdin.write("\x1b[Z");
    await tick(30);
    instance.stdin.write("\x1b[Z");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("plan mode (read-only)");
    instance.unmount();
  });

  test("Shift-Tab three times wraps back to `ask approval`", async () => {
    const instance = renderApp();
    await tick();
    for (let i = 0; i < 3; i++) {
      instance.stdin.write("\x1b[Z");
      await tick(20);
    }
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("ask approval");
    instance.unmount();
  });

  test("cycle hint is always present across all modes", async () => {
    const instance = renderApp();
    await tick();
    for (let i = 0; i < 3; i++) {
      const frame = instance.lastFrame() ?? "";
      expect(frame).toContain("shift+tab mode");
      instance.stdin.write("\x1b[Z");
      await tick(20);
    }
    instance.unmount();
  });

  test("mode label never mixes Claude-Code branding", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toMatch(/bypass permissions/i);
    expect(frame).not.toMatch(/claude code/i);
    instance.unmount();
  });

  test("footer line 2 sits visually below line 1", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    const modeIdx = frame.indexOf("⏵⏵");
    const identityIdx = frame.search(/admin\s+@\s+acme/);
    expect(modeIdx).toBeGreaterThan(identityIdx);
    instance.unmount();
  });
});

// ---------- 5. Integration — existing surfaces keep working ----------

describe("parity: integration with existing journeys", () => {
  test("welcome banner + composer + footer render together on first paint", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    // mascot
    expect(frame).toContain((LOGO_ROWS[0] ?? "").trimEnd());
    // bordered composer
    expect(frame).toContain("❯");
    expect(frame).toMatch(/─{8,}/);
    // footer
    expect(frame).toContain("⏵⏵");
    expect(frame).toContain("ask approval");
    instance.unmount();
  });

  test("footer stays visible after a streamed assistant turn", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          { type: "message", role: "assistant", content: { text: "hello" } },
          { type: "completed", status: "active" },
        ),
        conversationId: "c-after-turn",
      }),
    });
    await tick();
    await type(instance, "hi");
    await pressEnter(instance);
    await tick(80);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("⏵⏵");
    expect(frame).toContain("ask approval");
    // composer frame still drawn
    expect(frame).toContain("❯");
    instance.unmount();
  });

  test("entering a slash command keeps the bordered composer visible", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/hel");
    await tick(30);
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toContain("❯ /hel");
    expect(frame).toMatch(/─{8,}/);
    instance.unmount();
  });

  test("validation errors render above the footer, not on top of it", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "validation_error",
            errors: [{ path: "steps.0", message: "required" }],
          },
          { type: "completed", status: "active" },
        ),
        conversationId: "c-val",
      }),
    });
    await tick();
    await type(instance, "broken");
    await pressEnter(instance);
    await tick(80);
    const frame = instance.lastFrame() ?? "";
    const errIdx = frame.indexOf("validation errors");
    const modeIdx = frame.indexOf("⏵⏵");
    expect(errIdx).toBeGreaterThan(-1);
    expect(modeIdx).toBeGreaterThan(errIdx);
    instance.unmount();
  });

  test("slash suggestions stack below the bordered composer", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/m");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    const composerIdx = frame.indexOf("❯");
    const matchesIdx = frame.indexOf("matches");
    expect(matchesIdx).toBeGreaterThan(composerIdx);
    instance.unmount();
  });

  test("tenant null still paints a complete UI (no crash)", async () => {
    const instance = renderApp({
      persona: {
        label: "admin",
        tenant: null,
        engineUrl: "http://localhost:8080",
        profileName: "parity",
        probe: ADMIN,
      },
    });
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("❯");
    expect(frame).toContain("⏵⏵");
    expect(frame).toContain("(no tenant)");
    instance.unmount();
  });

  test("busy turn keeps the composer frame but swaps the glyph", async () => {
    const instance = renderApp({
      onPrompt: async () => {
        await new Promise(() => {});
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "never",
        };
      },
    });
    await tick();
    await type(instance, "long running");
    await pressEnter(instance);
    await tick(160);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/─{8,}/); // rules still drawn
    expect(frame).toMatch(/⣾|⣽|⣻|⢿|⡿|⣟|⣯|⣷/);
    instance.unmount();
  });
});
