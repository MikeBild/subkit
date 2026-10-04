// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${engine_url}` is the literal runtime-template token under test, asserted verbatim — not a template-literal typo.

import { describe, expect, it } from "bun:test";
import { applyRuntimeTemplate, basePromptFor } from "../../core/context-assembler.ts";
import { runOutputGuard } from "../index.ts";

const ENGINE_URL = "https://engine.acme.dev";
const INSTALL_CMD = `curl -fsSL ${ENGINE_URL}/install | bash`;

function bash(...lines: string[]): string {
  return ["```bash", ...lines, "```"].join("\n");
}

describe("install-answer grounding — cross-layer (prompt + guard + chat-first)", () => {
  it("layer 1: the mcp base prompt renders the install command with the real host", async () => {
    const base = (await basePromptFor("converse", "mcp")).content;
    const system = applyRuntimeTemplate(base, { engine_url: ENGINE_URL });
    expect(system).toContain(INSTALL_CMD);
    expect(system).not.toContain("${engine_url}");
  });

  it("layer 1: authoring/no-surface base does NOT carry the install grounding (stays lean)", async () => {
    const base = (await basePromptFor("converse", undefined)).content;
    expect(base).not.toContain("GROUNDING sk SELF-QUESTIONS");
  });

  it("layer 1: with NO runtime host, the install command is NOT fabricated (token stays literal)", async () => {
    const base = (await basePromptFor("converse", "mcp")).content;
    const noHost = applyRuntimeTemplate(base, {});
    expect(noHost).toContain("${engine_url}/install");
    expect(noHost).not.toContain("engine.acme.dev");
  });

  it("layers 2+3: the grounded install curl survives the output guard un-scrubbed (soft)", () => {
    const modelOut = `Der Installationsbefehl ist:\n\n${bash(INSTALL_CMD)}\n\nDas ist der einzige Weg.`;
    const g = runOutputGuard(modelOut, { engine_url: ENGINE_URL }, { mode: "soft" });
    expect(g.text).toContain(INSTALL_CMD);
    expect(g.text).not.toContain("[guard:");
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
});
