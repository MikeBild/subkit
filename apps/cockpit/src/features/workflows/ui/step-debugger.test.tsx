import { describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { render } from "@/components/cockpit/patterns/test-utils";
import { StepDebuggerView } from "@/features/workflows/ui/step-debugger";

type Props = ComponentProps<typeof StepDebuggerView>;

function view(over: Partial<Props> = {}, run: Partial<Props["run"]> = {}): string {
  return render(
    <StepDebuggerView
      testId="debug"
      position={2}
      lastRun={{ scope: { fetch: { data: 1 } }, gaps: [{ step: "shape", reason: "too_large" }] }}
      mode="last_run"
      onMode={() => {}}
      ownText="{}"
      onOwnText={() => {}}
      ownError={null}
      onRun={() => {}}
      {...over}
      run={{
        phase: "idle",
        executionId: null,
        step: null,
        error: null,
        refusal: null,
        stopping: false,
        stopFailed: false,
        stop() {},
        ...run,
      }}
    />,
    "en",
  );
}

describe("step debugger view", () => {
  test("offers exactly one trial run action and names what the last run cannot provide", () => {
    const html = view();
    expect(html.split('data-testid="debug-run"').length - 1).toBe(1);
    expect(html).not.toContain('data-testid="debug-stop"');
    expect(html).toContain("Uses what 1 of the 2 steps before this one returned");
    expect(html).toContain("result is too large to reuse here");
    expect(html).not.toContain('data-testid="debug-result"');
  });

  test("the first step has no input choice", () => {
    const html = view({ position: 0, lastRun: { scope: {}, gaps: [] } });
    expect(html).toContain('data-testid="debug-first"');
    expect(html).not.toContain('data-testid="debug-input-own"');
  });

  test("own values show the editor and its error", () => {
    const html = view({ mode: "own", ownError: "not_json" });
    expect(html).toContain('id="debug-own"');
    expect(html).toContain("This is not valid JSON.");
  });

  test("a running test swaps the action for Stop", () => {
    const html = view({}, { phase: "running", executionId: "e1" });
    expect(html).toContain('data-testid="debug-stop"');
    expect(html).not.toContain('data-testid="debug-run"');
    expect(html).toContain("The step is running…");
  });

  test("a finished test shows plain fields and keeps the raw response in technical details", () => {
    const html = view(
      {},
      {
        phase: "succeeded",
        executionId: "e1",
        step: {
          id: "s",
          step_key: "send",
          step_index: 0,
          kind: "request",
          status: "succeeded",
          held: false,
          duration_ms: 5,
          retry_count: 0,
          result_storage_uri: null,
          result_sha256: null,
          result_preview: null,
          output_preview: { id: 7, title: "Hello" },
          credential_snapshots: [],
          started_at: null,
          finished_at: null,
        },
      },
    );
    expect(html).toContain("The step succeeded.");
    expect(html).toContain('data-testid="debug-fields"');
    expect(html).toContain("Hello");
    expect(html).toContain('data-testid="debug-technical"');
    expect(html).toContain('data-testid="debug-run"');
  });

  test("a failed test names the reason and an uncertain one links to the Run", () => {
    const failed = view({}, { phase: "failed", executionId: "e1", error: { message: "No route" } });
    expect(failed).toContain("The step failed.");
    expect(failed).toContain("No route");
    const uncertain = view({}, { phase: "uncertain", executionId: "e1" });
    expect(uncertain).toContain('data-testid="debug-open-run"');
  });

  test("a refused start shows the plain reason", () => {
    const html = view(
      {},
      { phase: "refused", refusal: { message: "nope", code: "caller_saved_workflow_required" } },
    );
    expect(html).toContain("The trial run could not start.");
    expect(html).toContain('data-testid="debug-refusal"');
  });
});
