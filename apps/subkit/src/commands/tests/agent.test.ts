import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_FILE_RELPATH,
  findAgentFile,
  parseHookPayload,
  wireClaudeHooks,
  wireCodexHooks,
} from "../agent.ts";
import { inheritedDeclarations } from "./agent-fixtures.ts";

afterAll(() => inheritedDeclarations.mockRestore());

describe("findAgentFile", () => {
  test("walks up from a nested cwd to the repo-root declaration", () => {
    const root = mkdtempSync(join(tmpdir(), "subkit-agent-"));
    mkdirSync(join(root, ".subkit"), { recursive: true });
    writeFileSync(
      join(root, AGENT_FILE_RELPATH),
      JSON.stringify({ domains: ["blog-de"], budget_tokens: 2000 }),
    );
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });

    const found = findAgentFile(nested);
    expect(found?.config.domains).toEqual(["blog-de"]);
    expect(found?.config.budget_tokens).toBe(2000);
    expect(found?.path).toBe(join(root, AGENT_FILE_RELPATH));
  });

  test("returns null when no declaration exists", () => {
    const root = mkdtempSync(join(tmpdir(), "subkit-agent-none-"));
    expect(findAgentFile(root)).toBeNull();
  });

  test("rejects an empty domains list", () => {
    const root = mkdtempSync(join(tmpdir(), "subkit-agent-empty-"));
    mkdirSync(join(root, ".subkit"), { recursive: true });
    writeFileSync(join(root, AGENT_FILE_RELPATH), JSON.stringify({ domains: [] }));
    expect(() => findAgentFile(root)).toThrow("domains must contain at least one domain slug");
  });

  test("reports malformed declarations as configuration errors", () => {
    const root = mkdtempSync(join(tmpdir(), "subkit-agent-invalid-json-"));
    mkdirSync(join(root, ".subkit"), { recursive: true });
    writeFileSync(join(root, AGENT_FILE_RELPATH), "{invalid");
    expect(() => findAgentFile(root)).toThrow(".subkit/agent.json: invalid JSON");
  });

  test("rejects briefing budgets outside the engine-supported range", () => {
    const root = mkdtempSync(join(tmpdir(), "subkit-agent-invalid-budget-"));
    mkdirSync(join(root, ".subkit"), { recursive: true });
    writeFileSync(
      join(root, AGENT_FILE_RELPATH),
      JSON.stringify({ domains: ["ops"], budget_tokens: 200 }),
    );
    expect(() => findAgentFile(root)).toThrow("budget_tokens must be an integer from 500 to 16000");
  });
});

describe("wireClaudeHooks", () => {
  test("adds SessionStart + UserPromptSubmit briefing and SessionEnd capture to empty settings", () => {
    const updated = wireClaudeHooks({});
    if (!updated) throw new Error("expected settings update");
    const hooks = updated.hooks as Record<string, unknown>;
    const sessionStart = hooks.SessionStart as Array<{
      matcher: string;
      hooks: Array<{ command: string }>;
    }>;
    expect(sessionStart).toHaveLength(1);
    expect(sessionStart[0]?.matcher).toBe("startup|resume|clear|compact|fork");
    expect(sessionStart[0]?.hooks[0]?.command).toContain("subkit agent briefing --hook");
    const prompt = hooks.UserPromptSubmit as Array<{
      matcher?: string;
      hooks: Array<{ command: string; timeout: number }>;
    }>;
    expect(prompt).toHaveLength(1);
    expect(prompt[0]?.matcher).toBeUndefined();
    expect(prompt[0]?.hooks[0]?.command).toBe("subkit agent briefing --hook");
    expect(prompt[0]?.hooks[0]?.timeout).toBeLessThanOrEqual(10);
    const sessionEnd = hooks.SessionEnd as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionEnd).toHaveLength(1);
    expect(sessionEnd[0]?.hooks[0]?.command).toContain("subkit agent capture --hook");
  });

  test("an earlier install is reconciled and a second run changes nothing", () => {
    const earlier = {
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: "subkit agent briefing --hook" }],
          },
        ],
        SessionEnd: [{ hooks: [{ type: "command", command: "subkit agent capture --hook" }] }],
      },
    };
    const updated = wireClaudeHooks(earlier);
    if (!updated) throw new Error("expected settings update");
    const hooks = updated.hooks as Record<string, unknown[]>;
    expect((hooks.SessionStart as Array<{ matcher: string }>)[0]?.matcher).toBe(
      "startup|resume|clear|compact|fork",
    );
    expect(
      (hooks.SessionEnd as Array<{ hooks: Array<{ timeout: number }> }>)[0]?.hooks[0]?.timeout,
    ).toBeGreaterThan(0);
    expect(hooks.UserPromptSubmit).toHaveLength(1);
    expect(wireClaudeHooks(updated)).toBeNull();
  });

  test("is idempotent — returns null when already wired", () => {
    const first = wireClaudeHooks({});
    expect(first).not.toBeNull();
    expect(wireClaudeHooks(first as Record<string, unknown>)).toBeNull();
  });

  test("preserves unrelated settings and existing hooks", () => {
    const existing = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "other-tool" }] }],
      },
    };
    const updated = wireClaudeHooks(existing);
    if (!updated) throw new Error("expected settings update");
    expect(updated.model).toBe("opus");
    const hooks = updated.hooks as Record<string, unknown>;
    expect(hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    const sessionStart = hooks.SessionStart as unknown[];
    expect(sessionStart).toHaveLength(2);
  });

  test("updates SubKit inside a shared hook group without dropping sibling handlers", () => {
    const updated = wireClaudeHooks({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "subkit agent briefing --hook", timeout: 5 },
              { type: "command", command: "other-tool", timeout: 7 },
            ],
          },
        ],
      },
    });
    if (!updated) throw new Error("expected settings update");
    const entries = (
      updated.hooks as Record<
        string,
        Array<{ hooks: Array<{ command: string; timeout?: number }> }>
      >
    ).SessionStart;
    expect(entries?.flatMap((entry) => entry.hooks.map((hook) => hook.command))).toContain(
      "other-tool",
    );
    const subkit = entries
      ?.flatMap((entry) => entry.hooks)
      .find((hook) => hook.command === "subkit agent briefing --hook");
    expect(subkit?.timeout).toBeGreaterThan(5);
  });
});

