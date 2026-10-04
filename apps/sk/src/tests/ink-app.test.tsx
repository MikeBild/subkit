import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PendingElicitation, TurnEvent } from "@cli-core/index.ts";
import { cleanup, render } from "ink-testing-library";
import { InkApp, type InkAppProps } from "../ink-app.tsx";
import type { PersonaProbe } from "../slash.ts";

let __homeTempDir: string | undefined;
let __originalHome: string | undefined;
beforeAll(() => {
  __homeTempDir = mkdtempSync(join(tmpdir(), "sk-ink-app-home-"));
  __originalHome = process.env.HOME;
  process.env.HOME = __homeTempDir;
});
afterAll(() => {
  if (__originalHome !== undefined) process.env.HOME = __originalHome;
  else delete process.env.HOME;
  if (__homeTempDir) rmSync(__homeTempDir, { recursive: true, force: true });
});

async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const ev of events) yield ev;
}

function stripAnsi(frame: string): string {
  const ansiPattern = `${String.fromCharCode(27)}\\[[0-9;]*m`;
  return frame.replace(new RegExp(ansiPattern, "g"), "");
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

const histDirs: string[] = [];
function tmpHistory(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-ink-hist-"));
  histDirs.push(d);
  return join(d, "history.jsonl");
}

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
    historyPath: tmpHistory(),
    onPrompt: async () => ({
      events: framesOf({ type: "completed", status: "active" }),
      conversationId: "c0-00000000-0000-0000-0000-000000000000",
    }),
    ...overrides,
  };
}

async function tick(ms = 30): Promise<void> {
  // allow-wall-clock: ink's keypress parser needs real ms to
  // disambiguate Esc (\x1b) from the prefix of an arrow key.
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForFrame(
  instance: ReturnType<typeof renderApp>,
  pred: (frame: string) => boolean,
  { maxMs = 2000, stepMs = 20 }: { maxMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + maxMs; // allow-wall-clock: budget is real ms (CI scheduler pressure, not fake time)
  while (Date.now() < deadline) {
    // allow-wall-clock: see comment above
    const frame = instance.lastFrame() ?? "";
    if (pred(frame)) return;
    await new Promise((r) => setTimeout(r, stepMs)); // allow-wall-clock: paced poll; the ink render commit + scheduler yield need real wall time
  }
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
  while (histDirs.length > 0) {
    const d = histDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  }
  if (__homeTempDir) {
    const skDir = join(__homeTempDir, ".sk");
    try {
      rmSync(skDir, { recursive: true, force: true });
    } catch {}
  }
});

describe("ink-app: journey 01 — admin mounts the REPL", () => {
  test("AC1: banner + footer + composer render on first paint", async () => {
    const instance = renderApp();
    await tick();
    const frame = stripAnsi(instance.lastFrame() ?? "");
    expect(frame).toMatch(/sk[\s·]+v\d+\.\d+\.\d+(?:-[\w.-]+)?/);
    expect(frame).toContain("admin");
    expect(frame).toContain("tenant-alpha");
    expect(frame).toContain("localhost:8080");
    expect(frame).toMatch(/❯|⣾|⣽|⣻|⢿|⡿|⣟|⣯|⣷/);
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
    expect(frame).toContain("T=0");
    instance.unmount();
  });

  test("AC3: rotating tip is displayed in the banner", async () => {
    const instance = renderApp();
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/◦|💡/);
    expect(frame).toMatch(
      /@path\/to\/file|SUBKIT\.md|sk -p|\/view inspect|\/compact|\/approve|\/reject|Shift-Tab|\/resume|@workflow/,
    );
    instance.unmount();
  });

  test("AC4: setup warning banner appears once for admin/member personas", async () => {
    const instance = renderApp({
      setupSnapshot: {
        overall_status: "warn",
        summary_counts: {
          blockers: 0,
          warnings: 2,
          sections_blocked: 0,
          sections_warn: 2,
        },
        sections: {
          auth: { title: "Auth", status: "ok", issues: [], recommendations: [], values: [] },
          llm: { title: "LLM", status: "ok", issues: [], recommendations: [], values: [] },
          datastore: {
            title: "Datastore",
            status: "ok",
            issues: [],
            recommendations: [],
            values: [],
          },
          storage: {
            title: "Object storage",
            status: "warn",
            issues: [],
            recommendations: [],
            values: [],
          },
          crypto: { title: "Crypto", status: "ok", issues: [], recommendations: [], values: [] },
          public_urls: {
            title: "Public URLs",
            status: "warn",
            issues: [],
            recommendations: [],
            values: [],
          },
        },
        issues: [],
        recommendations: [],
      },
    });
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("⚠ Setup");
    expect(frame).toContain("2 warnings");
    expect(frame).toContain("/setup");
    instance.unmount();
  });
});

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
    expect(frame).toMatch(/•/);
    expect(frame).toContain("sk");
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
    instance.stdin.write("\x7f");
    await tick(20);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("ab");
    expect(frame).not.toMatch(/sk>\s*abc/);
    instance.unmount();
  });
});

