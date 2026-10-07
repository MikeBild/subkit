import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import {
  AGENT_FILE_RELPATH,
  agentCommand,
  boundedFetch,
  findAgentFile,
  forgetBriefed,
  newPromptDomains,
  parseHookPayload,
  readBriefed,
  recordBriefed,
  sessionDomains,
  wireClaudeHooks,
} from "../agent.ts";

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
    expect(sessionStart[0]?.matcher).toBe("startup|resume|compact");
    expect(sessionStart[0]?.hooks[0]?.command).toContain("sk agent briefing --hook");
    const prompt = hooks.UserPromptSubmit as Array<{
      matcher?: string;
      hooks: Array<{ command: string; timeout: number }>;
    }>;
    expect(prompt).toHaveLength(1);
    expect(prompt[0]?.matcher).toBeUndefined();
    expect(prompt[0]?.hooks[0]?.command).toBe("sk agent briefing --hook");
    expect(prompt[0]?.hooks[0]?.timeout).toBeLessThanOrEqual(10);
    const sessionEnd = hooks.SessionEnd as Array<{ hooks: Array<{ command: string }> }>;
    expect(sessionEnd).toHaveLength(1);
    expect(sessionEnd[0]?.hooks[0]?.command).toContain("sk agent capture --hook");
  });

  test("an earlier install gains only the prompt hook, and a second run changes nothing", () => {
    const earlier = {
      hooks: {
        SessionStart: [
          { matcher: "startup", hooks: [{ type: "command", command: "sk agent briefing --hook" }] },
        ],
        SessionEnd: [{ hooks: [{ type: "command", command: "sk agent capture --hook" }] }],
      },
    };
    const updated = wireClaudeHooks(earlier);
    if (!updated) throw new Error("expected settings update");
    const hooks = updated.hooks as Record<string, unknown[]>;
    expect(hooks.SessionStart).toEqual(earlier.hooks.SessionStart);
    expect(hooks.SessionEnd).toEqual(earlier.hooks.SessionEnd);
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
});

describe("hook payload", () => {
  test("reads the prompt of a UserPromptSubmit payload", () => {
    expect(
      parseHookPayload(
        JSON.stringify({ cwd: "/r", session_id: "s1", prompt: "page the ops on-call" }),
      ),
    ).toEqual({
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

describe("which domains a turn is briefed on", () => {
  test("the session starts with the declared domains, else what the repository names", () => {
    expect(sessionDomains(["blog-de"], ["infra"])).toEqual(["blog-de"]);
    expect(sessionDomains([], ["infra"])).toEqual(["infra"]);
    expect(sessionDomains([], [])).toEqual([]);
  });

  test("a prompt adds only domains the session has not been briefed on", () => {
    expect(newPromptDomains(["blog-de", "ops"], ["blog-de"])).toEqual(["ops"]);
    expect(newPromptDomains(["blog-de"], ["blog-de", "ops"])).toEqual([]);
  });
});

describe("briefed domains per session", () => {
  test("are remembered per session, merged, and forgotten when the session starts again", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sk-agent-briefed-")), "agent-sessions");
    expect(readBriefed(dir, "s/1")).toEqual([]);
    recordBriefed(dir, "s/1", ["ops"]);
    recordBriefed(dir, "s/1", ["blog-de", "ops"]);
    expect(readBriefed(dir, "s/1")).toEqual(["blog-de", "ops"]);
    expect(readBriefed(dir, "s2")).toEqual([]);
    forgetBriefed(dir, "s/1");
    expect(readBriefed(dir, "s/1")).toEqual([]);
  });

  test("records of old sessions are cleared on the next write", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sk-agent-briefed-")), "agent-sessions");
    recordBriefed(dir, "old", ["ops"]);
    const file = join(dir, "old.json");
    expect(existsSync(file)).toBe(true);
    const threeDaysLater = statSync(file).mtimeMs + 3 * 24 * 60 * 60 * 1000;
    recordBriefed(dir, "new", ["ops"], threeDaysLater);
    expect(existsSync(file)).toBe(false);
    expect(readBriefed(dir, "new")).toEqual(["ops"]);
  });
});

describe("sk agent init --skip-claude", () => {
  let cwd: string;
  let savedCwd: string;
  let savedEnv: Record<string, string | undefined>;
  let printed: string[];
  let originalWrite: typeof process.stdout.write;
  beforeEach(() => {
    savedCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "sk-agent-init-"));
    process.chdir(cwd);
    savedEnv = { SUBKIT_ENGINE_URL: process.env.SUBKIT_ENGINE_URL };
    process.env.SUBKIT_ENGINE_URL = "https://engine.example.test";
    printed = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = originalWrite;
    process.chdir(savedCwd);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("declares the domains and prints the Codex and Hermes snippets without touching Claude", async () => {
    await runCommand(agentCommand, {
      rawArgs: ["init", "--domains", "blog-de", "--skip-claude"],
    });
    const output = printed.join("");
    expect(findAgentFile(cwd)?.config.domains).toEqual(["blog-de"]);
    expect(output).toContain("Codex (manual, feature-gated):");
    expect(output).toContain('"UserPromptSubmit"');
    expect(output).toContain("Hermes (manual):");
    expect(output).toContain("https://engine.example.test/mcp");
    expect(output).toContain("sk agent briefing");
    expect(output).not.toContain("wired SessionStart");
    expect(output).not.toContain("Claude Code hooks");
  });
});

describe("hook requests", () => {
  test("give up after their time budget instead of holding the prompt", async () => {
    const never = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof fetch;
    await expect(
      boundedFetch(50, never)("http://engine.invalid/v1/agent/domains"),
    ).rejects.toThrow();
  });
});
