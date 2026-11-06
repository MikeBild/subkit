import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@cli-core/index.ts";
import { cleanup } from "ink-testing-library";
import {
  framesOf,
  histDirs,
  pressEnter,
  renderApp,
  stripAnsi,
  tick,
  type,
  waitForFrame,
} from "./ink-app-fixtures.tsx";

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
