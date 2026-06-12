// Failure-aware spinner head. Pre-fix (session 975a64b0) a stuck
// recovery flow showed "processing 5 tool results… 3m09s · 70520t"
// (then labelled "summarising" — a step that never existed) — opaque
// to the user. Post-fix the spinner surfaces the failure count +
// last error_code so the user sees a concrete signal.

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Spinner } from "./spinner.tsx";

describe("Spinner · failure-aware head", () => {
  test("renders failure head when ≥2 tools failed (no current tool, no completed-only state)", () => {
    const { lastFrame } = render(
      <Spinner
        active={true}
        verbs={["thinking"]}
        currentTool={null}
        completedToolsThisTurn={5}
        failedToolsThisTurn={5}
        lastFailureCode="slug_already_in_use"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("5 tools failed");
    expect(frame).toContain("(slug_already_in_use)");
    // The processing line should NOT appear when failure head wins.
    expect(frame).not.toContain("processing 5 tool results");
  });

  test("falls back to 'processing' when only 1 failure", () => {
    const { lastFrame } = render(
      <Spinner
        active={true}
        verbs={["thinking"]}
        currentTool={null}
        completedToolsThisTurn={3}
        failedToolsThisTurn={1}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("processing 3 tool results");
  });

  test("currentTool wins over failure head", () => {
    const { lastFrame } = render(
      <Spinner
        active={true}
        verbs={["thinking"]}
        currentTool="dry_run_workflow"
        failedToolsThisTurn={4}
        lastFailureCode="step_invalid"
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("running dry_run_workflow");
    expect(frame).not.toContain("4 tools failed");
  });

  test("failure head without lastFailureCode renders count alone", () => {
    const { lastFrame } = render(
      <Spinner
        active={true}
        verbs={["thinking"]}
        currentTool={null}
        completedToolsThisTurn={3}
        failedToolsThisTurn={3}
        lastFailureCode={null}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("3 tools failed");
    expect(frame).not.toContain("(");
  });
});
