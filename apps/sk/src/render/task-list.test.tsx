import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { ReactElement } from "react";
import { STATUS_GLYPH } from "../repl/plan-cell.tsx";
import { TaskList } from "./task-list.tsx";
import type { Phase } from "./types.ts";

function snapshot(ui: ReturnType<typeof render>): string {
  return (ui.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
}

function renderPhases(phases: ReadonlyArray<Phase>) {
  return render((<TaskList phases={phases} />) as ReactElement);
}

describe("TaskList", () => {
  test("all pending shows pending glyph for each phase", () => {
    const phases: Phase[] = [
      { name: "Validate", status: "pending" },
      { name: "Dry run", status: "pending" },
      { name: "Commit", status: "pending" },
    ];
    const ui = renderPhases(phases);
    const out = snapshot(ui);
    expect(out).toContain("Validate");
    expect(out).toContain("Dry run");
    expect(out).toContain("Commit");
    expect(out).toContain(STATUS_GLYPH.pending);
    ui.unmount();
  });

  test("one running phase shows running glyph", () => {
    const phases: Phase[] = [
      { name: "Validate", status: "succeeded" },
      { name: "Dry run", status: "running" },
      { name: "Commit", status: "pending" },
    ];
    const ui = renderPhases(phases);
    const out = snapshot(ui);
    expect(out).toContain(STATUS_GLYPH.running);
    expect(out).toContain("Dry run");
    ui.unmount();
  });

  test("failed phase shows failed glyph and detail", () => {
    const phases: Phase[] = [
      { name: "Validate", status: "succeeded" },
      { name: "Dry run", status: "failed", detail: "step transform returned empty" },
    ];
    const ui = renderPhases(phases);
    const out = snapshot(ui);
    expect(out).toContain(STATUS_GLYPH.failed);
    expect(out).toContain("Dry run");
    expect(out).toContain("step transform returned empty");
    ui.unmount();
  });

  test("succeeded + failed fast-fail shape shows both glyphs", () => {
    const phases: Phase[] = [
      { name: "Validate", status: "succeeded" },
      { name: "Commit", status: "failed", detail: "duplicate slug" },
    ];
    const ui = renderPhases(phases);
    const out = snapshot(ui);
    expect(out).toContain(STATUS_GLYPH.succeeded);
    expect(out).toContain(STATUS_GLYPH.failed);
    expect(out).toContain("duplicate slug");
    ui.unmount();
  });

  test("phase without detail shows no separator", () => {
    const phases: Phase[] = [{ name: "Probe", status: "running" }];
    const ui = renderPhases(phases);
    const out = snapshot(ui);
    expect(out).toContain("Probe");
    // The detail separator ' · ' must not appear when detail is absent
    expect(out).not.toContain(" · ");
    ui.unmount();
  });

  test("warning glyph for warning status", () => {
    const phases: Phase[] = [{ name: "Rate limit", status: "warning", detail: "429 on step 2" }];
    const ui = renderPhases(phases);
    const out = snapshot(ui);
    expect(out).toContain(STATUS_GLYPH.warning);
    expect(out).toContain("429 on step 2");
    ui.unmount();
  });
});
