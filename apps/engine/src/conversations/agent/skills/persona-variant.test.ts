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

describe("install-grounding rule is surface-gated (chat/mcp/web), not in the authoring base", () => {
  // The rule is injected by generateMainAgentSystemPrompt only on user-facing
  // ANSWER surfaces (chat, mcp, web), NOT baked into GENERAL_RULES. So an MCP
  // client driving the engine's conversation loop is grounded the same way the
  // chat channel is — but the sk_interactive / sk_headless AUTHORING base is
  // left unchanged (keeps it under the small-model context cap the assembler
  // drop-ladder tests pin). Pins "does the corrected install answer work via MCP?".
  test("MCP and web surfaces carry the grounding rule", async () => {
    for (const surface of ["mcp", "web"] as const) {
      const r = await generateMainAgentSystemPrompt({
        surface,
        authoring_hint: makeHint("workflow"),
      });
      expect(r.content).toContain("GROUNDING sk SELF-QUESTIONS");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal grounding token asserted verbatim; the assembler substitutes it.
      expect(r.content).toContain("curl -fsSL ${engine_url}/install | bash");
      // Names the invented npm package only inside its negation, never as a path.
      expect(r.content).toContain("@subkit/cli");
    }
  });

  test("authoring/CLI surfaces do NOT carry the rule (base stays lean)", async () => {
    for (const surface of ["sk_interactive", "sk_headless"] as const) {
      const r = await generateMainAgentSystemPrompt({
        surface,
        authoring_hint: makeHint("workflow"),
      });
      expect(r.content).not.toContain("GROUNDING sk SELF-QUESTIONS");
    }
  });
});

describe("action-honesty rule reaches EVERY real surface, not the surface-less base", () => {
  // Unlike the answer-surface groundings above, ACTION HONESTY guards the
  // REPL too: the observed fabrication ("deleted the conversation" with no
  // such tool in the palette) happened on sk_interactive. Only the
  // surface-less assembly — the drop-ladder tests' pinned base — stays
  // without it.
  test("all real surfaces carry the action-honesty rule", async () => {
    for (const surface of ["sk_interactive", "sk_headless", "mcp", "web", "chat"] as const) {
      const r = await generateMainAgentSystemPrompt({
        surface,
        authoring_hint: makeHint("workflow"),
      });
      expect(r.content).toContain("ACTION HONESTY");
    }
  });

  test("surface-less assembly does NOT carry it (pinned base stays lean)", async () => {
    const r = await generateMainAgentSystemPrompt({
      authoring_hint: makeHint("workflow"),
    });
    expect(r.content).not.toContain("ACTION HONESTY");
  });
});

describe("concept-grounding rule is surface-gated (chat/mcp/web), not in the authoring base", () => {
  // Same architecture as install-grounding: the Skills-vs-Knowledge / model-a-
  // domain rule is injected only on user-facing ANSWER surfaces so the concept
  // answer is grounded there, but the authoring base prompt stays under the
  // small-model context cap the assembler drop-ladder tests pin.
  test("MCP and web surfaces carry the concept-grounding rule", async () => {
    for (const surface of ["mcp", "web"] as const) {
      const r = await generateMainAgentSystemPrompt({
        surface,
        authoring_hint: makeHint("workflow"),
      });
      expect(r.content).toContain("GROUNDING CONCEPT QUESTIONS");
      expect(r.content).toContain("sk-platform-reference");
    }
  });

  test("authoring/CLI surfaces do NOT carry the concept-grounding rule", async () => {
    for (const surface of ["sk_interactive", "sk_headless"] as const) {
      const r = await generateMainAgentSystemPrompt({
        surface,
        authoring_hint: makeHint("workflow"),
      });
      expect(r.content).not.toContain("GROUNDING CONCEPT QUESTIONS");
    }
  });
});

describe("count-hygiene rule is surface-gated (chat/mcp/web), not in the authoring base", () => {
  // Kept OUT of GENERAL_RULES so the authoring/CLI base prompt stays under the
  // small-model cap the assembler drop-ladder tests pin (adding it to
  // GENERAL_RULES tipped that base over the 12k mock cap). Fixes the observed
  // list-summary miscount on chat.
  test("MCP and web surfaces carry the count-hygiene rule", async () => {
    for (const surface of ["mcp", "web"] as const) {
      const r = await generateMainAgentSystemPrompt({
        surface,
        authoring_hint: makeHint("workflow"),
      });
      expect(r.content).toContain("COUNT CONSISTENCY");
    }
  });

  test("authoring/CLI surfaces do NOT carry the count-hygiene rule", async () => {
    for (const surface of ["sk_interactive", "sk_headless"] as const) {
      const r = await generateMainAgentSystemPrompt({
        surface,
        authoring_hint: makeHint("workflow"),
      });
      expect(r.content).not.toContain("COUNT CONSISTENCY");
    }
  });
});

describe("chat surface persona", () => {
  test("chat surface wins over any authoring mode and never promises authoring", async () => {
    for (const mode of ["workflow", "connector", "execution", "diagnosis"] as const) {
      const r = await generateMainAgentSystemPrompt({
        surface: "chat",
        authoring_hint: makeHint(mode),
      });
      expect(r.content).toContain(ANCHOR);
      expect(r.content).toContain("external chat channel");
      expect(r.content).toContain("CANNOT create or edit");
      // No authoring persona and no authoring focus block: the chat
      // palette carries no tools that could progress a draft.
      expect(r.content).not.toContain("In authoring mode you are drafting");
      expect(r.content).not.toContain("AUTHORING FOCUS:");
    }
  });

  test("chat persona carries the install-grounding rule and never invents install commands", async () => {
    const r = await generateMainAgentSystemPrompt({
      surface: "chat",
      authoring_hint: makeHint("execution"),
    });
    // P1: sk self-questions must be grounded, and the real install one-liner
    // must be named so the bot stops inventing @subkit/cli / docker-compose.
    expect(r.content).toContain("GROUNDING sk SELF-QUESTIONS");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal grounding token asserted verbatim; the assembler substitutes it.
    expect(r.content).toContain("curl -fsSL ${engine_url}/install | bash");
    expect(r.content).toContain("@subkit/cli");
    expect(r.content).toContain("docker-compose install step");
  });

  test("chat persona forbids leaking authoring placeholders into chat replies", async () => {
    const r = await generateMainAgentSystemPrompt({
      surface: "chat",
      authoring_hint: makeHint("execution"),
    });
    // P3: connector-inspect answers must not print ${connector...} / ${cred...}
    // authoring template syntax to a read-only chat user.
    expect(r.content).toContain("NO AUTHORING PLACEHOLDERS ON CHAT");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal authoring placeholder syntax the persona rule must name verbatim.
    expect(r.content).toContain("${connector.<slug>...}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal authoring placeholder syntax the persona rule must name verbatim.
    expect(r.content).toContain("${cred.<slug>...}");
  });

  test("chat surface skips the mode-gated authoring behaviour bodies", async () => {
    const chat = await generateMainAgentSystemPrompt({
      surface: "chat",
      authoring_hint: makeHint("workflow"),
    });
    const web = await generateMainAgentSystemPrompt({
      surface: "web",
      authoring_hint: makeHint("workflow"),
    });
    // conversational-authoring is the ~1.8k-token authoring narrative
    // gated on workflow/connector mode — the chat prompt must not carry
    // it while the web prompt in the same mode does.
    expect(web.content.length).toBeGreaterThan(chat.content.length);
    expect(chat.content).not.toContain("inspect -> validate -> preview -> commit");
  });
});
