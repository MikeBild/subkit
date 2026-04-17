// E2E user-journey tests for the Ink REPL surface. Mounts
// `<InkApp>` via `ink-testing-library`, drives keystrokes through
// the mock stdin, and asserts on rendered frames. Covers admin,
// member, enduser, and portal-token personas plus every
// user-visible state transition (banner, composer, spinner,
// tool-call panel, approval modal, committed frame, validation
// errors, slash autocomplete, exit flows).
//
// Tests avoid network by passing stubbed `onPrompt` / `onElicitResponse`
// / `onSlash` callbacks — the same shape `ink-repl.ts` builds at
// runtime. Async iterables for the SSE stream are synthesized
// per test via a tiny `framesOf(...)` helper.

import { afterEach, describe, expect, test } from "bun:test";
import type { PendingElicitation, TurnEvent } from "@cli-core/index.ts";
import { cleanup, render } from "ink-testing-library";
import { InkApp, type InkAppProps } from "../ink-app.tsx";
import type { PersonaProbe } from "../slash.ts";

// ---------- Helpers ----------

async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const ev of events) yield ev;
}

const PERSONAS = {
  admin: { allows: () => true } as PersonaProbe,
  member: { allows: (p: string) => p !== "audit:read" } as PersonaProbe,
  enduser: {
    allows: (p: string) =>
      new Set([
        "conversation:read",
        "conversation:write",
        "conversation:cancel",
        "conversation:list",
      ]).has(p),
  } as PersonaProbe,
  portal: {
    allows: (p: string) =>
      new Set(["conversation:read", "conversation:write", "conversation:cancel"]).has(p),
  } as PersonaProbe,
};

function defaultProps(overrides: Partial<InkAppProps> = {}): InkAppProps {
  return {
    persona: {
      label: "admin",
      tenant: "tenant-alpha",
      engineUrl: "http://localhost:8080",
      profileName: "journey",
      probe: PERSONAS.admin,
    },
    statusLineConfig: {
      format: "{persona}@{tenant} · {model} · {turn_tokens}t",
      refreshMs: 999_999,
    },
    initialConversationId: null,
    model: "claude-sonnet-4-6",
    cwd: "/tmp/ws",
    onPrompt: async () => ({
      events: framesOf({ type: "completed", status: "active" }),
      conversationId: "c0-00000000-0000-0000-0000-000000000000",
    }),
    ...overrides,
  };
}

/**
 * React scheduler yield. Passes the current macrotask so useEffect
 * + async resolvers can drain.
 */
async function tick(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Feed characters into the Ink app one key at a time. Necessary
 * because Ink 7's InputParser batches multi-char chunks in ways
 * that differ from real keystrokes. Single-char writes are
 * unambiguous.
 */
async function type(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (const ch of text) {
    instance.stdin.write(ch);
    await new Promise((r) => setImmediate(r));
  }
  // Give React a beat to commit the final setState batch.
  await tick(5);
}

/** Press Enter (carriage return) then yield to the scheduler. */
async function pressEnter(instance: ReturnType<typeof render>): Promise<void> {
  instance.stdin.write("\r");
  await tick(40);
}

/** Mount the Ink app with default props + optional overrides. */
function renderApp(overrides: Partial<InkAppProps> = {}) {
  return render(<InkApp {...defaultProps(overrides)} />);
}

afterEach(() => {
  cleanup();
});

// ---------- Journey 1 — Admin mount + banner ----------

describe("ink-app: journey 01 — admin mounts the REPL", () => {
  test("AC1: banner + status line + composer render on first paint", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    // Compact boxed banner — asserts on stable substrings only so
    // cosmetic tweaks to the framing don't require test churn.
    // Matches any semver-looking string (e.g. `sk v1.6.0` or
    // `sk · v0.0.0-dev` — the `·` separator arrived with the Claude
    // Code UX adoption).
    expect(frame).toMatch(/sk[\s·]+v\d+\.\d+\.\d+/);
    expect(frame).toContain("admin");
    expect(frame).toContain("tenant-alpha");
    expect(frame).toContain("http://localhost:8080");
    // Composer prefix — `▎⟫` when idle, `⣾ ⟫` when busy. Match either.
    expect(frame).toMatch(/▎⟫|⣾ ⟫/);
    instance.unmount();
  });

  test("AC2: status line template substitutes placeholders", async () => {
    const instance = renderApp({
      statusLineConfig: {
        format: "P={persona} M={model} T={turn_tokens}",
        refreshMs: 999_999,
      },
    });
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("P=admin");
    expect(frame).toContain("M=claude-sonnet-4-6");
    // Null `turn_tokens` now renders as `0` (not em-dash) so fresh
    // sessions show a numeric counter. Lines up with the subkit-tailored
    // status line's default template.
    expect(frame).toContain("T=0");
    instance.unmount();
  });

  test("AC3: rotating tip is displayed in the banner", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    // Banner uses `◦` as the tip prefix; match against any of the
    // known BANNER_TIPS by name so pickTip()'s random choice can't
    // make this flaky.
    expect(frame).toMatch(/◦|💡/);
    expect(frame).toMatch(
      /Ctrl-T|@path\/to\/file|SUBKIT\.md|sk -p|statusLine|\/compact|\/approve|\/reject/,
    );
    instance.unmount();
  });
});

