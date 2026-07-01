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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ConfirmPrompt, resetHyperlinkSupportCacheForTests } from "@chat-ui/index.ts";
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

  test("summarizes external-write tool targets without dumping large args", () => {
    const markdown = `# Slides\n\n${"do not render this markdown body\n".repeat(200)}`;
    const instance = render(
      <ConfirmPrompt
        question="Approve workflow run?"
        kind="external_write"
        target={{
          tool: "run_workflow",
          args: {
            workflow: "render-upload-slides",
            environment: "dev",
            markdown,
            theme: "light",
          },
        }}
        onResponse={mock()}
      />,
    );
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("target:");
    expect(frame).toContain("run_workflow render-upload-slides env=dev");
    expect(frame).not.toContain("do not render this markdown body");
    expect(frame).not.toContain('"markdown"');
  });
});

describe("ConfirmPrompt — URL hyperlinks in summary", () => {
  // Hyperlink emission is now terminal-support-aware; the test env is
  // non-TTY so force OSC 8 on to exercise the supported path. (The plain
  // fallback path is covered in packages/chat-ui/src/tests/hyperlink.test.ts.)
  beforeEach(() => {
    process.env.SK_FORCE_HYPERLINKS = "1";
    resetHyperlinkSupportCacheForTests();
  });
  afterEach(() => {
    delete process.env.SK_FORCE_HYPERLINKS;
    resetHyperlinkSupportCacheForTests();
  });
  // Pre-fix the OAuth approval summary printed authorize URLs as plain
  // prose; Terminal.app's URL auto-detect cannot reassemble a wrapped
  // URL across multiple visual lines, so the user had to copy-paste
  // line fragments by hand. Modern terminals support OSC 8 hyperlinks
  // (\x1b]8;;URL\x07TEXT\x1b]8;;\x07); when the summary contains a URL
  // the renderer wraps it so the visible text remains the URL itself
  // but the terminal turns the token into a clickable target.
  test("wraps a URL in the summary with OSC 8 escapes", () => {
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&state=xyz";
    const instance = render(
      <ConfirmPrompt
        question="Authorize?"
        summary={`Authorize Google Workspace in your browser:\n${url}`}
        onResponse={mock()}
      />,
    );
    const frame = instance.lastFrame() ?? "";
    // OSC 8 prefix + URL + BEL terminator (visible URL) + closing OSC 8.
    expect(frame).toContain(`\x1b]8;;${url}\x07`);
    expect(frame).toContain(url);
    expect(frame).toContain("\x1b]8;;\x07");
  });

  test("leaves plain prose without URLs untouched", () => {
    const instance = render(
      <ConfirmPrompt
        question="Save?"
        summary="No links here — just prose about the workflow."
        onResponse={mock()}
      />,
    );
    const frame = instance.lastFrame() ?? "";
    // No OSC 8 escape sequence at all.
    expect(frame).not.toContain("\x1b]8;;");
    expect(frame).toContain("No links here");
  });

  test("trims trailing sentence punctuation from the link target", () => {
    const instance = render(
      <ConfirmPrompt
        question="Approve?"
        summary="See https://example.com/path."
        onResponse={mock()}
      />,
    );
    const frame = instance.lastFrame() ?? "";
    // The trailing `.` is part of the prose, not the URL — must stay
    // outside the OSC 8 hyperlink target.
    expect(frame).toContain("\x1b]8;;https://example.com/path\x07");
    expect(frame).not.toContain("\x1b]8;;https://example.com/path.\x07");
  });
});
