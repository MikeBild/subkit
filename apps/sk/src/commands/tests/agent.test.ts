import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { AGENT_FILE_RELPATH, findAgentFile, wireClaudeSessionStartHook } from "../agent.ts";

describe("findAgentFile", () => {
  test("walks up from a nested cwd to the repo-root declaration", () => {
    const root = mkdtempSync(join(tmpdir(), "sk-agent-"));
    mkdirSync(join(root, ".sk"), { recursive: true });
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
    const root = mkdtempSync(join(tmpdir(), "sk-agent-none-"));
    expect(findAgentFile(root)).toBeNull();
  });

  test("returns null for an empty domains list", () => {
    const root = mkdtempSync(join(tmpdir(), "sk-agent-empty-"));
    mkdirSync(join(root, ".sk"), { recursive: true });
    writeFileSync(join(root, AGENT_FILE_RELPATH), JSON.stringify({ domains: [] }));
    expect(findAgentFile(root)).toBeNull();
  });
});

describe("wireClaudeSessionStartHook", () => {
  test("adds SessionStart briefing and SessionEnd capture entries to empty settings", () => {
    const updated = wireClaudeSessionStartHook({});
    if (!updated) throw new Error("expected settings update");
    const hooks = updated.hooks as Record<string, unknown>;
    const sessionStart = hooks.SessionStart as Array<{
      matcher: string;
      hooks: Array<{ command: string }>;
    }>;
    expect(sessionStart).toHaveLength(1);
    expect(sessionStart[0]?.matcher).toBe("startup|resume|compact");
    expect(sessionStart[0]?.hooks[0]?.command).toContain("sk agent briefing --hook");
    const sessionEnd = hooks.SessionEnd as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionEnd).toHaveLength(1);
    expect(sessionEnd[0]?.hooks[0]?.command).toContain("sk agent capture --hook");
  });

  test("is idempotent — returns null when already wired", () => {
    const first = wireClaudeSessionStartHook({});
    expect(first).not.toBeNull();
    expect(wireClaudeSessionStartHook(first as Record<string, unknown>)).toBeNull();
  });

  test("preserves unrelated settings and existing hooks", () => {
    const existing = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "other-tool" }] }],
      },
    };
    const updated = wireClaudeSessionStartHook(existing);
    if (!updated) throw new Error("expected settings update");
    expect(updated.model).toBe("opus");
    const hooks = updated.hooks as Record<string, unknown>;
    expect(hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    const sessionStart = hooks.SessionStart as unknown[];
    expect(sessionStart).toHaveLength(2);
  });
});