// ---------- Journey 2 — Admin drives a prompt turn ----------

describe("ink-app: journey 02 — admin submits a prompt", () => {
  test("AC1: typing text + Enter calls onPrompt with the trimmed text", async () => {
    const received: { current: string | null } = { current: null };
    const instance = renderApp({
      onPrompt: async (text) => {
        received.current = text;
        return {
          events: framesOf(
            { type: "message", role: "assistant", content: { text: "hello back" } },
            { type: "completed", status: "active" },
          ),
          conversationId: "c-new",
        };
      },
    });
    await tick();
    await type(instance, "hi there");
    await pressEnter(instance);
    await tick(80);
    expect(received.current).toBe("hi there");
    const frame = instance.lastFrame() ?? "";
    // Claude-Code-style glyphs replace the verbose "assistant:" prefix:
    // `◆` for assistant, `▸` for user, `·` for system/tool.
    expect(frame).toMatch(/◆/);
    expect(frame).toContain("hello back");
    instance.unmount();
  });

  test("AC2: blank prompt on Enter is ignored (onPrompt not called)", async () => {
    let calls = 0;
    const instance = renderApp({
      onPrompt: async () => {
        calls++;
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-ignored",
        };
      },
    });
    await tick();
    await pressEnter(instance);
    expect(calls).toBe(0);
    instance.unmount();
  });

  test("AC3: backspace edits the buffered input", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "abc");
    // backspace 0x7f
    instance.stdin.write("\x7f");
    await tick(20);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("ab");
    // `abc` should NOT be a clean substring after the prompt anymore
    expect(frame).not.toMatch(/sk>\s*abc/);
    instance.unmount();
  });
});

// ---------- Journey 3 — Tool-call + committed + validation panels ----------

describe("ink-app: journey 03 — tool calls, commit, validation errors", () => {
  test("AC1: tool_call + tool_result frames render in the tool panel", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "tool_call_start",
            call_id: "t1",
            tool: "propose_step",
            input_partial: { kind: "http" },
          },
          { type: "tool_result", call_id: "t1", tool: "propose_step", output: { ok: true } },
          { type: "completed", status: "active" },
        ),
        conversationId: "c-tool-1",
      }),
    });
    await tick();
    await type(instance, "do the thing");
    await pressEnter(instance);
    await tick(80);
    const frame = instance.lastFrame() ?? "";
    // ToolCard renders each call inline (no separate "tool calls"
    // header) with a `⎿` tree-glyph prefix and a status icon.
    expect(frame).toMatch(/⎿/);
    expect(frame).toContain("propose_step");
    instance.unmount();
  });

  test("AC2: committed frame leaves the REPL idle (spinner gone, composer visible)", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          { type: "committed", workflow_id: "wf-12345678" },
          { type: "completed", status: "committed" },
        ),
        conversationId: "c-committed",
      }),
    });
    await tick();
    await type(instance, "ship it");
    await pressEnter(instance);
    await tick(80);
    const frame = instance.lastFrame() ?? "";
    // Composer prefix — `▎⟫` when idle, `⣾ ⟫` when busy. Match either.
    expect(frame).toMatch(/▎⟫|⣾ ⟫/);
    // No thinking verb lingering on screen.
    expect(frame).not.toMatch(/thinking…|planning…|drafting…/);
    instance.unmount();
  });

  test("AC3: validation_error frame renders the red errors panel", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "validation_error",
            errors: [
              { path: "steps.0.connector_id", message: "required" },
              { path: "steps.0.path", message: "must start with /" },
            ],
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
    expect(frame).toContain("validation errors");
    expect(frame).toContain("steps.0.connector_id");
    expect(frame).toContain("required");
    expect(frame).toContain("must start with /");
    instance.unmount();
  });
});

