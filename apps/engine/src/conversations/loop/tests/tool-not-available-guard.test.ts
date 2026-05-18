import { describe, expect, it } from "bun:test";
import { detectToolHallucinatedAbsence } from "../tool-not-available-guard.ts";

const PALETTE = new Set([
  "create_schedule",
  "update_schedule",
  "list_schedules",
  "build_workflow",
  "save_workflow_draft",
]);

describe("detectToolHallucinatedAbsence", () => {
  it("fires when the model claims a palette tool is unavailable (paren-list form)", () => {
    const v = detectToolHallucinatedAbsence({
      assistantText:
        "the tools to create or update schedules (create_schedule, update_schedule) are not available in this conversation interface",
      palette: PALETTE,
    });
    expect(v.hallucinated).toBe(true);
    expect(v.toolName).toBe("create_schedule");
  });

  it("fires when the model says 'X is not part of my toolset'", () => {
    const v = detectToolHallucinatedAbsence({
      assistantText: "list_schedules is not part of my toolset",
      palette: PALETTE,
    });
    expect(v.hallucinated).toBe(true);
    expect(v.toolName).toBe("list_schedules");
  });

  it("fires when the model says 'I don't have access to X'", () => {
    const v = detectToolHallucinatedAbsence({
      assistantText: "I don't have access to build_workflow in this session",
      palette: PALETTE,
    });
    expect(v.hallucinated).toBe(true);
    expect(v.toolName).toBe("build_workflow");
  });

  it("stays quiet when the denied tool is genuinely not in the palette", () => {
    const v = detectToolHallucinatedAbsence({
      assistantText: "the send_carrier_pigeon tool is not available",
      palette: PALETTE,
    });
    expect(v.hallucinated).toBe(false);
    expect(v.toolName).toBeNull();
  });

  it("stays quiet on generic 'X is not available yet' phrasing", () => {
    const v = detectToolHallucinatedAbsence({
      assistantText: "the result is not available yet — give it a moment",
      palette: PALETTE,
    });
    expect(v.hallucinated).toBe(false);
  });

  it("stays quiet on legitimate explanatory prose", () => {
    const v = detectToolHallucinatedAbsence({
      assistantText:
        "I called build_workflow and it returned a draft. The next step is dry_run_workflow.",
      palette: PALETTE,
    });
    expect(v.hallucinated).toBe(false);
  });

  it("stays quiet when palette is empty", () => {
    const v = detectToolHallucinatedAbsence({
      assistantText: "create_schedule is not available",
      palette: new Set(),
    });
    expect(v.hallucinated).toBe(false);
  });

  it("ignores short tokens (under 4 chars) to avoid false matches", () => {
    const v = detectToolHallucinatedAbsence({
      assistantText: "the foo tool is not available",
      palette: new Set(["foo"]),
    });
    // `foo` is too short to be in the candidate set; the regex
    // requires ≥ 4 chars to avoid e.g. "the env tool" false positives.
    expect(v.hallucinated).toBe(false);
  });

  it("returns first match when multiple tools are denied", () => {
    const v = detectToolHallucinatedAbsence({
      assistantText:
        "create_schedule is not part of my toolset and update_schedule is not part of my toolset either",
      palette: PALETTE,
    });
    expect(v.hallucinated).toBe(true);
    expect(v.toolName).toBe("create_schedule");
  });
});
