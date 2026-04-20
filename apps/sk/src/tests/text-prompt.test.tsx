// End-to-end keystroke tests for `TextPrompt`. Mirrors the single-
// owner input model introduced alongside FormPrompt / ConfirmPrompt.
// Before the rewrite, `@inkjs/ui`'s embedded TextInput was the sole
// keystroke owner and Esc/backspace/regex-validation-error behavior
// was inconsistent with the rest of the ask-user family. These tests
// lock the new behavior in.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { TextPrompt } from "@chat-ui/index.ts";
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

const KEY = { enter: "\r", esc: "\x1b", backspace: "\x7f" } as const;

afterEach(() => cleanup());

describe("TextPrompt — typing and submit", () => {
  test("typing + Enter submits the text", async () => {
    const onResponse = mock();
    const instance = render(<TextPrompt question="Your name?" onResponse={onResponse} />);
    await type(instance, "mike");
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ text: "mike" });
  });

  test("Backspace deletes chars", async () => {
    const onResponse = mock();
    const instance = render(<TextPrompt question="?" onResponse={onResponse} />);
    await type(instance, "foo");
    await writeKeys(instance, [KEY.backspace]);
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ text: "fo" });
  });

  test("placeholder shown when value is empty", () => {
    const instance = render(
      <TextPrompt question="?" placeholder="type here…" onResponse={mock()} />,
    );
    expect(instance.lastFrame() ?? "").toContain("type here…");
  });
});

describe("TextPrompt — regex validation", () => {
  test("submit blocked on validation failure; error shown", async () => {
    const onResponse = mock();
    const instance = render(
      <TextPrompt question="digits only" validationRegex={"^\\d+$"} onResponse={onResponse} />,
    );
    await type(instance, "abc");
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).not.toHaveBeenCalled();
    expect(instance.lastFrame() ?? "").toContain("must match");
  });

  test("after clearing and typing a valid value, submit succeeds", async () => {
    const onResponse = mock();
    const instance = render(
      <TextPrompt question="?" validationRegex={"^\\d+$"} onResponse={onResponse} />,
    );
    await type(instance, "abc");
    await writeKeys(instance, [KEY.enter]); // blocked
    // After the regex-block, the error line is visible and value is still "abc".
    expect(instance.lastFrame() ?? "").toContain("must match");
    expect(instance.lastFrame() ?? "").toContain("abc");
    await writeKeys(instance, [KEY.backspace]);
    await writeKeys(instance, [KEY.backspace]);
    await writeKeys(instance, [KEY.backspace]);
    // Value should now be empty.
    expect(instance.lastFrame() ?? "").not.toContain("abc");
    await type(instance, "123");
    expect(instance.lastFrame() ?? "").toContain("123");
    expect(instance.lastFrame() ?? "").not.toContain("must match");
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ text: "123" });
  });

  test("invalid regex does not block submit (falls through gracefully)", async () => {
    const onResponse = mock();
    const instance = render(
      <TextPrompt question="?" validationRegex="[unclosed" onResponse={onResponse} />,
    );
    await type(instance, "hi");
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ text: "hi" });
  });
});

describe("TextPrompt — cancellation and disabled", () => {
  test("Esc calls onCancel when provided", async () => {
    const onCancel = mock();
    const instance = render(<TextPrompt question="?" onResponse={mock()} onCancel={onCancel} />);
    await writeKeys(instance, [KEY.esc]);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("inputDisabled renders static placeholder; typing is a no-op", async () => {
    const onResponse = mock();
    const instance = render(
      <TextPrompt
        question="?"
        placeholder="disabled"
        onResponse={onResponse}
        inputDisabled={true}
      />,
    );
    expect(instance.lastFrame() ?? "").toContain("disabled");
    await type(instance, "x");
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).not.toHaveBeenCalled();
  });
});
