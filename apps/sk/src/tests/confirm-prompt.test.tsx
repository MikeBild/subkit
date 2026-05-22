// End-to-end keystroke tests for `ConfirmPrompt`. The prior
// implementation embedded `@inkjs/ui`'s `TextInput` for the optional
// decision-reason textarea — the TextInput's own `useInput` competed
// with the parent's, causing two concrete UX bugs:
//
//   1. Tab inside the reason toggled the whole panel closed (since
//      both `useInput` hooks fired on Tab), so the user couldn't
//      type Tab-containing reasons or, more critically, couldn't
//      even trust that Tab was editing text.
//   2. Enter inside the reason submitted the entire form with the
//      default approve/reject instead of committing the reason and
//      staying open for the user to deliberately pick 1, 3, or
//      arrow+Enter.
//
// After the rewrite, a single `useInput` in ConfirmPrompt dispatches
// all keystrokes. These tests pin that contract.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { ConfirmPrompt } from "@chat-ui/index.ts";
import { cleanup, render } from "ink-testing-library";

async function yieldTick(ms = 40): Promise<void> {
  // allow-wall-clock: ink's keypress parser needs real ms to
  // disambiguate Esc (\x1b) from the prefix of an arrow key.
  await new Promise((r) => setTimeout(r, ms));
}

async function writeKeys(instance: ReturnType<typeof render>, keys: string[]): Promise<void> {
  for (const k of keys) {
    instance.stdin.write(k);
    await new Promise((r) => setImmediate(r));
  }
  await yieldTick();
}

async function type(instance: ReturnType<typeof render>, text: string): Promise<void> {
  await writeKeys(instance, text.split(""));
}

const KEY = {
  tab: "\t",
  enter: "\r",
  esc: "\x1b",
  left: "\x1b[D",
  right: "\x1b[C",
  backspace: "\x7f",
} as const;

afterEach(() => cleanup());

describe("ConfirmPrompt — digit shortcuts", () => {
  test('"1" submits confirmed: true', async () => {
    const onResponse = mock();
    const instance = render(<ConfirmPrompt question="Proceed?" onResponse={onResponse} />);
    await writeKeys(instance, ["1"]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ confirmed: true });
  });

  test('"3" submits confirmed: false', async () => {
    const onResponse = mock();
    const instance = render(<ConfirmPrompt question="Proceed?" onResponse={onResponse} />);
    await writeKeys(instance, ["3"]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ confirmed: false });
  });
});

describe("ConfirmPrompt — arrow + Enter", () => {
  test("→ moves focus to Reject; Enter submits confirmed: false", async () => {
    const onResponse = mock();
    const instance = render(<ConfirmPrompt question="Proceed?" onResponse={onResponse} />);
    await writeKeys(instance, [KEY.right, KEY.enter]);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ confirmed: false });
  });

  test("default focus is Approve; plain Enter submits confirmed: true", async () => {
    const onResponse = mock();
    const instance = render(<ConfirmPrompt question="Proceed?" onResponse={onResponse} />);
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ confirmed: true });
  });

  test("destructive flips default focus to Reject; plain Enter rejects", async () => {
    const onResponse = mock();
    const instance = render(
      <ConfirmPrompt question="Wipe DB?" destructive={true} onResponse={onResponse} />,
    );
    // Frame marker: ▶ appears in front of Reject, not Approve.
    const frame = instance.lastFrame() ?? "";
    expect(frame).toMatch(/▶.*Reject/);
    expect(frame).not.toMatch(/▶.*Approve/);

    await writeKeys(instance, [KEY.enter]);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ confirmed: false });
  });
});