describe("ink-app: journey 03 — tool calls, commit, validation errors", () => {
  test("AC1: inspect view reveals the raw tool trace for a turn", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "tool_call_start",
            call_id: "t1",
            tool: "author_workflow",
            input_partial: { kind: "http" },
          },
          { type: "tool_result", call_id: "t1", tool: "author_workflow", output: { ok: true } },
          { type: "completed", status: "active" },
        ),
        conversationId: "c-tool-1",
      }),
    });
    await tick();
    await type(instance, "do the thing");
    await pressEnter(instance);
    await waitForFrame(instance, (f) => f.includes("author_workflow"));
    let frame = instance.lastFrame() ?? "";
    expect(frame).not.toMatch(/⎿/);
    instance.stdin.write("\x0f");
    await waitForFrame(instance, (f) => /⎿/.test(f));
    frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/⎿/);
    expect(frame).toContain("author_workflow");
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
    expect(frame).toMatch(/❯|⣾|⣽|⣻|⢿|⡿|⣟|⣯|⣷/);
    expect(frame).not.toMatch(/thinking…|planning…|drafting…/);
    instance.unmount();
  });

  test("AC3: validation_error frame renders the panel — copy and tone follow turn status", async () => {
    const activeInstance = renderApp({
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
        conversationId: "c-val-active",
      }),
    });
    await tick();
    await type(activeInstance, "broken");
    await pressEnter(activeInstance);
    await tick(80);
    const activeFrame = activeInstance.lastFrame() ?? "";
    expect(activeFrame).toContain("draft validation");
    expect(activeFrame).not.toMatch(/^validation errors$/m);
    expect(activeFrame).toContain("steps.0.connector_id");
    expect(activeFrame).toContain("required");
    expect(activeFrame).toContain("must start with /");
    activeInstance.unmount();

    const iteratingInstance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "validation_error",
            errors: [{ path: "steps.0.connector_id", message: "required" }],
          },
          {
            type: "tool_call_start",
            call_id: "call-2",
            tool: "author_workflow",
          },
          { type: "completed", status: "active" },
        ),
        conversationId: "c-val-iterating",
      }),
    });
    await tick();
    await type(iteratingInstance, "broken");
    await pressEnter(iteratingInstance);
    await tick(80);
    const iteratingFrame = iteratingInstance.lastFrame() ?? "";
    expect(iteratingFrame).not.toContain("draft validation");
    expect(iteratingFrame).not.toContain("validation errors");
    iteratingInstance.unmount();
  });
});

