// Contract tests for the skill roster's auto-load trigger discipline.
//
// Three invariants this test enforces:
//
//  1. `error-recovery.md` auto-loads on any common authoring-time error
//     shape (HTTP 4xx/5xx, permission_denied, placeholder_unresolved, …)
//     so the recovery routine is in context when the model needs it —
//     not a skill the model has to remember to load_skill() explicitly.
//
//  2. `error-recovery` (authoring-time) and
//     `troubleshooting-workflow-failures` (execution-time) have
//     disambiguated titles and descriptions. Their jobs overlap in
//     wording but NOT in scope; anyone skimming the roster must be able
//     to tell them apart.
//
//  3. `connector-creation-guidance.md` fires on creation-intent phrases
//     only. It must NOT auto-load on every mention of `api`, `http`, or
//     `endpoint` — that broad trigger floods context in unrelated flows
//     (MCP setup, workflow authoring against existing connectors).
//
// Regressions here re-introduce the exact UX issues the skill-roster
// audit flagged. Keep the test loud.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");
}

function frontmatter(body: string): Record<string, string> {
  const match = body.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error("no frontmatter block");
  const out: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function triggerKeywords(body: string): string[] {
  const fm = frontmatter(body);
  const raw = fm.trigger_keywords ?? "";
  // e.g. "[a, b, c]"
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("error-recovery skill — auto-load on authoring-time error shapes", () => {
  const body = read("error-recovery.md");

  it("has auto_load: true so the recovery routine is always in context when errors show up", () => {
    expect(frontmatter(body).auto_load).toBe("true");
  });

  it("triggers on HTTP error shapes the model routinely sees", () => {
    const kws = triggerKeywords(body);
    expect(kws).toContain("http_4xx");
    expect(kws).toContain("http_5xx");
    expect(kws).toContain("4xx");
    expect(kws).toContain("5xx");
  });

  it("triggers on typed tool-error codes from the canonical envelope", () => {
    const kws = triggerKeywords(body);
    expect(kws).toContain("placeholder_unresolved");
    expect(kws).toContain("permission_denied");
    expect(kws).toContain("validation_failed");
    expect(kws).toContain("step_timeout");
    expect(kws).toContain("connector_not_found");
  });

  it("triggers on generic error vocabulary a user might type", () => {
    const kws = triggerKeywords(body);
    expect(kws).toContain("error");
    expect(kws).toContain("failed");
    expect(kws).toContain("fix");
  });
});

describe("error-recovery vs troubleshooting-workflow-failures — disambiguated", () => {
  const authoring = read("error-recovery.md");
  const execution = read("troubleshooting-workflow-failures.md");

  it("titles call out authoring vs execution time explicitly", () => {
    expect(frontmatter(authoring).title).toMatch(/authoring/i);
    expect(frontmatter(execution).title).toMatch(/execution/i);
  });

  it("each description cross-references the other so the boundary is explicit", () => {
    expect(frontmatter(authoring).description).toMatch(/troubleshooting-workflow-failures/);
    expect(frontmatter(execution).description).toMatch(/error-recovery/);
  });

  it("execution-time triggers use execution-specific vocabulary, not generic 'error'", () => {
    const kws = triggerKeywords(execution);
    expect(kws).toContain("execution failed");
    expect(kws).toContain("run failed");
    expect(kws).toContain("past run");
    expect(kws).toContain("circuit-breaker");
    // And DOES NOT hijack the generic `error` / `failed` keywords that
    // the authoring-time skill should own.
    expect(kws).not.toContain("error");
    expect(kws).not.toContain("failed");
  });
});

describe("connector-creation-guidance skill — creation-intent triggers only", () => {
  const body = read("connector-creation-guidance.md");

  it("keeps auto_load on so the checklist fires when the user actually wants to create a connector", () => {
    expect(frontmatter(body).auto_load).toBe("true");
  });

  it("triggers on creation-intent multi-word phrases", () => {
    const kws = triggerKeywords(body);
    expect(kws).toContain("create connector");
    expect(kws).toContain("new connector");
    expect(kws).toContain("add integration");
    expect(kws).toContain("start_connector_from_description");
  });

  it("does NOT trigger on bare `api`, `http`, `endpoint`, `auth` — those flooded unrelated flows", () => {
    const kws = triggerKeywords(body);
    expect(kws).not.toContain("api");
    expect(kws).not.toContain("http");
    expect(kws).not.toContain("endpoint");
    expect(kws).not.toContain("auth");
    expect(kws).not.toContain("authentication");
    expect(kws).not.toContain("base-url");
    expect(kws).not.toContain("bearer");
    expect(kws).not.toContain("oauth2");
    expect(kws).not.toContain("api-key");
  });
});
