// Coverage for the rich `ask_user_form` field types added in 2.7.0:
//   - `password` masks rendered keystrokes; final submission carries
//     the plaintext value.
//   - `json` accepts a multi-line buffer; Ctrl-D validates; invalid
//     JSON pins an inline error and blocks submit.
//   - `multi` is a checkbox grid; ↑/↓ move focus, Space toggles, the
//     submitted value is a `string[]` subset of `options`.
//
// All three new types are additive — the existing form-prompt tests
// (text/number/boolean/select/password) continue to pass with the
// FormPrompt rewrite untouched.

import { afterEach, describe, expect, mock, test } from "bun:test";
import { type FormField, FormPrompt } from "@chat-ui/index.ts";
import { cleanup, render } from "ink-testing-library";

async function yieldTick(ms = 40): Promise<void> {
  // allow-wall-clock: ink's keypress parser needs real ms to
  // disambiguate Esc (\x1b) from the prefix of an arrow key. Same
  // pattern the existing form-prompt suite uses.
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
  enter: "\r",
  tab: "\t",
  ctrlD: "\x04",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  esc: "\x1b",
} as const;

afterEach(() => cleanup());

describe("FormPrompt — password (rich type, regression)", () => {
  test("masks pasted bearer-token and submits the plaintext value", async () => {
    const onResponse = mock();
    const fields: FormField[] = [
      { name: "token", label: "API token", type: "password", required: true },
    ];
    const instance = render(
      <FormPrompt question="Credentials" fields={fields} onResponse={onResponse} />,
    );
    const secret = "dop_v1_abc123_secret_token";
    await type(instance, secret);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain(secret);
    expect(frame).toContain("•".repeat(secret.length));
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ values: { token: secret } });
  });
});

describe("FormPrompt — json (rich type)", () => {
  test("multi-line entry: Enter inserts newlines, Ctrl-D validates, valid JSON submits", async () => {
    const onResponse = mock();
    const fields: FormField[] = [
      { name: "config", label: "Config JSON", type: "json", required: true },
      { name: "trailing", label: "Trailing", type: "text", required: false },
    ];
    const instance = render(
      <FormPrompt question="Paste config" fields={fields} onResponse={onResponse} />,
    );
    // Type `{` Enter `"a":1` Enter `}` — Enter on a json field
    // inserts a newline rather than submitting the form.
    await type(instance, "{");
    await writeKeys(instance, [KEY.enter]);
    await type(instance, '"a":1');
    await writeKeys(instance, [KEY.enter]);
    await type(instance, "}");
    // Validate without leaving the field
    await writeKeys(instance, [KEY.ctrlD]);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("invalid JSON");
    // Tab off to the trailing text field, then Enter to submit.
    await writeKeys(instance, [KEY.tab, KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    const payload = onResponse.mock.calls[0]?.[0] as { values: Record<string, unknown> };
    expect(payload.values.config).toBe('{\n"a":1\n}');
    // Sanity: the buffer parses as JSON.
    expect(JSON.parse(payload.values.config as string)).toEqual({ a: 1 });
  });

  test("invalid JSON pins inline error and blocks submit", async () => {
    const onResponse = mock();
    const fields: FormField[] = [
      { name: "payload", label: "Payload", type: "json", required: true },
      { name: "label", label: "Name", type: "text", required: false },
    ];
    const instance = render(
      <FormPrompt question="Paste config" fields={fields} onResponse={onResponse} />,
    );
    // Type a malformed JSON: just an unclosed brace.
    await type(instance, "{");
    // Tab off — the renderer parses on blur and pins the error.
    await writeKeys(instance, [KEY.tab]);
    const afterBlur = instance.lastFrame() ?? "";
    expect(afterBlur).toContain("invalid JSON");
    // From the text field, attempt to submit with Enter — the
    // form-level validator notices the json field is invalid and
    // refuses, focus jumps back to the json field.
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).not.toHaveBeenCalled();
    // Focus is now on the json field (idx 0). Append `}` and validate.
    await type(instance, "}");
    await writeKeys(instance, [KEY.ctrlD]);
    const afterFix = instance.lastFrame() ?? "";
    expect(afterFix).not.toContain("invalid JSON");
    // Tab off to text field, then Enter to submit.
    await writeKeys(instance, [KEY.tab, KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    const payload = onResponse.mock.calls[0]?.[0] as { values: Record<string, unknown> };
    expect(payload.values.payload).toBe("{}");
  });
});

describe("FormPrompt — multi (rich type)", () => {
  test("arrow keys navigate, Space toggles, Enter submits a string[] subset", async () => {
    const onResponse = mock();
    const fields: FormField[] = [
      {
        name: "scopes",
        label: "Scopes",
        type: "multi",
        required: true,
        options: ["read:org", "write:repo", "admin:user"],
      },
    ];
    const instance = render(
      <FormPrompt question="Pick scopes" fields={fields} onResponse={onResponse} />,
    );
    // Initial: cursor on row 0 (read:org)
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("[ ] read:org");
    expect(frame).toContain("[ ] write:repo");
    expect(frame).toContain("[ ] admin:user");
    // Toggle the first option on
    await writeKeys(instance, [KEY.space]);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("[x] read:org");
    // Move down twice and toggle admin:user
    await writeKeys(instance, [KEY.down, KEY.down, KEY.space]);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("[x] read:org");
    expect(frame).toContain("[x] admin:user");
    expect(frame).toContain("[ ] write:repo");
    // Submit
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    const out = onResponse.mock.calls[0]?.[0] as { values: Record<string, unknown> };
    expect(out.values.scopes).toEqual(["read:org", "admin:user"]);
  });

  test("required multi with empty selection blocks submit", async () => {
    const onResponse = mock();
    const fields: FormField[] = [
      {
        name: "scopes",
        label: "Scopes",
        type: "multi",
        required: true,
        options: ["a", "b"],
      },
    ];
    const instance = render(
      <FormPrompt question="Pick scopes" fields={fields} onResponse={onResponse} />,
    );
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).not.toHaveBeenCalled();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Please fill");
  });
});
