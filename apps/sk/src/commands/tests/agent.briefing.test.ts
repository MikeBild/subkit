import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_FILE_RELPATH, getBriefingHookOutput } from "../agent.ts";
import { inheritedDeclarations } from "./agent-fixtures.ts";

afterAll(() => inheritedDeclarations.mockRestore());

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
          intake: { clips: 3, sessions: 1, proposals: 2 },
        });
      }) as typeof fetch;
      const result = await getBriefingHookOutput(payload(root, event), {
        profile,
        fetchImpl,
        sessionDirectory: join(root, "sessions"),
      });
      expect(result?.systemMessage).toBe("✓ SubKit");
      expect(result?.hookSpecificOutput?.hookEventName).toBe(event);
      const context = result?.hookSpecificOutput?.additionalContext ?? "";
      expect(context).toContain("Collected material is awaiting review.");
      expect(`${result?.systemMessage}\n${context}`).not.toMatch(
        /sk learnings|create_skill|propose_skill|skill candidate/i,
      );
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
      "call `list_intake_items` for collected clips and session learnings that still await a person's review, reading only their metadata",
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
