// Spinner regression tests for session 86de186b — the user saw
// "thinking…" / "composing…" / "reviewing…" for 1m+ while the engine
// ran multiple tool calls in the background, with no visibility into
// what was happening. Spinner now accepts `currentTool` and replaces
// the rotating verb with a concrete "running <tool_name>…" line.

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Spinner } from "./spinner.tsx";

function snapshot(s: ReturnType<typeof render>): string {
  // ink-testing-library's lastFrame returns the rendered text. We
  // strip ANSI codes so assertions don't need to know about colour.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
  return (s.lastFrame() ?? "").replace(/\[[0-9;]*m/g, "");
}

describe("Spinner · live tool-call progress", () => {
  test("renders a rotating verb when no tool is in flight", () => {
    const r = render(<Spinner active={true} verbs={["thinking"]} />);
    const frame = snapshot(r);
    expect(frame).toContain("thinking…");
    r.unmount();
  });

  test("replaces the rotating verb with 'running <tool>' when currentTool is set", () => {
    const r = render(<Spinner active={true} verbs={["thinking"]} currentTool="dry_run_workflow" />);
    const frame = snapshot(r);
    expect(frame).toContain("running dry_run_workflow…");
    expect(frame).not.toContain("thinking…");
    r.unmount();
  });

  test("appends the tool kind in parens when provided", () => {
    const r = render(
      <Spinner
        active={true}
        verbs={["thinking"]}
        currentTool="fetch_projects"
        currentToolKind="request"
      />,
    );
    const frame = snapshot(r);
    expect(frame).toContain("running fetch_projects (request)…");
    r.unmount();
  });

  test("falls back to the verb when currentTool is null", () => {
    const r = render(<Spinner active={true} verbs={["composing"]} currentTool={null} />);
    const frame = snapshot(r);
    expect(frame).toContain("composing…");
    r.unmount();
  });

  test("renders empty placeholder when inactive (composer doesn't reflow)", () => {
    const r = render(<Spinner active={false} currentTool="dry_run_workflow" />);
    const frame = snapshot(r);
    expect(frame).not.toContain("running dry_run_workflow");
    r.unmount();
  });

  // Bug HH regression — pre-fix sessions dcdcf246 / 86de186b: when
  // every tool had returned but the LLM was still composing the
  // human-readable answer, the spinner cycled through verbs
  // ("considering" / "composing" / "reviewing") with no signal that
  // tool work had finished. Switching to "summarising N tool
  // result(s)…" gives the operator a concrete progress label.
  test("renders 'summarising N tool result(s)' when currentTool is null but tools have completed", () => {
    const r = render(
      <Spinner active={true} verbs={["thinking"]} currentTool={null} completedToolsThisTurn={3} />,
    );
    const frame = snapshot(r);
    expect(frame).toContain("summarising 3 tool results…");
    expect(frame).not.toContain("thinking…");
    r.unmount();
  });

  test("singularises 'tool result' when exactly one tool has completed", () => {
    const r = render(
      <Spinner active={true} verbs={["thinking"]} currentTool={null} completedToolsThisTurn={1} />,
    );
    const frame = snapshot(r);
    expect(frame).toContain("summarising 1 tool result…");
    r.unmount();
  });

  test("currentTool wins over completedToolsThisTurn when both are present", () => {
    // While a tool is still in flight the rolling running-tool label
    // is the most concrete signal — don't downgrade to the summary
    // line just because earlier tools have already finished.
    const r = render(
      <Spinner
        active={true}
        verbs={["thinking"]}
        currentTool="run_workflow"
        completedToolsThisTurn={2}
      />,
    );
    const frame = snapshot(r);
    expect(frame).toContain("running run_workflow…");
    expect(frame).not.toContain("summarising");
    r.unmount();
  });
});