describe("ink-app: journey 04 — elicitation lifecycle", () => {
  const approvalFrame: TurnEvent = {
    type: "elicit_request",
    elicitation_id: "a1-abcdefab-0000-0000-0000-000000000000",
    tool_name: "ask_user_confirm",
    summary: "commit 2-step workflow",
    input: {
      question: "Commit invoice-digest?",
      kind: "save_workflow_draft",
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

  test("AC1: elicit_request renders the save-workflow-draft router body", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(approvalFrame, {
          type: "completed",
          status: "awaiting_input",
        } as TurnEvent),
        conversationId: "c-appr",
      }),
    });
    await tick();
    await type(instance, "please commit");
    await pressEnter(instance);
    await tick(500);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("Waiting for input: confirmation required");
    expect(frame).toContain("confirm: save_workflow_draft");
    expect(frame).toContain("commit 2-step workflow");
    expect(frame).toContain("invoice-digest");
    expect(frame).toContain("fetch");
    instance.unmount();
  });

  test("AC2: pressing `y` resumes the turn and applies returned events", async () => {
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
        return {
          conversationId: "c-appr-approve",
          events: framesOf(
            {
              type: "tool_result",
              call_id: "commit-1",
              tool: "save_workflow_draft",
              output: { ok: true, data: { workflow_id: "wf-1", slug: "invoice-digest" } },
            },
            { type: "completed", status: "committed" },
          ),
        };
      },
    });
    await tick();
    await type(instance, "please commit");
    await pressEnter(instance);
    await tick(100);
    instance.stdin.write("y");
    let frame = "";
    for (let i = 0; i < 40; i += 1) {
      await tick(50);
      frame = instance.lastFrame() ?? "";
      if (frame.includes("Workflow saved")) break;
    }
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.id).toBe("a1-abcdefab-0000-0000-0000-000000000000");
    expect((decisions[0]!.output as { confirmed: boolean }).confirmed).toBe(true);
    expect(frame).not.toContain("confirm: save_workflow_draft");
    expect(frame).not.toContain("Waiting for input: confirmation required");
    expect(frame).toContain("Workflow saved");
    expect(frame).toContain("invoice-digest");
    instance.unmount();
  });

  test("AC3: Tab-then-type-then-`n` rejects with the typed feedback", async () => {
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
    instance.stdin.write("\t");
    await tick(20);
    for (const ch of "step 1 missing connector_id") {
      instance.stdin.write(ch);
      await tick(5);
    }
    instance.stdin.write("\t");
    await tick(20);
    instance.stdin.write("n");
    await tick(60);
    expect(decisions.length).toBe(1);
    const out = decisions[0]?.output as { confirmed: boolean; feedback?: string };
    expect(out.confirmed).toBe(false);
    expect(out.feedback).toBe("step 1 missing connector_id");
    expect(decisions[0]?.reason).toBeUndefined();
    instance.unmount();
  });
});

describe("ink-app: journey 05 — slash autocomplete and /help", () => {
  test("AC1: typing `/m` shows prefix suggestions in the footer", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/m");
    await tick(30);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("matches");
    expect(frame).toContain("Tab complete");
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

  test("AC3b: absolute-path-shaped input submits as chat text, not a missing file slash", async () => {
    const prompts: string[] = [];
    const instance = renderApp({
      onPrompt: async (text) => {
        prompts.push(text);
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-0000-0000-0000-000000000000",
        };
      },
    });
    await tick();
    await type(instance, "/Users/me/file.md");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(prompts[0]).toBe("/Users/me/file.md");
    expect(frame).not.toContain("/attach");
    expect(frame).not.toContain("unknown slash");
    instance.unmount();
  });

  test("AC3c: ~/path-shaped input falls through as chat text", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "~/notes/file.md");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("unknown slash");
    instance.unmount();
  });

  test("AC3d: real reported case — pasted local path with .md extension submits as chat text", async () => {
    const prompts: string[] = [];
    const instance = renderApp({
      onPrompt: async (text) => {
        prompts.push(text);
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-0000-0000-0000-000000000000",
        };
      },
    });
    await tick();
    await type(instance, "/Users/dev/Documents/specs/OCPP-2.0.1.md");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(prompts[0]).toBe("/Users/dev/Documents/specs/OCPP-2.0.1.md");
    expect(frame).not.toContain("/attach");
    expect(frame).not.toContain("unknown slash");
    instance.unmount();
  });

  test("AC3e: root-level absolute file-looking path is not treated as a slash command", async () => {
    const prompts: string[] = [];
    const instance = renderApp({
      onPrompt: async (text) => {
        prompts.push(text);
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c-0000-0000-0000-000000000000",
        };
      },
    });
    await tick();
    await type(instance, "/report.md");
    await pressEnter(instance);
    const frame = instance.lastFrame() ?? "";
    expect(prompts[0]).toBe("/report.md");
    expect(frame).not.toContain("unknown slash");
    instance.unmount();
  });
});

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
    expect(frame).toContain("/setup");
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
    const paneMatches = frame.match(/╭[\s\S]*?╰[^╰]*?╯/g) ?? [];
    const paneBody = paneMatches.at(-1) ?? "";
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

  test("AC3: enduser does not get a setup startup banner", async () => {
    const instance = renderApp({
      persona: {
        label: "enduser",
        tenant: "tenant-alpha",
        engineUrl: "http://localhost:8080",
        profileName: "journey",
        probe: PERSONAS.enduser,
      },
      setupSnapshot: {
        overall_status: "blocked",
        summary_counts: {
          blockers: 1,
          warnings: 0,
          sections_blocked: 1,
          sections_warn: 0,
        },
        sections: {
          auth: { title: "Auth", status: "ok", issues: [], recommendations: [], values: [] },
          llm: { title: "LLM", status: "blocked", issues: [], recommendations: [], values: [] },
          datastore: {
            title: "Datastore",
            status: "ok",
            issues: [],
            recommendations: [],
            values: [],
          },
          storage: {
            title: "Object storage",
            status: "ok",
            issues: [],
            recommendations: [],
            values: [],
          },
          crypto: { title: "Crypto", status: "ok", issues: [], recommendations: [], values: [] },
          public_urls: {
            title: "Public URLs",
            status: "ok",
            issues: [],
            recommendations: [],
            values: [],
          },
        },
        issues: [],
        recommendations: [],
      },
    });
    await tick();
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("setup blocked");
    instance.unmount();
  });
});

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
    expect(frame).not.toMatch(/\/resume\s+—/);
    expect(frame).not.toMatch(/\/audit\s+—/);
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
    instance.stdin.write("\x03");
    await tick(20);
    expect(exited).toBe(false);
    instance.stdin.write("\x03");
    await tick(30);
    expect(exited).toBe(true);
    instance.unmount();
  });
});