describe("wireCodexHooks", () => {
  test("adds SessionStart, UserPromptSubmit, and bounded asynchronous SessionEnd hooks", () => {
    const updated = wireCodexHooks({});
    if (!updated) throw new Error("expected hooks update");
    const hooks = updated.hooks as Record<
      string,
      Array<{
        matcher?: string;
        hooks: Array<{
          command: string;
          timeout?: number;
          additionalContextLimit?: number;
          statusMessage?: string;
        }>;
      }>
    >;
    expect(hooks.SessionStart?.[0]?.matcher).toBe("startup|resume|clear|compact");
    expect(hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("subkit agent briefing --hook");
    expect(hooks.SessionStart?.[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    expect(hooks.SessionStart?.[0]?.hooks[0]?.statusMessage).toBe("Loading repository briefing");
    expect(hooks.UserPromptSubmit?.[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    expect(hooks.SessionEnd?.[0]?.hooks[0]?.command).toBe(
      "subkit agent capture --hook --agent codex --detach",
    );
    expect(hooks.SessionEnd?.[0]?.hooks[0]?.timeout).toBe(3);
    expect(hooks.Stop).toBeUndefined();
  });

  test("is idempotent and keeps the hooks of other tools", () => {
    const existing = {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }] },
    };
    const updated = wireCodexHooks(existing);
    if (!updated) throw new Error("expected hooks update");
    expect((updated.hooks as Record<string, unknown>).Stop).toEqual(existing.hooks.Stop);
    expect(wireCodexHooks(updated)).toBeNull();
  });

  test("moves only the legacy SubKit capture from per-turn Stop to SessionEnd", () => {
    const updated = wireCodexHooks({
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [
              {
                type: "command",
                command: "subkit agent capture --hook --agent codex",
                timeout: 60,
              },
              { type: "command", command: "other-tool", timeout: 60 },
            ],
          },
        ],
      },
    });
    if (!updated) throw new Error("expected hook reconciliation");
    const hooks = updated.hooks as Record<
      string,
      Array<{ hooks: Array<{ command: string; timeout?: number }> }>
    >;
    expect(hooks.Stop?.[0]?.hooks.map((hook) => hook.command)).toEqual(["other-tool"]);
    expect(hooks.SessionEnd?.[0]?.hooks[0]?.command).toBe(
      "subkit agent capture --hook --agent codex --detach",
    );
  });

  test("does not adopt unrelated wrapper commands that contain the managed hook text", () => {
    const updated = wireCodexHooks({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: "echo subkit agent briefing --hook" }],
          },
        ],
      },
    });
    if (!updated) throw new Error("expected canonical hook addition");
    const hooks = updated.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.SessionStart?.[0]?.hooks.map((hook) => hook.command)).toContain(
      "echo subkit agent briefing --hook",
    );
    expect(hooks.SessionStart?.[1]?.hooks[0]?.command).toBe("subkit agent briefing --hook");
  });

  test("reconciles stale SubKit Codex settings without changing sibling hooks", () => {
    const updated = wireCodexHooks({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "subkit agent briefing --hook", timeout: 5 },
              { type: "command", command: "other-tool", timeout: 7 },
            ],
          },
        ],
      },
    });
    if (!updated) throw new Error("expected hooks update");
    const hooks = updated.hooks as Record<
      string,
      Array<{
        matcher?: string;
        hooks: Array<{
          command: string;
          timeout?: number;
          additionalContextLimit?: number;
          statusMessage?: string;
        }>;
      }>
    >;
    const subkit = hooks.SessionStart?.flatMap((entry) => entry.hooks).find(
      (hook) => hook.command === "subkit agent briefing --hook",
    );
    expect(subkit?.timeout).toBeGreaterThan(5);
    expect(subkit?.additionalContextLimit).toBe(0);
    expect(subkit?.statusMessage).toBe("Loading repository briefing");
    expect(
      hooks.SessionStart?.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
    ).toContain("other-tool");
  });
});

describe("hook payload", () => {
  test("reads the prompt of a UserPromptSubmit payload", () => {
    expect(
      parseHookPayload(
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          cwd: "/r",
          session_id: "s1",
          prompt: "page the ops on-call",
        }),
      ),
    ).toEqual({
      hook_event_name: "UserPromptSubmit",
      cwd: "/r",
      session_id: "s1",
      transcript_path: null,
      prompt: "page the ops on-call",
    });
  });

  test("a blank prompt, empty input or broken JSON reads as no prompt", () => {
    expect(parseHookPayload(JSON.stringify({ prompt: "   " })).prompt).toBeNull();
    expect(parseHookPayload("").prompt).toBeNull();
    expect(parseHookPayload("{nope").prompt).toBeNull();
  });
});
