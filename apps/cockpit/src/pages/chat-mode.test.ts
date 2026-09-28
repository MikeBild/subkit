// §14: every authoring mode shows its gate matrix, and no two modes read the
// same. "Systemstandard" and "Autonome Vorbereitung" were two entries over one
// matrix — the engine starts a conversation without a mode as `auto`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { translate } from "@/lib/i18n";
import { AUTHORING_MODES, DEFAULT_AUTHORING_MODE, modeGates, modeLabelKey } from "./chat-mode";

describe("authoring modes", () => {
  test("the default is the engine's own default, offered once", () => {
    // Read from the engine rather than restated: a changed default there must
    // fail here, not leave the picker naming the wrong mode as standard.
    const create = readFileSync(
      resolve(import.meta.dir, "../../../engine/src/conversations/service/create.ts"),
      "utf8",
    );
    expect(create).toContain(
      `normalizePermissionMode(p.permission_mode) ?? "${DEFAULT_AUTHORING_MODE}"`,
    );
    expect(AUTHORING_MODES.filter((mode) => mode === DEFAULT_AUTHORING_MODE)).toHaveLength(1);
    expect(translate("de", modeLabelKey(DEFAULT_AUTHORING_MODE))).toContain("Systemstandard");
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

  test("some gates remain in every mode", () => {
    for (const mode of AUTHORING_MODES) {
      const { asks, free } = modeGates(mode);
      for (const kept of [
        "chat.mode.gate.dangerous",
        "chat.mode.gate.inlineCredential",
        "chat.mode.gate.activateAndRun",
      ] as const)
        expect(asks, `${mode} keeps ${kept}`).toContain(kept);
      expect(free).toContain("chat.mode.gate.readAndCheck");
    }
  });

  test("plan enforces what ask enforces and says its difference is a guardrail", () => {
    expect(modeGates("plan").asks).toEqual(modeGates("ask").asks);
    expect(modeGates("plan").guidance).toBe("chat.mode.guidance.plan");
    expect(modeGates("ask").guidance).toBeNull();
  });
});