describe("ink-app: journey 10 — onSlash callback dispatch", () => {
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

  test("AC4: /actions launcher filters and dispatches a catalog prompt", async () => {
    let submitted = "";
    const instance = renderApp({
      onPrompt: async (prompt) => {
        submitted = prompt;
        return {
          events: framesOf({ type: "completed", status: "active" }),
          conversationId: "c0-00000000-0000-0000-0000-000000000000",
        };
      },
    });
    await tick();
    await type(instance, "/actions");
    await pressEnter(instance);
    await waitForFrame(instance, (f) => stripAnsi(f).includes("actions"));
    expect(stripAnsi(instance.lastFrame() ?? "")).toContain("actions");
    await type(instance, "diagnose");
    await waitForFrame(instance, (f) => stripAnsi(f).includes("Repair latest failure"));
    expect(stripAnsi(instance.lastFrame() ?? "")).toContain("Repair latest failure");
    await type(instance, "1");
    await waitForFrame(instance, (f) => stripAnsi(f).includes("Diagnose"));
    expect(stripAnsi(instance.lastFrame() ?? "")).toContain("Diagnose");
    expect(submitted).toContain("Diagnose the latest failed workflow execution");
    instance.unmount();
  });
});

describe("ink-app: journey 12 — modal panes", () => {
  test("AC1: /status renders a StatusPane with the host-supplied rows", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "status",
          title: "status",
          subtitle: "journey",
          rows: [
            ["user", "user@example.com"],
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
    expect(frame).toContain("user@example.com");
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
    expect(frame).toContain("sk — slash commands");
    expect(frame).toContain("admin");
    expect(frame).toContain("/clear");
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

  test("AC1d: dedicated context pane renders skill and attachment state", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "context",
          title: "conversation context",
          snapshot: {
            conversation_id: "c1",
            connector_id: null,
            workflow_id: "wf-1",
            draft_mode: "workflow_authoring",
            authoring_mode: "workflow",
            authoring_stage: "workflow_previewed",
            draft_summary: {
              readiness: "ready_to_probe",
              next_action: "Preview before commit.",
              next_required_action: "Preview before commit.",
              next_suggested_tool: "dry_run_workflow",
              missing_fields: [],
              progress_label: "1 workflow step",
              lifecycle_state: "draft_only",
              blocked_by: [],
            },
            active_target: {
              kind: "workflow",
              name: "demo-flow",
              slug: "demo-flow",
              id: "wf-1",
              environment: null,
              lifecycle_state: "draft_only",
            },
            checkpoint_statuses: [],
            stale_checkpoints: [],
            next_required_action: "Preview before commit.",
            persisted_resources: [],
            latest_execution: null,
            latest_diagnosis: null,
            skills: {
              global: [{ id: "sg", title: "global skill" }],
              connector: [],
              workflow: [{ id: "sw", title: "workflow skill" }],
              total: 2,
            },
            messages: { total: 4, last_role: "assistant" },
            tool_calls_total: 3,
            pending_elicitations: 1,
            attachments: {
              total: 1,
              items: [{ slug: "spec", filename: "openapi.yaml", bytes: 1234 }],
            },
            latest_probe: null,
            latest_preview: null,
            workflow_version: { workflow_id: "wf-1", current_version: 3 },
            last_context_budget: {
              cap_tokens: 100000,
              total_tokens: 42000,
              dropped_sections: ["recorded_endpoint_samples"],
              assembled_at: "2026-01-01T00:00:00.000Z",
            },
            grounding_status: null,
          },
        });
        return null;
      },
    });
    await tick();
    await type(instance, "/context");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("conversation context");
    expect(frame).toContain("workflow skill");
    expect(frame).toContain("@attachment:spec");
    expect(frame).toContain("Esc to close");
    instance.unmount();
  });

  test("AC1e: dedicated approval-history pane renders approval rows", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "approval-history",
          title: "approval history",
          items: [
            {
              tool: "ask_user_confirm",
              created_at: "2026-04-19T10:00:00.000Z",
              summary: "Commit the workflow?",
              status: "approved",
            },
          ],
        });
        return null;
      },
    });
    await tick();
    await type(instance, "/approvals");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("approval history");
    expect(frame).toContain("approved");
    expect(frame).toContain("Commit the workflow?");
    instance.unmount();
  });

  test("AC1f: /setup renders the dedicated setup diagnostics pane", async () => {
    const instance = renderApp({
      onSlash: async (_name, _raw, openPane) => {
        openPane({
          kind: "setup-diagnostics",
          title: "setup",
          setup: {
            overall_status: "warn",
            summary_counts: {
              blockers: 0,
              warnings: 1,
              sections_blocked: 0,
              sections_warn: 1,
            },
            sections: {
              auth: { title: "Auth", status: "ok", issues: [], recommendations: [], values: [] },
              llm: { title: "LLM", status: "ok", issues: [], recommendations: [], values: [] },
              datastore: {
                title: "Datastore",
                status: "ok",
                issues: [],
                recommendations: [],
                values: [
                  {
                    key: "DATABASE_URL",
                    value: "postgres://user@db:5432/subkit",
                    status_hint: null,
                  },
                ],
              },
              storage: {
                title: "Object storage",
                status: "ok",
                issues: [],
                recommendations: [],
                values: [],
              },
              crypto: {
                title: "Crypto",
                status: "ok",
                issues: [],
                recommendations: [],
                values: [],
              },
              public_urls: {
                title: "Public URLs",
                status: "warn",
                issues: [
                  {
                    id: "public-base-url",
                    severity: "warning",
                    title: "Public base URL",
                    detail: "PUBLIC_BASE_URL is not set.",
                  },
                ],
                recommendations: ["Set PUBLIC_BASE_URL to the externally reachable engine URL."],
                values: [{ key: "PUBLIC_BASE_URL", value: null, status_hint: "Missing" }],
              },
            },
            issues: [
              {
                id: "public-base-url",
                severity: "warning",
                title: "Public base URL",
                detail: "PUBLIC_BASE_URL is not set.",
              },
            ],
            recommendations: ["Set PUBLIC_BASE_URL to the externally reachable engine URL."],
          },
        });
        return null;
      },
    });
    await tick();
    await type(instance, "/setup");
    await pressEnter(instance);
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("setup");
    expect(frame).toContain("Public URLs");
    expect(frame).toContain("PUBLIC_BASE_URL");
    expect(frame).toContain("Missing");
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
    instance.stdin.write("\r");
    await tick(60);
    expect(selected.current).toBe("c-aaaaaaaa-0000");
    frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("resume conversation");
    instance.unmount();
  });
});

