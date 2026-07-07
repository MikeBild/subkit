// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${engine_url}` is the literal runtime-template token under test, asserted verbatim — not a template-literal typo.

// Cross-layer regression test for the conversational "how do I install sk?"
// answer. The install answer is produced by THREE layers that must agree, and
// each was fixed + verified separately across v1.4.1→v1.4.3 (the install
// command came out blank when any one disagreed):
//
//   1. prompt assembly — SK_INSTALL_GROUNDING carries `${engine_url}`, which
//      applyRuntimeTemplate substitutes with the turn's real host.
//   2. output guard — the chat-first scanner must EXEMPT the sk installer curl
//      (curl to the engine's own `/install`), or it scrubs the command.
//   3. grounding — a real host from engine_url must survive the placeholder /
//      vendor-recipe scanners (no false-positive scrub).
//
// The per-layer unit tests (apply-runtime-template / chat-first / persona-variant)
// each cover ONE layer. This test composes all three the way a live turn does —
// deterministic, no DB, no LLM — so a regression in ANY layer fails here in one
// shot (the coverage gap that made the original fix take three releases).

import { describe, expect, it } from "bun:test";
import { applyRuntimeTemplate, basePromptFor } from "../../core/context-assembler.ts";
import { runOutputGuard } from "../index.ts";

// A real DNS host (hostname-not-IP), deliberately NOT `example.*` / `your-*`
// (those trip placeholder.host) so the test also proves a legitimately-grounded
// host is not mistaken for a placeholder.
const ENGINE_URL = "https://engine.acme.dev";
const INSTALL_CMD = `curl -fsSL ${ENGINE_URL}/install | bash`;

function bash(...lines: string[]): string {
  return ["```bash", ...lines, "```"].join("\n");
}

describe("install-answer grounding — cross-layer (prompt + guard + chat-first)", () => {
  it("layer 1: the mcp base prompt renders the install command with the real host", async () => {
    const base = await basePromptFor("converse", "mcp");
    const system = applyRuntimeTemplate(base, { engine_url: ENGINE_URL });
    expect(system).toContain(INSTALL_CMD);
    expect(system).not.toContain("${engine_url}");
  });

  it("layer 1: authoring/no-surface base does NOT carry the install grounding (stays lean)", async () => {
    // Guards the surface-gating that keeps the drop-ladder budget honest.
    const base = await basePromptFor("converse", undefined);
    expect(base).not.toContain("GROUNDING sk SELF-QUESTIONS");
  });

  it("layer 1: with NO runtime host, the install command is NOT fabricated (token stays literal)", async () => {
    // Proves the positive assertion above is caused by SUBSTITUTION of a supplied
    // host — the value loop.ts threads via `resolvedEngineUrl ?? engineUrlFromConfig()`
    // — not by a coincidental literal. If engine_url threading regressed (the v1.4.2
    // bug), the turn supplies no host and the command must render as the literal
    // `${engine_url}` token (which the RUNTIME CONTEXT cannot_help rule then handles),
    // NEVER a fabricated real URL. Guards the "hardcoded host = false green" hole.
    const base = await basePromptFor("converse", "mcp");
    const noHost = applyRuntimeTemplate(base, {});
    expect(noHost).toContain("${engine_url}/install");
    expect(noHost).not.toContain("engine.acme.dev");
  });

  it("layers 2+3: the grounded install curl survives the output guard un-scrubbed (soft)", () => {
    const modelOut = `Der Installationsbefehl ist:\n\n${bash(INSTALL_CMD)}\n\nDas ist der einzige Weg.`;
    const g = runOutputGuard(modelOut, { engine_url: ENGINE_URL }, { mode: "soft" });
    expect(g.text).toContain(INSTALL_CMD);
    expect(g.text).not.toContain("[guard:");
    // Neither the chat-first curl rule nor any placeholder rule fires on the
    // grounded installer — the exact false-positives that blanked the answer.
    const kinds = g.violations.map((v) => v.kind);
    expect(kinds).not.toContain("chat_first.curl_in_chat");
    expect(kinds.some((k) => k.startsWith("placeholder."))).toBe(false);
  });

  it("layers 2+3: hard mode does NOT throw on the grounded install curl", () => {
    const modelOut = bash(INSTALL_CMD);
    expect(() =>
      runOutputGuard(modelOut, { engine_url: ENGINE_URL }, { mode: "hard" }),
    ).not.toThrow();
  });

  // ── Negative controls: prove the test would CATCH a regression ────────────
  it("control: a curl to a NON-/install endpoint still trips chat_first (exemption is narrow)", () => {
    const g = runOutputGuard(
      bash(`curl ${ENGINE_URL}/things`),
      { engine_url: ENGINE_URL },
      {
        mode: "soft",
      },
    );
    expect(g.violations.map((v) => v.kind)).toContain("chat_first.curl_in_chat");
  });

  it("control: a genuine placeholder host is still flagged", () => {
    const g = runOutputGuard(
      "Point it at https://your-subkit-instance.com/mcp",
      {},
      {
        mode: "soft",
      },
    );
    expect(g.violations.some((v) => v.kind.startsWith("placeholder."))).toBe(true);
  });

  // ── ITEM 7: grounded content is not over-scrubbed by placeholder / vendor ──
  it("grounded: an MCP config whose url origin == engine_url + /mcp yields no vendor_recipe violation", () => {
    const cfg = [
      "```json",
      JSON.stringify(
        { mcpServers: { subkit: { url: `${ENGINE_URL}/mcp`, transport: "streamable-http" } } },
        null,
        2,
      ),
      "```",
    ].join("\n");
    const g = runOutputGuard(cfg, { engine_url: ENGINE_URL }, { mode: "soft" });
    expect(g.violations.some((v) => v.kind.startsWith("vendor_recipe."))).toBe(false);
    expect(g.text).toContain(`${ENGINE_URL}/mcp`);
  });
  // Known narrow FP (not fixed here, no live evidence): a NON-subkit host whose
  // name merely contains the substring "subkit" asked to end in /mcp can trip
  // vendor_recipe.host_mismatch. Hold the exemption until logs show it.
});