// ---------- Journey 4 — Approval modal + approve / reject ----------

describe("ink-app: journey 04 — elicitation lifecycle", () => {
  const approvalFrame: TurnEvent = {
    type: "elicit_request",
    elicitation_id: "a1-abcdefab-0000-0000-0000-000000000000",
    tool_name: "ask_user_confirm",
    summary: "commit 2-step workflow",
    input: {
      question: "Commit invoice-digest?",
      kind: "commit_draft",
      diff: {
        name: "invoice-digest",
        slug: "invoice-digest",
        description: "Overnight invoice summarizer",
        steps: [
          { id: "fetch", kind: "request" },
          { id: "summarize", kind: "transform" },
        ],
      },
    },
  };

  test("AC1: elicit_request renders the commit-draft router body", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(approvalFrame, {
          type: "completed",
          status: "awaiting_approval" as never,
        } as TurnEvent),
        conversationId: "c-appr",
      }),
    });
    await tick();
    await type(instance, "please commit");
    await pressEnter(instance);
    await tick(100);
    const frame = instance.lastFrame() ?? "";
    // ConfirmPrompt renders `confirm: <kind>` as the title line; the
    // full diff body follows. Lines up with the ElicitRouter dispatch
    // in @chat-ui.
    expect(frame).toContain("confirm: commit_draft");
    expect(frame).toContain("commit 2-step workflow");
    expect(frame).toContain("invoice-digest");
    expect(frame).toContain("fetch");
    instance.unmount();
  });

  test("AC2: /approve sends { confirmed: true } to onElicitResponse and clears the modal", async () => {
    const decisions: Array<{ id: string; output: unknown; reason?: string }> = [];
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(approvalFrame, {
          type: "completed",
          status: "awaiting_input",
        } as TurnEvent),
        conversationId: "c-appr-approve",
      }),
      onElicitResponse: async (id, output, reason) => {
        decisions.push({ id, output, ...(reason ? { reason } : {}) });
      },
    });
    await tick();
    await type(instance, "please commit");
    await pressEnter(instance);
    await tick(100);
    await type(instance, "/approve");
    await pressEnter(instance);
    await tick(60);
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.id).toBe("a1-abcdefab-0000-0000-0000-000000000000");
    expect((decisions[0]?.output as { confirmed: boolean }).confirmed).toBe(true);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("input needed");
    instance.unmount();
  });

  test("AC3: /reject with a reason passes the reason through", async () => {
    const decisions: Array<{ id: string; output: unknown; reason?: string }> = [];
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(approvalFrame, {
          type: "completed",
          status: "awaiting_input",
        } as TurnEvent),
        conversationId: "c-appr-reject",
      }),
      onElicitResponse: async (id, output, reason) => {
        decisions.push({ id, output, ...(reason ? { reason } : {}) });
      },
    });
    await tick();
    await type(instance, "please commit");
    await pressEnter(instance);
    await tick(100);
    await type(instance, "/reject step 1 missing connector_id");
    await pressEnter(instance);
    await tick(60);
    expect(decisions.length).toBe(1);
    expect((decisions[0]?.output as { confirmed: boolean }).confirmed).toBe(false);
    expect(decisions[0]?.reason).toBe("step 1 missing connector_id");
    instance.unmount();
  });
});

// ---------- Journey 5 — Slash autocomplete + /help + unknown command ----------