describe("ConfirmPrompt — reason textarea (regression for @inkjs/ui TextInput bug)", () => {
  test("Tab opens the reason panel; second Tab closes it without submitting", async () => {
    const onResponse = mock();
    const instance = render(<ConfirmPrompt question="Proceed?" onResponse={onResponse} />);
    await writeKeys(instance, [KEY.tab]);
    expect(instance.lastFrame() ?? "").toContain("reason (optional)");

    await writeKeys(instance, [KEY.tab]);
    expect(instance.lastFrame() ?? "").not.toContain("reason (optional)");
    expect(onResponse).not.toHaveBeenCalled();
  });

  test("typing inside the reason panel updates the reason without submitting the form", async () => {
    const onResponse = mock();
    const instance = render(<ConfirmPrompt question="Proceed?" onResponse={onResponse} />);
    await writeKeys(instance, [KEY.tab]);
    await type(instance, "because");
    expect(onResponse).not.toHaveBeenCalled();
    expect(instance.lastFrame() ?? "").toContain("because");
  });

  test("Enter inside the reason commits and closes the panel (does NOT submit)", async () => {
    const onResponse = mock();
    const instance = render(<ConfirmPrompt question="Proceed?" onResponse={onResponse} />);
    await writeKeys(instance, [KEY.tab]); // open
    await type(instance, "because");
    await writeKeys(instance, [KEY.enter]); // commit & close, but NOT submit
    expect(onResponse).not.toHaveBeenCalled();
    const frameAfterClose = instance.lastFrame() ?? "";
    expect(frameAfterClose).not.toContain("reason (optional)");
    // Footer should surface the kept reason so the user sees it's retained
    expect(frameAfterClose).toContain('reason: "because"');

    // Now the user deliberately submits with 1 and the reason is attached.
    await writeKeys(instance, ["1"]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    // Operator free text travels in `feedback` (output payload), not in
    // the machine-code-only `decision_reason` audit field.
    expect(onResponse.mock.calls[0]?.[0]).toEqual({
      confirmed: true,
      feedback: "because",
    });
  });

  test("Esc inside the reason closes the panel without losing the typed text", async () => {
    const onResponse = mock();
    const instance = render(<ConfirmPrompt question="Proceed?" onResponse={onResponse} />);
    await writeKeys(instance, [KEY.tab]); // open
    await type(instance, "note");
    await writeKeys(instance, [KEY.esc]); // close, keep text
    expect(instance.lastFrame() ?? "").toContain('reason: "note"');

    await writeKeys(instance, [KEY.tab]); // reopen
    expect(instance.lastFrame() ?? "").toContain("note");
    expect(onResponse).not.toHaveBeenCalled();
  });

  test("Backspace inside reason deletes the last character", async () => {
    const instance = render(<ConfirmPrompt question="Proceed?" onResponse={mock()} />);
    await writeKeys(instance, [KEY.tab]);
    await type(instance, "foo");
    await writeKeys(instance, [KEY.backspace, KEY.backspace]);
    expect(instance.lastFrame() ?? "").toContain("f");
    expect(instance.lastFrame() ?? "").not.toContain("foo");
  });
});

describe("ConfirmPrompt — inputDisabled", () => {
  test("inputDisabled suppresses all keystrokes", async () => {
    const onResponse = mock();
    const instance = render(
      <ConfirmPrompt question="Proceed?" onResponse={onResponse} inputDisabled={true} />,
    );
    await writeKeys(instance, ["1", "3", KEY.enter, KEY.tab, KEY.right]);
    expect(onResponse).not.toHaveBeenCalled();
  });
});

describe("ConfirmPrompt — decision metadata", () => {
  test("renders risk, target label, and reversibility rows", () => {
    const instance = render(
      <ConfirmPrompt
        question="Save draft?"
        riskLevel="medium"
        targetLabel="workflow: invoice-sync"
        reversible={false}
        onResponse={mock()}
      />,
    );
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("risk:");
    expect(frame).toContain("medium");
    expect(frame).toContain("target:");
    expect(frame).toContain("workflow: invoice-sync");
    expect(frame).toContain("reversible:");
    expect(frame).toContain("no");
  });
});