describe("ink-app: journey 13 — Ctrl-R inline history search", () => {
  test("AC1: Ctrl-R opens the inline reverse-i-search above the composer", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf({ type: "completed", status: "active" }),
        conversationId: "c-hs-1",
      }),
    });
    await tick();
    await type(instance, "first prompt");
    await pressEnter(instance);
    await tick(40);
    await type(instance, "second prompt");
    await pressEnter(instance);
    await tick(40);

    instance.stdin.write("\x12");
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("reverse-i-search");
    expect(frame).toMatch(/1 \/ 2/);
    expect(frame).toContain("second prompt");
    instance.unmount();
  });

  test("AC2: Enter in the inline search restores the highlighted prompt", async () => {
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
    instance.stdin.write("\r");
    await tick(60);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("reverse-i-search");
    expect(frame).toContain("hubspot workflow");
    instance.unmount();
  });
});

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
    expect(frame).toContain("no pending approval");
    instance.unmount();
  });

  test("bare-text 'approve' with no pending elicitation is forwarded as a plain prompt (no free-text classification of confirmation words)", async () => {
    let promptCalled = false;
    const instance = renderApp({
      onPrompt: async () => {
        promptCalled = true;
        return {
          events: framesOf({ type: "completed", status: "completed" }),
          conversationId: "c-noop",
        };
      },
      onElicitResponse: async () => {
        throw new Error("should not be called");
      },
    });
    await tick();
    await type(instance, "approve");
    await pressEnter(instance);
    await tick(60);
    expect(promptCalled).toBe(true);
    instance.unmount();
  });

  test("AC1c: a second /approve while the engine is still processing is a no-op", async () => {
    const elicit: PendingElicitation = {
      id: "b1-00000000-0000-0000-0000-000000000000",
      tool_name: "ask_user_confirm",
      summary: "confirm step",
      input: { kind: "generic" },
    };
    let respondCalls = 0;
    const releaseRef: { fn: (() => void) | null } = { fn: null };
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          {
            type: "elicit_request",
            elicitation_id: elicit.id,
            tool_name: elicit.tool_name,
            summary: elicit.summary,
            input: elicit.input,
          },
          { type: "completed", status: "awaiting_input" },
        ),
        conversationId: "c-x",
      }),
      onElicitResponse: async () => {
        respondCalls += 1;
        await new Promise<void>((resolve) => {
          releaseRef.fn = resolve;
        });
        return { events: framesOf({ type: "completed", status: "completed" }) };
      },
    });
    await tick();
    await type(instance, "kick off");
    await pressEnter(instance);
    await tick(80);
    await type(instance, "/approve");
    await pressEnter(instance);
    await tick(20);
    await type(instance, "/approve");
    await pressEnter(instance);
    await tick(20);
    expect(respondCalls).toBe(1);
    releaseRef.fn?.();
    await tick(40);
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
    expect(frame).toContain("confirm: generic");
    expect(frame).toContain("review the change");
    instance.unmount();
  });
});

