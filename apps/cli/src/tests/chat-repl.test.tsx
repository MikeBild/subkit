// Component-level tests for the streaming chat surface. We feed the
// Ink app a canned async-iterable of TurnEvent frames and assert that
// (a) message + tool-call + approval + committed frames all render,
// (b) on Enter the onApproval callback fires with the approval id and
//     decision "approved",
// (c) the committed frame causes the stream loop to exit (the iterator
//     finishes; we observe the final rendered status).
//
// We deliberately don't spawn the CLI subprocess here — the test
// targets the React component path so it can run under bun test
// without a running engine.

import { describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import React from "react";
import { App } from "../chat-ui/app.tsx";
import { initialState, type TurnEvent } from "../chat-ui/hooks.ts";

/** Minimal controllable async-iterable for tests. */
function makeStream(): {
  iterable: AsyncIterable<TurnEvent>;
  push: (ev: TurnEvent) => void;
  end: () => void;
} {
  const buffer: TurnEvent[] = [];
  const waiters: Array<(v: IteratorResult<TurnEvent>) => void> = [];
  let closed = false;
  return {
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<TurnEvent> {
        return {
          next() {
            if (buffer.length > 0) {
              const value = buffer.shift() as TurnEvent;
              return Promise.resolve({ value, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined as unknown as TurnEvent, done: true });
            }
            return new Promise<IteratorResult<TurnEvent>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
    push(ev: TurnEvent) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: ev, done: false });
      else buffer.push(ev);
    },
    end() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const w = waiters.shift();
        w?.({ value: undefined as unknown as TurnEvent, done: true });
      }
    },
  };
}

/** Tiny scheduler tick — let queued microtasks flush. */
async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

describe("chat REPL component", () => {
  test("renders message, tool-call, approval, committed frames and surfaces approval decisions", async () => {
    const stream = makeStream();
    const decisions: Array<{ approvalId: string; decision: "approved" | "rejected" }> = [];
    const initial = initialState("conv-xyz", "tenant-z");

    const instance = render(
      React.createElement(App, {
        initial,
        stream: stream.iterable,
        onApproval: (d: { approvalId: string; decision: "approved" | "rejected" }) =>
          decisions.push(d),
      }),
    );

    // (a) message frame renders
    stream.push({ type: "message", role: "assistant", content: "hello world from agent" });
    await tick();
    expect(instance.lastFrame() ?? "").toContain("hello world from agent");

    // (b) tool-call frame shows tool name + status
    stream.push({ type: "tool_call", tool: "propose_step", input: { kind: "http" } });
    await tick();
    const afterTool = instance.lastFrame() ?? "";
    expect(afterTool).toContain("propose_step");
    expect(afterTool).toContain("running");

    // tool result transitions to done
    stream.push({ type: "tool_result", tool: "propose_step", output: { ok: true } });
    await tick();
    expect(instance.lastFrame() ?? "").toContain("done");

    // (c) approval frame renders Approve/Reject UI
    stream.push({
      type: "approval_request",
      approval_id: "appr-7",
      kind: "commit_draft",
      summary: "+ added http step echo",
    });
    await tick();
    const approvalFrame = instance.lastFrame() ?? "";
    expect(approvalFrame).toContain("approval needed");
    expect(approvalFrame).toContain("commit_draft");
    expect(approvalFrame).toContain("Approve");
    expect(approvalFrame).toContain("Reject");

    // (d) Enter (carriage return) triggers onApproval with "approved"
    instance.stdin.write("\r");
    await tick();
    expect(decisions).toEqual([{ approvalId: "appr-7", decision: "approved" }]);
    // The approval banner clears once decided.
    expect(instance.lastFrame() ?? "").not.toContain("approval needed");

    // (e) committed frame is reflected in status, stream end exits loop.
    stream.push({ type: "committed", workflow_id: "wf-42" });
    stream.push({ type: "completed", status: "committed" });
    stream.end();
    await tick();
    const finalFrame = instance.lastFrame() ?? "";
    expect(finalFrame).toContain("committed workflow wf-42");
    expect(finalFrame).toContain("conversation committed");

    instance.unmount();
    cleanup();
  });
});
