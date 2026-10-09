import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import {
  AGENT_FILE_RELPATH,
  agentCommand,
  agentEngineClient,
  boundedFetch,
  codexHookSnippet,
  findAgentFile,
  forgetBriefed,
  getBriefingHookOutput,
  newPromptDomains,
  parseHookPayload,
  planBriefing,
  readBriefed,
  recordBriefed,
  wireClaudeHooks,
  wireCodexHooks,
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

  test("rejects an empty domains list", () => {
    const root = mkdtempSync(join(tmpdir(), "sk-agent-empty-"));
    mkdirSync(join(root, ".sk"), { recursive: true });
    writeFileSync(join(root, AGENT_FILE_RELPATH), JSON.stringify({ domains: [] }));
    expect(() => findAgentFile(root)).toThrow("domains must contain at least one domain slug");
  });

  test("reports malformed declarations as configuration errors", () => {
    const root = mkdtempSync(join(tmpdir(), "sk-agent-invalid-json-"));
    mkdirSync(join(root, ".sk"), { recursive: true });
    writeFileSync(join(root, AGENT_FILE_RELPATH), "{invalid");
    expect(() => findAgentFile(root)).toThrow(".sk/agent.json: invalid JSON");
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

  test("an earlier install is reconciled and a second run changes nothing", () => {
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
              { type: "command", command: "sk agent briefing --hook", timeout: 5 },
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
      .find((hook) => hook.command === "sk agent briefing --hook");
    expect(subkit?.timeout).toBeGreaterThan(5);
  });
});

describe("wireCodexHooks", () => {
  test("adds SessionStart + UserPromptSubmit briefing hooks that hand Codex the whole text", () => {
    const updated = wireCodexHooks({});
    if (!updated) throw new Error("expected hooks update");
    const hooks = updated.hooks as Record<
      string,
      Array<{
        matcher?: string;
        hooks: Array<{ command: string; additionalContextLimit?: number }>;
      }>
    >;
    expect(hooks.SessionStart?.[0]?.matcher).toBe("startup|resume|clear|compact");
    expect(hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("sk agent briefing --hook");
    expect(hooks.SessionStart?.[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    expect(hooks.UserPromptSubmit?.[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    expect(hooks.Stop).toBeUndefined();
    expect(hooks.SessionEnd).toBeUndefined();
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

  test("reconciles stale SubKit Codex settings without changing sibling hooks", () => {
    const updated = wireCodexHooks({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "sk agent briefing --hook", timeout: 5 },
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
        hooks: Array<{ command: string; timeout?: number; additionalContextLimit?: number }>;
      }>
    >;
    const subkit = hooks.SessionStart?.flatMap((entry) => entry.hooks).find(
      (hook) => hook.command === "sk agent briefing --hook",
    );
    expect(subkit?.timeout).toBeGreaterThan(5);
    expect(subkit?.additionalContextLimit).toBe(0);
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

describe("which domains a turn is briefed on", () => {
  test("a hook outside a repo with .sk/agent.json plans no request at all", () => {
    expect(planBriefing({ explicit: null, declared: [], hook: true, prompt: "page ops" })).toEqual({
      kind: "none",
    });
    expect(planBriefing({ explicit: null, declared: [], hook: true, prompt: null })).toEqual({
      kind: "none",
    });
  });

  test("a declared repo briefs its domains at start and resolves each prompt", () => {
    expect(planBriefing({ explicit: null, declared: ["ops"], hook: true, prompt: null })).toEqual({
      kind: "declared",
      domains: ["ops"],
    });
    expect(
      planBriefing({ explicit: null, declared: ["ops"], hook: true, prompt: "x".repeat(5_000) }),
    ).toEqual({ kind: "prompt", prompt: "x".repeat(2_000), declared: ["ops"] });
  });

  test("explicit domains win; only a person's own command falls back to the repository name", () => {
    expect(
      planBriefing({ explicit: ["radar"], declared: ["ops"], hook: true, prompt: "page ops" }),
    ).toEqual({ kind: "explicit", domains: ["radar"] });
    expect(planBriefing({ explicit: null, declared: [], hook: false, prompt: null })).toEqual({
      kind: "repo",
    });
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

  test("a record that vanishes while old records are cleared does not fail the write", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sk-agent-briefed-")), "agent-sessions");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(dir, "already-gone.json"), join(dir, "dangling.json"));
    expect(() => recordBriefed(dir, "s1", ["ops"])).not.toThrow();
    expect(readBriefed(dir, "s1")).toEqual(["ops"]);
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

describe("sk agent init", () => {
  let cwd: string;
  let home: string;
  let savedCwd: string;
  let savedEnv: Record<string, string | undefined>;
  let printed: string[];
  let originalWrite: typeof process.stdout.write;
  beforeEach(() => {
    savedCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "sk-agent-init-"));
    home = mkdtempSync(join(tmpdir(), "sk-agent-home-"));
    process.chdir(cwd);
    savedEnv = { SUBKIT_ENGINE_URL: process.env.SUBKIT_ENGINE_URL, HOME: process.env.HOME };
    process.env.SUBKIT_ENGINE_URL = "https://engine.example.test";
    process.env.HOME = home;
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

  test("declares the domains, wires Codex and prints the remaining Codex and Hermes steps without touching Claude", async () => {
    await runCommand(agentCommand, {
      rawArgs: ["init", "--domains", "blog-de", "--skip-claude"],
    });
    const output = printed.join("");
    expect(findAgentFile(cwd)?.config.domains).toEqual(["blog-de"]);
    const codexHooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(codexHooks.hooks).sort()).toEqual(["SessionStart", "UserPromptSubmit"]);
    expect(output).toContain("wired SessionStart + UserPromptSubmit briefing hooks");
    expect(output).toContain("Codex (finish by hand):");
    expect(output).toContain("hooks = true");
    expect(output).toContain("/hooks");
    expect(output).toContain("model receives the full briefing");
    expect(output).toContain("client shows loaded domains");
    expect(output).toContain("Hermes (manual):");
    expect(output).toContain("https://engine.example.test/mcp");
    expect(output).toContain("sk agent briefing");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(output).not.toContain("Claude Code hooks");
  });

  test("wires Claude Code under the home directory and leaves Codex alone when asked", async () => {
    await runCommand(agentCommand, {
      rawArgs: ["init", "--domains", "blog-de", "--skip-codex"],
    });
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "SessionEnd",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
    expect(printed.join("")).toContain("wired SessionStart + UserPromptSubmit + SessionEnd hooks");
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

describe("hook clients", () => {
  const profile = { engine_url: "http://engine.invalid", api_key: "", active_tenant_id: null };

  test("a hook without an API key makes no client and so no request", () => {
    expect(agentEngineClient(profile, true)).toBeNull();
    expect(agentEngineClient(profile, false)).not.toBeNull();
  });

  test("every hook request carries a time budget", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const recording = ((_input: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return Promise.resolve(
        new Response(JSON.stringify({ domains: [], from_prompt: [], from_repo: [] })),
      );
    }) as typeof fetch;
    const client = agentEngineClient({ ...profile, api_key: "wf_live_probe" }, true, recording);
    await client?.resolveAgentDomains({ prompt: "page ops" });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  test("the Codex snippet names the manual rest: feature flag, trust, and the optional per-turn capture", () => {
    const snippet = codexHookSnippet();
    expect(snippet).toContain("hooks = true");
    expect(snippet).toContain("/hooks");
    expect(snippet).toContain("additionalContextLimit 0");
    expect(snippet).toContain("once per turn");
    expect(snippet).toContain('"Stop"');
    expect(snippet).not.toContain('"SessionStart"');
    expect(snippet).not.toContain("cheap");
  });
});

describe("briefing hook output", () => {
  let savedDebugFile: string | undefined;

  beforeEach(() => {
    savedDebugFile = process.env.SK_DEBUG_FILE;
    process.env.SK_DEBUG_FILE = join(
      mkdtempSync(join(tmpdir(), "sk-agent-hook-log-")),
      "debug.log",
    );
  });

  afterEach(() => {
    if (savedDebugFile === undefined) delete process.env.SK_DEBUG_FILE;
    else process.env.SK_DEBUG_FILE = savedDebugFile;
  });

  function fixture(domains: unknown = ["ops"]) {
    const root = mkdtempSync(join(tmpdir(), "sk-agent-hook-"));
    mkdirSync(join(root, ".sk"), { recursive: true });
    writeFileSync(join(root, AGENT_FILE_RELPATH), JSON.stringify({ domains }));
    return root;
  }

  function payload(cwd: string, event = "SessionStart") {
    return {
      hook_event_name: event,
      cwd,
      session_id: "session-1",
      transcript_path: null,
      prompt: event === "UserPromptSubmit" ? "page ops" : null,
    };
  }

  const profile = {
    name: "test",
    engine_url: "http://engine.invalid",
    api_key: "wf_live_probe",
    active_tenant_id: null,
  };

  test("injects the briefing and confirms loaded domains for either client event", async () => {
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const root = fixture();
      const fetchImpl = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/v1/agent/domains")) {
          return new Response(
            JSON.stringify({ domains: [], from_prompt: ["blog-de"], from_repo: [] }),
          );
        }
        return new Response(
          JSON.stringify({
            markdown: "# Domain briefing",
            domains: ["ops", "blog-de"],
            skills_full: ["house-style"],
            skills_title_only: ["release-check"],
            knowledge_sources: ["ops-handbook", "blog-guide"],
            workflows: ["publish-post"],
            connectors: [],
            proposed_candidates: 3,
          }),
        );
      }) as typeof fetch;
      const result = await getBriefingHookOutput(payload(root, event), {
        profile,
        fetchImpl,
        sessionDirectory: join(root, "sessions"),
      });
      expect(result).not.toBeNull();
      expect(result?.systemMessage).toBe(
        event === "SessionStart"
          ? "SubKit briefing loaded: ops — 2 skills, 2 knowledge sources, 1 workflow; 3 skill proposals await review (run `sk learnings review`)."
          : "SubKit briefing loaded: blog-de — 2 skills, 2 knowledge sources, 1 workflow; 3 skill proposals await review (run `sk learnings review`).",
      );
      expect(result?.hookSpecificOutput).toEqual({
        hookEventName: event,
        additionalContext: "# Domain briefing",
      });
    }
  });

  test("stays silent in undeclared repositories and warns on invalid declarations or absent API keys", async () => {
    const outside = mkdtempSync(join(tmpdir(), "sk-agent-outside-"));
    expect(await getBriefingHookOutput(payload(outside), { profile })).toBeNull();
    const invalid = fixture([]);
    const invalidResult = await getBriefingHookOutput(payload(invalid), { profile });
    expect(invalidResult?.systemMessage).toContain("configuration is invalid");
    const declared = fixture();
    const missingKey = await getBriefingHookOutput(payload(declared), {
      profile: { ...profile, api_key: "" },
    });
    expect(missingKey?.systemMessage).toContain("no API key");
  });

  test("shows a visible warning when the engine rejects or cannot serve a briefing", async () => {
    for (const status of [401, 503]) {
      const root = fixture();
      const fetchImpl = (async () =>
        new Response("unavailable", { status })) as unknown as typeof fetch;
      const result = await getBriefingHookOutput(payload(root), { profile, fetchImpl });
      expect(result?.systemMessage).toContain("SubKit briefing unavailable:");
      expect(result?.systemMessage).toContain("The session will continue");
      expect(result?.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    }
  });
});