describe("ink-app: journey 12 — onboarding and transcript controls", () => {
  test("AC1: quick-start actions render on first paint and `2` prefills a connector prompt", async () => {
    const instance = renderApp();
    await tick();
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("start with");
    expect(frame).toContain("Resume recent");
    expect(frame).toContain("Create a connector");
    expect(frame).toContain("Inspect tenant state");
    instance.stdin.write("2");
    await tick(40);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("I want to create a connector.");
    expect(frame).toContain("probe before saving");
    instance.unmount();
  });

  test("AC1b: quick-start action `5` prefills surface-help guidance", async () => {
    const instance = renderApp();
    await tick();
    instance.stdin.write("5");
    await tick(40);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("I want help using sk surfaces");
    expect(frame).toContain("If something is not exposed in this conversation surface");
    instance.unmount();
  });

  test("AC2: background tools stay hidden in chat view and appear in inspect view", async () => {
    const instance = renderApp({
      onPrompt: async () => ({
        events: framesOf(
          { type: "tool_call_start", call_id: "bg-1", tool: "list_workflows" },
          { type: "tool_result", call_id: "bg-1", tool: "list_workflows", output: { ok: true } },
          { type: "tool_call_start", call_id: "bg-2", tool: "search_knowledge" },
          {
            type: "tool_result",
            call_id: "bg-2",
            tool: "search_knowledge",
            output: { ok: true },
          },
          { type: "completed", status: "active" },
        ),
        conversationId: "c-bg",
      }),
    });
    await tick();
    await type(instance, "look around");
    await pressEnter(instance);
    await tick(80);
    let frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("background actions");
    expect(frame).not.toContain("list_workflows");
    instance.stdin.write("\x0f");
    await waitForFrame(instance, (f) => f.includes("background actions"));
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("background actions");
    expect(frame).toContain("list_workflows");
    expect(frame).toContain("searched knowledge");
    instance.unmount();
  });

  test("AC3: Ctrl-O toggles the transcript mode and Esc dismisses sticky errors", async () => {
    const instance = renderApp();
    await tick();
    await type(instance, "/does-not-exist");
    await pressEnter(instance);
    await tick(40);
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("error");
    expect(frame).toContain("unknown slash");
    instance.stdin.write("\x1b");
    await tick(40);
    frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("unknown slash");
    instance.stdin.write("\x0f");
    await tick(40);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("ctrl-o chat");
    expect(frame).toContain("inspect");
    instance.unmount();
  });
});