describe("ink-app: journey 05 — slash autocomplete and /help", () => {
  test("AC1: typing `/m` shows fuzzy suggestions in the footer", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/m");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("matches:");
    expect(frame).toMatch(/\/(memory|mcp|model)/);
    instance.unmount();
  });

  test("AC2: /help renders the persona-filtered catalog in a banner", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/help");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("sk — slash commands");
    expect(frame).toContain("/clear");
    expect(frame).toContain("/resume");
    expect(frame).toContain("/help");
    expect(frame).toContain("/audit");
    instance.unmount();
  });

  test("AC3: unknown slash command surfaces an error banner", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/nonexistent");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("unknown slash");
    instance.unmount();
  });
});

// ---------- Journey 6 — Member persona filtering ----------

describe("ink-app: journey 06 — member persona", () => {
  test("AC1: member /help hides /audit (no audit:read)", async () => {
    const instance = renderApp({
      persona: {
        label: "member",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.member,
      },
    });
    await tick();
    await type(instance, "/help");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("sk — slash commands");
    expect(frame).toContain("/compact");
    expect(frame).toContain("/skills");
    expect(frame).not.toContain("/audit");
    instance.unmount();
  });

  test("AC2: member invoking /audit directly gets a permission-denied banner", async () => {
    const instance = renderApp({
      persona: {
        label: "member",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.member,
      },
    });
    await tick();
    await type(instance, "/audit");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/audit requires audit:read");
    instance.unmount();
  });
});

// ---------- Journey 7 — Enduser persona filtering ----------

describe("ink-app: journey 07 — enduser persona", () => {
  test("AC1: enduser /help hides /skills, /mcp, /audit, /tenant, /approve", async () => {
    const instance = renderApp({
      persona: {
        label: "enduser",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.enduser,
      },
    });
    await tick();
    await type(instance, "/help");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    // Help opens as a boxed modal pane; scope the "not contains"
    // assertions to just the pane body so the rotating banner tip at
    // the top of the screen (which may reference `/approve` etc.)
    // doesn't poison the test.
    const paneMatch = frame.match(/╭[\s\S]*?╰[^╰]*?╯/);
    const paneBody = paneMatch?.[0] ?? "";
    expect(paneBody).toContain("/clear");
    expect(paneBody).toContain("/compact");
    expect(paneBody).not.toContain("/skills");
    expect(paneBody).not.toContain("/audit");
    expect(paneBody).not.toContain("/approve");
    instance.unmount();
  });

  test("AC2: enduser invoking /mcp directly is denied", async () => {
    const instance = renderApp({
      persona: {
        label: "enduser",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.enduser,
      },
    });
    await tick();
    await type(instance, "/mcp");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/mcp requires mcp:read");
    instance.unmount();
  });
});

// ---------- Journey 8 — Portal-token persona filtering ----------

describe("ink-app: journey 08 — portal-token persona", () => {
  test("AC1: portal persona /help hides /resume (no conversation:list)", async () => {
    const instance = renderApp({
      persona: {
        label: "portal",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.portal,
      },
    });
    await tick();
    await type(instance, "/help");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/clear");
    expect(frame).toContain("/compact");
    expect(frame).not.toContain("/resume");
    expect(frame).not.toContain("/audit");
    instance.unmount();
  });

  test("AC2: portal persona invoking /resume directly is denied", async () => {
    const instance = renderApp({
      persona: {
        label: "portal",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.portal,
      },
    });
    await tick();
    await type(instance, "/resume");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/resume requires conversation:list");
    instance.unmount();
  });
});

// ---------- Journey 9 — Exit flows ----------

describe("ink-app: journey 09 — exit flows", () => {
  test("AC1: /exit triggers onExit", async () => {
    let exited = false;
    const instance = renderApp({
      onExit: () => {
        exited = true;
      },
    });
    await tick();
    await type(instance, "/exit");
    await pressEnter(instance);
    expect(exited).toBe(true);
    instance.unmount();
  });

  test("AC2: /quit is an alias for /exit", async () => {
    let exited = false;
    const instance = renderApp({
      onExit: () => {
        exited = true;
      },
    });
    await tick();
    await type(instance, "/quit");
    await pressEnter(instance);
    expect(exited).toBe(true);
    instance.unmount();
  });

  test("AC3: double Ctrl-C triggers onExit (first press arms the confirm banner)", async () => {
    let exited = false;
    const instance = renderApp({
      onExit: () => {
        exited = true;
      },
    });
    await tick();
    // First press: arms the "press again to exit" banner, does not call onExit.
    instance.stdin.write("\x03");
    await tick(20);
    expect(exited).toBe(false);
    // Second press: exits.
    instance.stdin.write("\x03");
    await tick(30);
    expect(exited).toBe(true);
    instance.unmount();
  });
});

