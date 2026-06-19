// Persona-variant selection — sk_headless surface always wins, then
// authoring mode picks AUTHORING / EXECUTION / DIAGNOSIS. Verifies
// the cache-prefix anchor sentence is byte-stable across same-mode
// turns and that the CLI_HEADLESS_PERSONA never references web UI
// affordances (sidebars, modals, "click", "Save Changes").

import { describe, expect, test } from "bun:test";
import type { AuthoringPromptHint } from "../../../llm/types.ts";
import type { AuthoringSurfaceMode } from "../../types.ts";
import { generateMainAgentSystemPrompt } from "../context.ts";

function makeHint(mode: AuthoringSurfaceMode): AuthoringPromptHint {
  return {
    mode,
    stage: "idle",
    lifecycle_state: "draft_only",
    active_target: { kind: "workflow", lifecycle_state: "draft_only" },
    blocked_by: [],
    next_required_action: null,
    next_suggested_tool: null,
    checkpoints: [],
    latest_execution: null,
    latest_diagnosis: null,
  };
}

const ANCHOR = "subkit's authoring + operator assistant";

describe("persona-variant selection", () => {
  test("headless surface picks CLI_HEADLESS persona regardless of mode", async () => {
    for (const mode of ["workflow", "connector", "execution", "diagnosis"] as const) {
      const r = await generateMainAgentSystemPrompt({
        surface: "sk_headless",
        authoring_hint: makeHint(mode),
      });
      expect(r.content).toContain(ANCHOR);
      expect(r.content).toContain("driven from sk-CLI in headless mode");
    }
  });

  test("CLI_HEADLESS persona never names web UI affordances", async () => {
    const r = await generateMainAgentSystemPrompt({ surface: "sk_headless" });
    // The whole prompt body — persona + general rules + skills — is
    // checked. Skills are also expected to avoid web affordance prose
    // since they are universal.
    const forbidden = ["sidebar", "Save Changes button", "click here", "modal"];
    for (const phrase of forbidden) {
      expect(r.content.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  test("workflow mode + interactive surface picks AUTHORING persona", async () => {
    const r = await generateMainAgentSystemPrompt({
      surface: "sk_interactive",
      authoring_hint: makeHint("workflow"),
    });
    expect(r.content).toContain("In authoring mode you are drafting connectors + workflows");
  });

  test("connector mode + interactive surface picks AUTHORING persona", async () => {
    const r = await generateMainAgentSystemPrompt({
      surface: "sk_interactive",
      authoring_hint: makeHint("connector"),
    });
    expect(r.content).toContain("In authoring mode you are drafting connectors + workflows");
  });

  test("execution mode picks EXECUTION persona", async () => {
    const r = await generateMainAgentSystemPrompt({
      surface: "sk_interactive",
      authoring_hint: makeHint("execution"),
    });
    expect(r.content).toContain("In execution mode the workflow is already persisted");
    // Anti-regression: the AUTHORING-only sentence must not leak in.
    expect(r.content).not.toContain("In authoring mode you are drafting");
  });

  test("diagnosis mode picks DIAGNOSIS persona", async () => {
    const r = await generateMainAgentSystemPrompt({
      surface: "sk_interactive",
      authoring_hint: makeHint("diagnosis"),
    });
    expect(r.content).toContain("In diagnosis mode a recent run failed");
    expect(r.content).not.toContain("In authoring mode you are drafting");
  });

  test("default (no hint) on interactive surface picks AUTHORING persona", async () => {
    const r = await generateMainAgentSystemPrompt({ surface: "sk_interactive" });
    expect(r.content).toContain("In authoring mode you are drafting connectors + workflows");
  });

  test("persona prefix is byte-stable across two consecutive same-mode turns", async () => {
    const t1 = await generateMainAgentSystemPrompt({
      surface: "sk_interactive",
      authoring_hint: makeHint("workflow"),
    });
    const t2 = await generateMainAgentSystemPrompt({
      surface: "sk_interactive",
      authoring_hint: makeHint("workflow"),
    });
    // The whole prompt should be byte-stable across same-mode turns
    // (focus blocks + skill bodies + verbosity all derive from the
    // same input). If this drifts, the prompt cache stops re-using.
    expect(t1.content).toBe(t2.content);
  });
});
