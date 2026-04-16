// E2E user-journey tests for the Ink REPL surface. Mounts
// `<InkApp>` via `ink-testing-library`, drives keystrokes through
// the mock stdin, and asserts on rendered frames. Covers admin,
// member, enduser, and portal-token personas plus every
// user-visible state transition (banner, composer, spinner,
// tool-call panel, approval modal, committed frame, validation
// errors, slash autocomplete, exit flows).
//
// Tests avoid network by passing stubbed `onPrompt` / `onApproval`
// / `onSlash` callbacks — the same shape `ink-repl.ts` builds at
// runtime. Async iterables for the SSE stream are synthesized
// per test via a tiny `framesOf(...)` helper.

import { afterEach, describe, expect, test } from "bun:test";
import type { PendingApproval, TurnEvent } from "@cli-core/index.ts";
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
    expect(frame).toContain("sk v0.0.1");
    expect(frame).toContain("admin");
    expect(frame).toContain("tenant-alpha");
    expect(frame).toContain("http://localhost:8080");
    expect(frame).toContain("sk>");
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
    expect(frame).toContain("T=—");
    instance.unmount();
  });

  test("AC3: rotating tip is displayed in the banner", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    // Banner uses 💡 as the tip prefix; match against any of the
    // six BANNER_TIPS by name so pickTip()'s random choice can't
    // make this flaky.
    expect(frame).toContain("💡");
    expect(frame).toMatch(/Ctrl-T|@path\/to\/file|SUBKIT\.md|sk -p|statusLine|\/compact/);
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
    expect(frame).toContain("assistant");
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
          { type: "tool_call", tool: "propose_step", input: { kind: "http" }, id: "t1" },
          { type: "tool_result", tool: "propose_step", output: { ok: true }, id: "t1" },
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
    expect(frame).toContain("tool calls");
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
    expect(frame).toContain("sk>");
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

describe("ink-app: journey 04 — approval lifecycle", () => {
  const approvalFrame: TurnEvent = {
    type: "approval_request",
    approval_id: "a1-abcdefab-0000-0000-0000-000000000000",
    kind: "commit_draft",
    summary: "commit 2-step workflow",
    diff: {
      name: "invoice-digest",
      slug: "invoice-digest",
      description: "Overnight invoice summarizer",
      steps: [
        { id: "fetch", kind: "request" },
        { id: "summarize", kind: "transform" },
      ],
    },
  };

  test("AC1: approval_request renders the commit-draft router body", async () => {
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
    expect(frame).toContain("approval required");
    expect(frame).toContain("commit_draft");
    expect(frame).toContain("commit 2-step workflow");
    expect(frame).toContain("invoice-digest");
    expect(frame).toContain("steps:");
    expect(frame).toContain("fetch");
    instance.unmount();
  });

  test("AC2: /approve sends the decision to onApproval and clears the modal", async () => {
    const decisions: Array<{ id: string; decision: string; reason?: string }> = [];
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(approvalFrame, {
          type: "completed",
          status: "awaiting_approval" as never,
        } as TurnEvent),
        conversationId: "c-appr-approve",
      }),
      onApproval: async (id, decision, reason) => {
        decisions.push({ id, decision, ...(reason ? { reason } : {}) });
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
    expect(decisions[0]?.decision).toBe("approved");
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("approval required");
    instance.unmount();
  });

  test("AC3: /reject with a reason passes the reason through", async () => {
    const decisions: Array<{ id: string; decision: string; reason?: string }> = [];
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(approvalFrame, {
          type: "completed",
          status: "awaiting_approval" as never,
        } as TurnEvent),
        conversationId: "c-appr-reject",
      }),
      onApproval: async (id, decision, reason) => {
        decisions.push({ id, decision, ...(reason ? { reason } : {}) });
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
    expect(decisions[0]?.decision).toBe("rejected");
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
    expect(frame).toContain("/clear");
    expect(frame).toContain("/compact");
    expect(frame).not.toContain("/skills");
    expect(frame).not.toContain("/audit");
    expect(frame).not.toContain("/approve");
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

  test("AC3: Ctrl-C triggers onExit", async () => {
    let exited = false;
    const instance = renderApp({
      onExit: () => {
        exited = true;
      },
    });
    await tick();
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

// ---------- Journey 11 — Approval hygiene edge cases ----------

describe("ink-app: journey 11 — approval hygiene", () => {
  test("AC1: /approve with no pending approval surfaces `no pending approval`", async () => {
    const instance = renderApp({
      onApproval: async () => {
        throw new Error("should not be called");
      },
    });
    await tick();
    await type(instance, "/approve");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("no pending approval");
    instance.unmount();
  });

  test("AC2: approval modal with an `other` kind falls back to generic body", async () => {
    const other: PendingApproval = {
      id: "a9-00000000-0000-0000-0000-000000000000",
      kind: "other",
      summary: "review the change",
      diff: { note: "freeform" },
      target: null,
    };
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "approval_request",
            approval_id: other.id,
            kind: other.kind,
            summary: other.summary,
            diff: other.diff,
          },
          { type: "completed", status: "awaiting_approval" as never } as TurnEvent,
        ),
        conversationId: "c-other",
      }),
    });
    await tick();
    await type(instance, "review please");
    await pressEnter(instance);
    await tick(100);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("approval required");
    expect(frame).toContain("other");
    expect(frame).toContain("review the change");
    expect(frame).toContain("diff:");
    instance.unmount();
  });
});
