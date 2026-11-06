import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  captureQueuedMessage,
  codexHookSnippet,
  findAgentFile,
  forgetBriefed,
  newPromptDomains,
  planBriefing,
  readBriefed,
  recordBriefed,
} from "../agent.ts";
import { inheritedDeclarations } from "./agent-fixtures.ts";

afterAll(() => inheritedDeclarations.mockRestore());

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

describe("capture acknowledgement", () => {
  test("points to the Cockpit intake review instead of a CLI review queue", () => {
    expect(captureQueuedMessage({ base: "https://sk.example.test/engine" }, 1200)).toBe(
      "queued (1200 chars) — learnings worth keeping are collected for review in Cockpit: https://sk.example.test/engine/cockpit/intake",
    );
  });
});
