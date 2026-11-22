import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBriefingContext } from "./agent-context.ts";

const profile = {
  name: "test",
  engine_url: "http://engine.invalid",
  api_key: "wf_live_probe",
  active_tenant_id: null,
};

describe("REPL agent briefing context", () => {
  let root: string;

  test("loads the folder briefing at start, adds newly matched domains once, and composes memory", async () => {
    root = mkdtempSync(join(tmpdir(), "subkit-repl-context-"));
    const folder = join(root, "billing");
    mkdirSync(join(folder, ".subkit"), { recursive: true });
    writeFileSync(join(folder, ".subkit", "agent.json"), JSON.stringify({ domains: ["billing"] }));
    let domainRequests = 0;
    let briefingRequests = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/agent/domains")) {
        domainRequests += 1;
        return new Response(
          JSON.stringify({
            domains: [],
            from_prompt: domainRequests > 1 ? ["docs"] : [],
            from_repo: [],
          }),
        );
      }
      briefingRequests += 1;
      return new Response(
        JSON.stringify({
          markdown: `# Briefing ${briefingRequests}`,
          domains: [briefingRequests === 1 ? "billing" : "docs"],
          skills_full: [],
          skills_title_only: [],
          knowledge_sources: [],
          workflows: [],
          connectors: [],
        }),
      );
    }) as typeof fetch;
    const context = new AgentBriefingContext({
      profile,
      cwd: folder,
      sessionId: "repl-session",
      sessionDirectory: join(root, "sessions"),
      fetchImpl,
    });
    const started = await context.start();
    expect(started.status).toBe("✓ SubKit");
    expect(context.memory("local rules")).toContain("# Briefing 1");
    const update = await context.beforePrompt("tell me about docs");
    expect(update.changed).toBe(true);
    expect(context.memory(null)).toContain("# Briefing 2");
    expect(context.memory(null)).toContain("# Briefing 1");
    expect((await context.beforePrompt("tell me about docs")).changed).toBe(false);
    expect(context.memory("local rules")).toContain("local rules");
  });
});