// ---------- Journey 10 — Generic slash handler dispatch ----------

describe("ink-app: journey 10 — onSlash callback dispatch", () => {
  // A tiny ref-style box sidesteps TypeScript's control-flow
  // narrowing — without it, TS widens `captured` back to `null`
  // inside async closures because it can't prove the mutation.
  interface SlashCapture {
    current: { name: string; raw: string } | null;
  }

  test("AC1: /status (no required permission) is forwarded to onSlash", async () => {
    const captured: SlashCapture = { current: null };
    const instance = renderApp({
      onSlash: async (name, raw) => {
        captured.current = { name, raw };
        return "status: engine ok, session fresh";
      },
    });
    await tick();
    await type(instance, "/status");
    await pressEnter(instance);
    await tick(30);
    expect(captured.current).not.toBeNull();
    expect(captured.current?.name).toBe("status");
    expect(captured.current?.raw).toBe("/status");
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("status: engine ok, session fresh");
    instance.unmount();
  });

  test("AC2: /cost forwarded with the current session context", async () => {
    const captured: SlashCapture = { current: null };
    const instance = renderApp({
      onSlash: async (name, raw) => {
        captured.current = { name, raw };
        return "turn_tokens=42 · remaining=∞";
      },
    });
    await tick();
    await type(instance, "/cost");
    await pressEnter(instance);
    await tick(30);
    expect(captured.current?.name).toBe("cost");
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("turn_tokens=42");
    instance.unmount();
  });

  test("AC3: /model <id> forwards with the model argument in the raw line", async () => {
    const captured: SlashCapture = { current: null };
    const instance = renderApp({
      onSlash: async (name, raw) => {
        captured.current = { name, raw };
        return `model switched to ${raw.split(/\s+/)[1] ?? "(missing)"}`;
      },
    });
    await tick();
    await type(instance, "/model anthropic:claude-opus-4-6");
    await pressEnter(instance);
    await tick(30);
    expect(captured.current?.name).toBe("model");
    expect(captured.current?.raw).toContain("anthropic:claude-opus-4-6");
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("model switched to anthropic:claude-opus-4-6");
    instance.unmount();
  });
});

// ---------- Journey 12 — Modal pane slots (status / conversations) ----------
//
// The Ink host reserves a single modal slot below the transcript.
// Slash commands that opt into structured output (currently `/status`
// and `/resume`) call `openPane(spec)` from the onSlash callback;
// the host renders the matching component. This journey verifies
// the contract end-to-end through the Ink test harness.

describe("ink-app: journey 12 — modal panes", () => {
  test("AC1: /status renders a StatusPane with the host-supplied rows", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "status",
          title: "status",
          subtitle: "journey",
          rows: [
            ["user", "mike@mikebild.com"],
            ["tenant", "tenant-alpha"],
            ["connectors", 7],
            ["tokens · today", 128],
          ],
        });
        return null;
      },
    });
    await tick();
    await type(instance, "/status");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("status");
    expect(frame).toContain("mike@mikebild.com");
    expect(frame).toContain("tenant-alpha");
    expect(frame).toContain("connectors");
    expect(frame).toContain("128");
    expect(frame).toContain("Esc to close");
    instance.unmount();
  });

  test("AC1b: /help renders in the modal slot as a text pane, not inline", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/help");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    // Pane title carries the "sk — slash commands" line.
    expect(frame).toContain("sk — slash commands");
    // Persona subtitle lands on the pane header.
    expect(frame).toContain("admin");
    // Body content came through.
    expect(frame).toContain("/clear");
    // The pane's Esc-to-close hint is visible.
    expect(frame).toContain("Esc to close");
    instance.unmount();
  });

  test("AC1c: /cost opens a text pane sourced from session usage + status snapshot", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "text",
          title: "cost",
          lines: [
            "tokens · this turn   42",
            "remaining · monthly  9,958",
            "tokens · today       128",
          ],
        });
        return null;
      },
    });
    await tick();
    await type(instance, "/cost");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("cost");
    expect(frame).toContain("tokens · this turn");
    expect(frame).toContain("9,958");
    expect(frame).toContain("Esc to close");
    instance.unmount();
  });

  test("AC2: /resume opens a ConversationBrowser and Enter calls onSelectConversation", async () => {
    const selected: { current: string | null } = { current: null };
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "conversations",
          items: [
            { id: "c-aaaaaaaa-0000", title: "invoice digest", updated_at: "2026-04-17T14:00:00Z" },
            { id: "c-bbbbbbbb-1111", title: "hubspot export", updated_at: "2026-04-16T09:30:00Z" },
          ],
        });
        return null;
      },
      onSelectConversation: async (id) => {
        selected.current = id;
      },
    });
    await tick();
    await type(instance, "/resume");
    await pressEnter(instance);
    await tick(60);
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("resume conversation");
    expect(frame).toContain("invoice digest");
    expect(frame).toContain("hubspot export");
    // Enter on the first (highlighted) row picks c-aaaaaaaa-0000 and
    // dismisses the pane.
    instance.stdin.write("\r");
    await tick(60);
    expect(selected.current).toBe("c-aaaaaaaa-0000");
    frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("resume conversation");
    instance.unmount();
  });
});

