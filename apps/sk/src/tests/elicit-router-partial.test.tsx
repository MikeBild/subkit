// D3 — routes an `ask_user_confirm` PendingElicitation with
// `kind: "partial_diff_approval"` through `ElicitRouter` to the per-op
// PartialApprovalPrompt, and drives accept-all / partial / decline
// keystroke-by-keystroke, asserting the exact `approved_indices` response
// the engine's apply_workflow_patch dispatcher reads.

import { ElicitRouter } from "@chat-ui/index.ts";
import type { PendingElicitation } from "@cli-core/index.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";

async function yieldTick(ms = 40): Promise<void> {
  // allow-wall-clock: ink's keypress parser needs real ms.
  await new Promise((r) => setTimeout(r, ms));
}

async function writeKeys(instance: ReturnType<typeof render>, keys: string[]): Promise<void> {
  for (const k of keys) {
    instance.stdin.write(k);
    await new Promise((r) => setImmediate(r));
  }
  await yieldTick();
}

const KEY = { enter: "\r", down: "\x1b[B", space: " ", esc: "\x1b" } as const;

function partialElicitation(): PendingElicitation {
  return {
    id: "elicit-partial",
    tool_name: "ask_user_confirm",
    summary: "Keep these edits?",
    input: {
      question: "Keep these edits?",
      kind: "partial_diff_approval",
      diffs: [
        { label: "replace /steps/0/expression", preview: "return { a };" },
        { label: "replace /steps/1/expression", preview: "return { b };" },
      ],
      commit_intent: {
        kind: "apply_workflow_patch",
        payload: { patches: [{}, {}] },
        description: "Apply 2 edits.",
      },
    },
  };
}

afterEach(() => cleanup());

describe("ElicitRouter — partial_diff_approval (D3)", () => {
  test("renders per-op rows from the diffs payload", () => {
    const instance = render(
      <ElicitRouter elicitation={partialElicitation()} onResponse={mock()} />,
    );
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("replace /steps/0/expression");
    expect(frame).toContain("replace /steps/1/expression");
    expect(frame).toContain("2 approved");
  });

  test("accept-all: Enter with no toggles emits every index", async () => {
    const onResponse = mock();
    const instance = render(
      <ElicitRouter elicitation={partialElicitation()} onResponse={onResponse} />,
    );
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({
      confirmed: true,
      partial: false,
      approved_indices: [0, 1],
    });
  });

  test("partial: toggling off row 0 emits the remaining index with partial:true", async () => {
    const onResponse = mock();
    const instance = render(
      <ElicitRouter elicitation={partialElicitation()} onResponse={onResponse} />,
    );
    // Focus starts on row 0 → space toggles it off → Enter submits.
    await writeKeys(instance, [KEY.space, KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({
      confirmed: true,
      partial: true,
      approved_indices: [1],
    });
  });

  test("decline: toggling every row off then Enter emits confirmed:false", async () => {
    const onResponse = mock();
    const instance = render(
      <ElicitRouter elicitation={partialElicitation()} onResponse={onResponse} />,
    );
    // Toggle row 0 off, move to row 1, toggle it off, submit.
    await writeKeys(instance, [KEY.space, KEY.down, KEY.space, KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ confirmed: false });
  });
});
