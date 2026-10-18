import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

  test("rejects briefing budgets outside the engine-supported range", () => {
    const root = mkdtempSync(join(tmpdir(), "sk-agent-invalid-budget-"));
    mkdirSync(join(root, ".sk"), { recursive: true });
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
    expect(hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("sk agent briefing --hook");
    expect(hooks.SessionStart?.[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    expect(hooks.SessionStart?.[0]?.hooks[0]?.statusMessage).toBe("Loading repository briefing");
    expect(hooks.UserPromptSubmit?.[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    expect(hooks.SessionEnd?.[0]?.hooks[0]?.command).toBe(
      "sk agent capture --hook --agent codex --detach",
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
              { type: "command", command: "sk agent capture --hook --agent codex", timeout: 60 },
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
      "sk agent capture --hook --agent codex --detach",
    );
  });

  test("does not adopt unrelated wrapper commands that contain the managed hook text", () => {
    const updated = wireCodexHooks({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: "echo sk agent briefing --hook" }],
          },
        ],
      },
    });
    if (!updated) throw new Error("expected canonical hook addition");
    const hooks = updated.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    expect(hooks.SessionStart?.[0]?.hooks.map((hook) => hook.command)).toContain(
      "echo sk agent briefing --hook",
    );
    expect(hooks.SessionStart?.[1]?.hooks[0]?.command).toBe("sk agent briefing --hook");
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
        hooks: Array<{
          command: string;
          timeout?: number;
          additionalContextLimit?: number;
          statusMessage?: string;
        }>;
      }>
    >;
    const subkit = hooks.SessionStart?.flatMap((entry) => entry.hooks).find(
      (hook) => hook.command === "sk agent briefing --hook",
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

describe("which domains a turn is briefed on", () => {
  test("a hook can infer context from its repository when no declaration exists", () => {
    expect(planBriefing({ explicit: null, declared: [], hook: true, prompt: "page ops" })).toEqual({
      kind: "repo",
      prompt: "page ops",
    });
    expect(planBriefing({ explicit: null, declared: [], hook: true, prompt: null })).toEqual({
      kind: "repo",
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

  test("keeps session IDs distinct when their filesystem-safe forms would collide", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-briefed-collision-"));
    recordBriefed(dir, "session/a", ["ops"]);
    recordBriefed(dir, "session?a", ["billing"]);
    expect(readBriefed(dir, "session/a")).toEqual(["ops"]);
    expect(readBriefed(dir, "session?a")).toEqual(["billing"]);
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
    const file = join(dir, readdirSync(dir)[0] ?? "");
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
    expect(Object.keys(codexHooks.hooks).sort()).toEqual([
      "SessionEnd",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    expect(output).toContain(
      "wired SessionStart + UserPromptSubmit briefing and SessionEnd learning hooks",
    );
    expect(output).toContain("Codex (finish by hand):");
    expect(output).toContain("hooks are enabled by default");
    expect(output).toContain("/hooks");
    expect(output).toContain("agent receives the relevant briefing");
    expect(output).toContain("folder name matches exactly one SubKit project area");
    expect(output).toContain("Hook status stays brief");
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

  test("merges explicit domains without dropping existing settings", async () => {
    mkdirSync(join(cwd, ".sk"), { recursive: true });
    writeFileSync(
      join(cwd, AGENT_FILE_RELPATH),
      JSON.stringify({
        domains: ["blog-de", "subkit"],
        budget_tokens: 2300,
        custom_setting: "preserved",
        inferred: true,
        inferred_folder_domain: "blog-de",
      }),
    );

    await runCommand(agentCommand, {
      rawArgs: ["init", "--domains", "subkit,invoices", "--skip-claude", "--skip-codex"],
    });

    expect(JSON.parse(readFileSync(join(cwd, AGENT_FILE_RELPATH), "utf8"))).toEqual({
      domains: ["blog-de", "subkit", "invoices"],
      budget_tokens: 2300,
      custom_setting: "preserved",
    });
  });

  test("validates global hook JSON before changing the repository declaration", async () => {
    mkdirSync(join(cwd, ".sk"), { recursive: true });
    const agentFile = join(cwd, AGENT_FILE_RELPATH);
    const original = JSON.stringify({ domains: ["existing"], budget_tokens: 1700 });
    writeFileSync(agentFile, original);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "hooks.json"), "{");

    await expect(
      runCommand(agentCommand, { rawArgs: ["init", "--domains", "replacement"] }),
    ).rejects.toThrow();

    expect(readFileSync(agentFile, "utf8")).toBe(original);
    expect(printed.join("")).not.toContain("updated");
    process.exitCode = undefined;
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

  test("the Codex snippet explains defaults, policy, trust, and session capture", () => {
    const snippet = codexHookSnippet();
    expect(snippet).toContain("hooks are enabled by default");
    expect(snippet).toContain("administrator policy");
    expect(snippet).toContain("including changed hooks");
    expect(snippet).not.toContain("hooks = true");
    expect(snippet).toContain("/hooks");
    expect(snippet).toContain("additionalContextLimit 0");
    expect(snippet).toContain("SessionEnd capture is installed by sk agent init");
    expect(snippet).toContain("Do not use the per-turn Stop event for session capture");
    expect(snippet).not.toContain('"Stop"');
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
      expect(result?.systemMessage).toBe("✓ SubKit");
      expect(result?.systemMessage).not.toMatch(/sk |skill proposal|knowledge source|workflow/i);
      expect(result?.systemMessage).not.toContain("`");
      expect(result?.systemMessage).not.toMatch(/\b\d+\s+(?:skill|knowledge|workflow)\b/i);
      expect(result?.hookSpecificOutput).toEqual({
        hookEventName: event,
        additionalContext: expect.stringContaining(
          "Interpret a brief check-in as asking what is relevant to this folder's project context",
        ),
      });
      expect(result?.hookSpecificOutput?.additionalContext).not.toContain("For SubKit check-ins");
    }
  });

  test("caps shared hook context to the same conservative client budget and character limit", async () => {
    const root = fixture();
    let requestedBudget: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/agent/domains")) {
        return Response.json({ domains: ["ops"], from_prompt: [], from_repo: [] });
      }
      requestedBudget = new URL(url).searchParams.get("budget_tokens");
      return Response.json({ markdown: `# Briefing\n${"detail ".repeat(3000)}` });
    }) as typeof fetch;

    const result = await getBriefingHookOutput(payload(root), { profile, fetchImpl });
    const context = result?.hookSpecificOutput?.additionalContext ?? "";

    expect(requestedBudget ?? "").toBe("1800");
    expect(context.length).toBeLessThanOrEqual(9500);
    expect(context).toContain("Briefing shortened to fit the coding client's context limit");
    expect(result?.systemMessage).toBe("⚠ SubKit");
  });

  test("keeps hook status concise while providing review guidance without clip contents", async () => {
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const root = fixture();
      const fetchImpl = (async (input: RequestInfo | URL) => {
        if (String(input).includes("/v1/agent/domains")) {
          return Response.json({ domains: ["blog-de"], from_prompt: ["blog-de"], from_repo: [] });
        }
        return Response.json({
          markdown: "# Briefing\nCollected material is awaiting review.",
          skills_full: [],
          skills_title_only: [],
          knowledge_sources: [],
          workflows: [],
          connectors: [],
          proposed_candidates: 0,
          intake: { collected: 3, reviewing: 1, proposals: 2 },
        });
      }) as typeof fetch;
      const result = await getBriefingHookOutput(payload(root, event), {
        profile,
        fetchImpl,
        sessionDirectory: join(root, "sessions"),
      });
      expect(result?.systemMessage).toBe("✓ SubKit");
      expect(result?.systemMessage).not.toContain("sk learnings review");
      expect(result?.hookSpecificOutput?.hookEventName).toBe(event);
      expect(result?.hookSpecificOutput?.additionalContext).not.toContain("sk learnings review");
    }
  });

  test("briefs a folder without Git metadata from its name and adds shared SubKit context", async () => {
    const parent = mkdtempSync(join(tmpdir(), "sk-agent-domain-"));
    const root = join(parent, "harmoniqs");
    mkdirSync(root);
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/agent/domains")) {
        const body = JSON.parse(String(init?.body)) as {
          prompt?: string;
          repo?: string;
          folder?: string;
        };
        calls.push(`${body.folder ?? body.repo ?? ""}:${body.prompt ?? ""}`);
        return Response.json({
          domains: ["harmoniqs", "subkit"],
          from_prompt: body.prompt === "subkit" ? ["subkit"] : [],
          from_repo: [],
          from_folder: body.folder === "harmoniqs" ? ["harmoniqs"] : [],
        });
      }
      calls.push(new URL(url).searchParams.get("domains") ?? "");
      return Response.json({
        markdown: "# Briefing",
        skills_full: [],
        skills_title_only: [],
        knowledge_sources: [],
        workflows: [],
        connectors: [],
        proposed_candidates: 0,
      });
    }) as typeof fetch;
    const result = await getBriefingHookOutput(
      { ...payload(root), session_id: "harmoniqs-session" },
      { profile, fetchImpl, sessionDirectory: join(root, "sessions") },
    );
    expect(result?.systemMessage).toBe("✓ SubKit");
    expect(calls).toContain("harmoniqs:subkit");
    expect(calls).toContain("harmoniqs,subkit");
    expect(JSON.parse(readFileSync(join(root, AGENT_FILE_RELPATH), "utf8"))).toEqual({
      domains: ["harmoniqs", "subkit"],
      inferred: true,
      inferred_folder_domain: "harmoniqs",
    });
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "created one with these domains: harmoniqs, subkit",
    );
  });

  test("routes open-ended check-ins through the declared SubKit domain and live status tools", async () => {
    const root = fixture(["subkit"]);
    const fetchImpl = (async (input: RequestInfo | URL) =>
      String(input).includes("/v1/agent/domains")
        ? Response.json({
            domains: ["subkit"],
            from_prompt: ["subkit"],
            from_repo: [],
            from_folder: [],
          })
        : new Response(
            JSON.stringify({
              markdown: "# SubKit briefing",
              domains: ["subkit"],
              skills_full: [],
              skills_title_only: [],
              knowledge_sources: [],
              workflows: [],
              connectors: [],
              proposed_candidates: 0,
            }),
          )) as typeof fetch;
    const result = await getBriefingHookOutput(payload(root), {
      profile,
      fetchImpl,
      sessionDirectory: join(root, "sessions"),
    });
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "call `list_skill_suggestions` and `list_skill_candidates` for their separate review queues",
    );
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "use `list_workflows` and follow up any blocked or otherwise attention-worthy workflow with `get_workflow`",
    );
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "up to three prioritized, specific next steps",
    );
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "Rank findings by source-backed impact, urgency, and whether they block other work",
    );
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "Resolve workflow and schedule IDs to human-readable names before reporting",
    );
    expect(result?.hookSpecificOutput?.additionalContext).toContain("never preload their contents");
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "do not count the same proposal twice",
    );
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "documented repository maintenance",
    );
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "A dirty worktree alone is not evidence of maintenance work",
    );
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "Use knowledge sources and workflows listed for this folder when they directly help",
    );
  });

  test("offers setup guidance in unmatched folders and warns on invalid declarations or absent API keys", async () => {
    const outside = mkdtempSync(join(tmpdir(), "sk-agent-outside-"));
    const noKnownDomains = (async (input: RequestInfo | URL) =>
      String(input).includes("/v1/agent/domains")
        ? Response.json({ domains: [], from_prompt: [], from_repo: [], from_folder: [] })
        : Response.json({})) as typeof fetch;
    const unmatched = await getBriefingHookOutput(payload(outside), {
      profile,
      fetchImpl: noKnownDomains,
    });
    expect(unmatched?.systemMessage).toBe("SubKit · setup");
    expect(unmatched?.hookSpecificOutput?.additionalContext).toContain(
      "folder name did not produce exactly one project-domain match",
    );
    expect(unmatched?.hookSpecificOutput?.additionalContext).toContain(
      "ask which project area, knowledge sources, and workflows belong here",
    );
    expect(existsSync(join(outside, AGENT_FILE_RELPATH))).toBe(false);
    const invalid = fixture([]);
    const invalidResult = await getBriefingHookOutput(payload(invalid), { profile });
    expect(invalidResult?.systemMessage).toBe("⚠ SubKit");
    expect(invalidResult?.systemMessage).not.toContain("sk ");
    const declared = fixture();
    const missingKey = await getBriefingHookOutput(payload(declared), {
      profile: { ...profile, api_key: "" },
    });
    expect(missingKey?.systemMessage).toBe("⚠ SubKit");
  });

  test("creates a shared-only folder declaration when the project match is unclear", async () => {
    const root = mkdtempSync(join(tmpdir(), "sk-agent-shared-only-"));
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/v1/agent/domains")) {
        const body = JSON.parse(String(init?.body)) as { prompt?: string };
        return Response.json({
          domains: body.prompt === "subkit" ? ["subkit"] : [],
          from_prompt: body.prompt === "subkit" ? ["subkit"] : [],
          from_repo: [],
          from_folder: [],
        });
      }
      return Response.json({ markdown: "# Shared SubKit context" });
    }) as typeof fetch;
    const result = await getBriefingHookOutput(payload(root), {
      profile,
      fetchImpl,
      sessionDirectory: join(root, "sessions"),
    });
    expect(JSON.parse(readFileSync(join(root, AGENT_FILE_RELPATH), "utf8"))).toEqual({
      domains: ["subkit"],
      inferred: true,
      inferred_folder_domain: null,
    });
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "created one with these domains: subkit",
    );
    expect(result?.hookSpecificOutput?.additionalContext).toContain(
      "no unique project-domain match",
    );
  });

  test("rechecks the folder of a generated shared-only declaration on later sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "sk-agent-inferred-refresh-"));
    const project = join(root, "invoices");
    const nested = join(project, "src");
    mkdirSync(join(project, ".sk"), { recursive: true });
    mkdirSync(nested);
    writeFileSync(
      join(project, AGENT_FILE_RELPATH),
      JSON.stringify({ domains: ["subkit"], inferred: true, inferred_folder_domain: null }),
    );
    const folders: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/v1/agent/domains")) {
        const body = JSON.parse(String(init?.body)) as { prompt?: string; folder?: string };
        if (body.folder) folders.push(body.folder);
        return Response.json({
          domains:
            body.folder === "invoices" || body.prompt === "subkit" ? ["invoices", "subkit"] : [],
          from_prompt: body.prompt === "subkit" ? ["subkit"] : [],
          from_repo: [],
          from_folder: body.folder === "invoices" ? ["invoices"] : [],
        });
      }
      return Response.json({ markdown: "# Updated folder context" });
    }) as typeof fetch;
    const result = await getBriefingHookOutput(payload(nested), {
      profile,
      fetchImpl,
      sessionDirectory: join(root, "sessions"),
    });
    expect(folders).toContain("invoices");
    expect(result?.hookSpecificOutput?.additionalContext).toContain("Updated folder context");
    expect(result?.hookSpecificOutput?.additionalContext).not.toContain(
      "no unique project-domain match",
    );
  });

  test("replaces a stale inferred folder domain after a catalog rename", async () => {
    const root = mkdtempSync(join(tmpdir(), "sk-agent-inferred-rename-"));
    const project = join(root, "billing");
    mkdirSync(join(project, ".sk"), { recursive: true });
    writeFileSync(
      join(project, AGENT_FILE_RELPATH),
      JSON.stringify({
        domains: ["invoices", "subkit"],
        inferred: true,
        inferred_folder_domain: "invoices",
      }),
    );
    const briefingDomains: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/v1/agent/domains")) {
        const body = JSON.parse(String(init?.body)) as { prompt?: string; folder?: string };
        return Response.json({
          domains:
            body.folder === "billing" || body.prompt === "subkit" ? ["billing", "subkit"] : [],
          from_prompt: body.prompt === "subkit" ? ["subkit"] : [],
          from_repo: [],
          from_folder: body.folder === "billing" ? ["billing"] : [],
        });
      }
      briefingDomains.push(new URL(String(input)).searchParams.get("domains") ?? "");
      return Response.json({ markdown: "# Billing context" });
    }) as typeof fetch;
    const result = await getBriefingHookOutput(payload(project), {
      profile,
      fetchImpl,
      sessionDirectory: join(root, "sessions"),
    });
    expect(result?.hookSpecificOutput?.additionalContext).toContain("Billing context");
    expect(briefingDomains.join("|")).toBe("subkit,billing");
  });

  test("migrates a legacy inferred declaration when its folder domain is stale", async () => {
    const root = mkdtempSync(join(tmpdir(), "sk-agent-inferred-legacy-"));
    const project = join(root, "billing");
    mkdirSync(join(project, ".sk"), { recursive: true });
    writeFileSync(
      join(project, AGENT_FILE_RELPATH),
      JSON.stringify({ domains: ["invoices", "subkit"], inferred: true }),
    );
    const briefingDomains: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/v1/agent/domains")) {
        const body = JSON.parse(String(init?.body)) as { prompt?: string; folder?: string };
        return Response.json({
          domains:
            body.folder === "billing" || body.prompt === "subkit" ? ["billing", "subkit"] : [],
          from_prompt: body.prompt === "subkit" ? ["subkit"] : [],
          from_repo: [],
          from_folder: body.folder === "billing" ? ["billing"] : [],
        });
      }
      briefingDomains.push(new URL(String(input)).searchParams.get("domains") ?? "");
      return Response.json({ markdown: "# Billing context" });
    }) as typeof fetch;
    await getBriefingHookOutput(payload(project), {
      profile,
      fetchImpl,
      sessionDirectory: join(root, "sessions"),
    });
    expect(briefingDomains.join("|")).toBe("subkit,billing");
  });

  test("shows a visible warning when the engine rejects or cannot serve a briefing", async () => {
    for (const status of [401, 503]) {
      const root = fixture();
      const fetchImpl = (async () =>
        new Response("unavailable", { status })) as unknown as typeof fetch;
      const result = await getBriefingHookOutput(payload(root), { profile, fetchImpl });
      expect(result?.systemMessage).toBe("⚠ SubKit");
      expect(result?.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    }
  });
});