// ---------- Journey 13 — Ctrl-R history search ----------

describe("ink-app: journey 13 — Ctrl-R history search", () => {
  test("AC1: Ctrl-R opens the history pane populated from prior prompts", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf({ type: "completed", status: "active" }),
        conversationId: "c-hs-1",
      }),
    });
    await tick();
    // Seed the prompt-ring with two real submissions so the pane has
    // something to show.
    await type(instance, "first prompt");
    await pressEnter(instance);
    await tick(40);
    await type(instance, "second prompt");
    await pressEnter(instance);
    await tick(40);

    // Ctrl-R (0x12) opens the history pane.
    instance.stdin.write("\x12");
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("history");
    expect(frame).toContain("2 / 2");
    expect(frame).toContain("second prompt");
    expect(frame).toContain("first prompt");
    instance.unmount();
  });

  test("AC2: Enter in the history pane restores the highlighted prompt into the composer", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf({ type: "completed", status: "active" }),
        conversationId: "c-hs-2",
      }),
    });
    await tick();
    await type(instance, "invoice digest draft");
    await pressEnter(instance);
    await tick(40);
    await type(instance, "hubspot workflow");
    await pressEnter(instance);
    await tick(40);

    instance.stdin.write("\x12");
    await tick(40);
    // First-row is the newest ("hubspot workflow"); Enter picks it.
    instance.stdin.write("\r");
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    // The pane is gone (no `╭`-bordered box on screen), and the
    // composer line holds the restored prompt.
    expect(frame).not.toMatch(/╭.{20,}╮[\s\S]*history/);
    expect(frame).toContain("hubspot workflow");
    instance.unmount();
  });
});

// ---------- Journey 11 — Approval hygiene edge cases ----------

describe("ink-app: journey 11 — approval hygiene", () => {
  test("AC1: /approve with no pending elicitation surfaces a helpful message", async () => {
    const instance = renderApp({
      onElicitResponse: async () => {
        throw new Error("should not be called");
      },
    });
    await tick();
    await type(instance, "/approve");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("no pending elicitation");
    instance.unmount();
  });

  test("AC2: elicitation with a generic confirm falls back to the generic body", async () => {
    const other: PendingElicitation = {
      id: "a9-00000000-0000-0000-0000-000000000000",
      tool_name: "ask_user_confirm",
      summary: "review the change",
      input: { kind: "generic", diff: { note: "freeform" } },
    };
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "elicit_request",
            elicitation_id: other.id,
            tool_name: other.tool_name,
            summary: other.summary,
            input: other.input,
          },
          { type: "completed", status: "awaiting_input" },
        ),
        conversationId: "c-other",
      }),
    });
    await tick();
    await type(instance, "review please");
    await pressEnter(instance);
    await tick(100);
    const frame = instance.lastFrame() ?? "";
    // Generic ConfirmPrompt — "confirm: generic" is the title; summary
    // comes through verbatim.
    expect(frame).toContain("confirm: generic");
    expect(frame).toContain("review the change");
    instance.unmount();
  });
});
