import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { translate } from "@/lib/i18n";
import {
  AUTHORING_MODES,
  DEFAULT_AUTHORING_MODE,
  GATE_MATRIX,
  type GateRow,
  modeDescriptionKey,
  modeGates,
  modeLabelKey,
  modeSuffixKey,
} from "./chat-mode";

describe("authoring modes", () => {
  test("the default is the engine's own default, offered once", () => {
    const create = readFileSync(
      resolve(import.meta.dir, "../../../engine/src/conversations/service/create.ts"),
      "utf8",
    );
    expect(create).toContain(
      `normalizePermissionMode(p.permission_mode) ?? "${DEFAULT_AUTHORING_MODE}"`,
    );
    expect(AUTHORING_MODES.filter((mode) => mode === DEFAULT_AUTHORING_MODE)).toHaveLength(1);
    const suffix = modeSuffixKey(DEFAULT_AUTHORING_MODE);
    expect(suffix && translate("de", suffix)).toContain("Systemstandard");
    for (const mode of AUTHORING_MODES)
      if (mode !== DEFAULT_AUTHORING_MODE) expect(modeSuffixKey(mode)).toBeNull();
    expect(translate("de", modeLabelKey(DEFAULT_AUTHORING_MODE))).not.toContain("Systemstandard");
  });

  test("the pill reads a short name, and every option explains itself", () => {
    expect(AUTHORING_MODES.map((mode) => translate("de", modeLabelKey(mode)))).toEqual([
      "Autonom",
      "Fragt vorher",
      "Nur planen",
    ]);
    const lines = AUTHORING_MODES.map((mode) => translate("de", modeDescriptionKey(mode)));
    expect(new Set(lines).size).toBe(AUTHORING_MODES.length);
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
  });

  test("no two modes read the same", () => {
    const readings = AUTHORING_MODES.map((mode) => {
      const gates = modeGates(mode);
      return JSON.stringify([gates.asks, gates.free, gates.guidance]);
    });
    expect(new Set(readings).size).toBe(AUTHORING_MODES.length);
    const labels = AUTHORING_MODES.map((mode) => translate("de", modeLabelKey(mode)));
    expect(new Set(labels).size).toBe(AUTHORING_MODES.length);
  });

  test("auto prepares without asking; ask and plan ask before preparing", () => {
    expect(modeGates("auto").free).toContain("chat.mode.gate.preparation");
    expect(modeGates("ask").asks).toContain("chat.mode.gate.preparation");
    expect(modeGates("plan").asks).toContain("chat.mode.gate.preparation");
  });

  test("some gates remain in every mode; admission of live runs is not a mode's", () => {
    for (const mode of AUTHORING_MODES) {
      const { asks, free, outside } = modeGates(mode);
      for (const kept of ["chat.mode.gate.dangerous", "chat.mode.gate.inlineCredential"] as const)
        expect(asks, `${mode} keeps ${kept}`).toContain(kept);
      expect(free).toContain("chat.mode.gate.readAndCheck");
      expect(outside).toEqual(["chat.mode.gate.admission"]);
    }
  });

  test("plan enforces what ask enforces and says its difference is a guardrail", () => {
    expect(modeGates("plan").asks).toEqual(modeGates("ask").asks);
    expect(modeGates("plan").guidance).toBe("chat.mode.guidance.plan");
    expect(modeGates("ask").guidance).toBeNull();
  });
});

type Category = "draft_write" | "tenant_read" | "tenant_write";
const PROBES: Record<GateRow, Array<{ tool: string; category: Category; input?: unknown }>> = {
  readAndCheck: [
    { tool: "inspect_workflow_draft", category: "draft_write" },
    { tool: "dry_run_transform", category: "draft_write" },
  ],
  webSearch: [{ tool: "web_search", category: "tenant_read" }],
  preparation: [
    { tool: "save_workflow_draft", category: "draft_write", input: {} },
    { tool: "create_knowledge_source", category: "tenant_write" },
  ],
  proposals: [
    { tool: "save_learning", category: "tenant_write" },
    { tool: "propose_workflow_repair", category: "tenant_write" },
  ],
  otherChanges: [{ tool: "edit_role", category: "tenant_write" }],
  dangerous: [
    { tool: "delete_workflow", category: "tenant_write" },
    { tool: "save_workflow_draft", category: "draft_write", input: { force_commit: true } },
  ],
  liveRuns: [{ tool: "run_workflow", category: "tenant_write", input: { workflow: "w" } }],
  inlineCredential: [
    {
      tool: "update_connector_draft",
      category: "draft_write",
      input: { config: { api_key: "sk-live-pasted" } },
    },
  ],
};

const POLICIES = resolve(import.meta.dir, "../../../engine/src/conversations/tool-policies.ts");
const { decideToolMode } = (await import(POLICIES)) as {
  decideToolMode(args: {
    tool: string;
    category: Category;
    input: unknown;
    overrides: Record<string, never>;
    permission_mode: string;
  }): { mode: string };
};
const asks = (probe: { tool: string; category: Category; input?: unknown }, mode: string) =>
  decideToolMode({
    tool: probe.tool,
    category: probe.category,
    input: probe.input ?? {},
    overrides: {},
    permission_mode: mode,
  }).mode === "confirm_before_execution";

describe("the matrix is the engine's", () => {
  for (const row of Object.keys(PROBES) as GateRow[])
    for (const mode of AUTHORING_MODES)
      test(`${row} under ${mode}`, () => {
        for (const probe of PROBES[row])
          expect(asks(probe, mode), `${probe.tool}`).toBe(GATE_MATRIX[row][mode]);
      });

  test("under auto a live run does not ask in the conversation — admission decides", () => {
    expect(asks({ tool: "run_workflow", category: "tenant_write" }, "auto")).toBe(false);
    expect(modeGates("auto").free).toContain("chat.mode.gate.liveRuns");
  });
});
