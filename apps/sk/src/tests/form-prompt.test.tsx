// End-to-end keystroke tests for `FormPrompt` — the multi-field
// `ask_user_form` prompt whose Tab navigation was swallowed by
// `@inkjs/ui`'s nested `useInput`, trapping users on field 0 (see
// the German "Urlaub" form in the bug report). These tests drive the
// real Ink renderer via `ink-testing-library` and assert on both the
// rendered frame and the `onResponse` spy.
//
// The fixture mirrors the screenshot payload: text required + number
// required with placeholder + boolean + select required.

import { type FormField, FormPrompt } from "@chat-ui/index.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";

// ---------- Helpers ----------

async function yieldTick(ms = 10): Promise<void> {
  // allow-wall-clock: ink's keypress parser needs real ms to
  // disambiguate Esc (\x1b) from the prefix of an arrow key.
  await new Promise((r) => setTimeout(r, ms));
}

async function writeKeys(instance: ReturnType<typeof render>, keys: string[]): Promise<void> {
  for (const k of keys) {
    instance.stdin.write(k);
    await new Promise((r) => setImmediate(r));
  }
  // 40ms — enough for Ink to detect a bare ESC as standalone (not the
  // prefix of a CSI/SS3 sequence) and to flush state updates.
  await yieldTick(40);
}

async function type(instance: ReturnType<typeof render>, text: string): Promise<void> {
  await writeKeys(instance, text.split(""));
}

const KEY = {
  tab: "\t",
  shiftTab: "\x1b[Z",
  enter: "\r",
  esc: "\x1b",
  backspace: "\x7f",
  left: "\x1b[D",
  right: "\x1b[C",
  space: " ",
} as const;

function fixtureFields(): FormField[] {
  return [
    { name: "subject", label: "Was soll genehmigt werden?", type: "text", required: true },
    {
      name: "stages",
      label: "Wie viele Genehmigungsstufen?",
      type: "number",
      placeholder: "z.B. 2 oder 3",
      required: true,
    },
    { name: "notify", label: "Sollen Benachrichtigungen gesendet werden?", type: "boolean" },
    {
      name: "source",
      label: "Woher kommen die Anträge?",
      type: "select",
      required: true,
      options: [
        { value: "webhook", label: "Webhook/API" },
        { value: "form", label: "Formular-Eingabe" },
        { value: "db", label: "Datenbank" },
        { value: "manual", label: "Manuelle Eingabe" },
      ],
    },
  ];
}

afterEach(() => cleanup());

// ---------- Tests ----------

describe("FormPrompt — rendering", () => {
  test("renders all four field types with the question, required markers, placeholder, and current values", () => {
    const onResponse = mock();
    const instance = render(
      <FormPrompt
        question="Lass uns deinen Genehmigungsprozess konfigurieren."
        fields={fixtureFields()}
        onResponse={onResponse}
      />,
    );

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Lass uns deinen Genehmigungsprozess konfigurieren.");
    expect(frame).toContain("Was soll genehmigt werden?");
    expect(frame).toContain("Wie viele Genehmigungsstufen?");
    expect(frame).toContain("Sollen Benachrichtigungen gesendet werden?");
    expect(frame).toContain("Woher kommen die Anträge?");
    expect(frame).toContain("[ ] no");
    expect(frame).toContain("Tab/Shift+Tab to navigate · Enter to submit");
    // select field shows all options; the currently-selected one is bracketed
    expect(frame).toContain("[Webhook/API]");
    expect(frame).toContain("Formular-Eingabe");
    expect(frame).toContain("Datenbank");
    expect(frame).toContain("Manuelle Eingabe");
    expect(onResponse).not.toHaveBeenCalled();
  });

  test("renders placeholder on unfocused empty fields", () => {
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} />,
    );
    const frame = instance.lastFrame() ?? "";
    // field 1 is unfocused at mount (cursor starts at 0)
    expect(frame).toContain("z.B. 2 oder 3");
  });

  test("empty fields array renders a no-fields hint without crashing", () => {
    const instance = render(<FormPrompt question="Q" fields={[]} onResponse={mock()} />);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("(no fields)");
  });
});

describe("FormPrompt — focus navigation (regression for Tab swallowing)", () => {
  test("Tab advances the focus marker from field 0 to field 1", async () => {
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} />,
    );
    await yieldTick();

    // Initial: ▶ before field 0's label
    expect(instance.lastFrame() ?? "").toMatch(/▶ Was soll genehmigt werden\?/);

    await writeKeys(instance, [KEY.tab]);
    expect(instance.lastFrame() ?? "").toMatch(/▶ Wie viele Genehmigungsstufen\?/);
  });

  test("four Tabs from field 0 wrap back to field 0", async () => {
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} />,
    );
    await writeKeys(instance, [KEY.tab, KEY.tab, KEY.tab, KEY.tab]);
    expect(instance.lastFrame() ?? "").toMatch(/▶ Was soll genehmigt werden\?/);
  });

  test("Shift+Tab from field 0 wraps to the last field", async () => {
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} />,
    );
    await writeKeys(instance, [KEY.shiftTab]);
    expect(instance.lastFrame() ?? "").toMatch(/▶ Woher kommen die Anträge\?/);
  });

  test("Tab is NOT swallowed while typing into a text field (primary bug)", async () => {
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} />,
    );
    await type(instance, "x");
    await writeKeys(instance, [KEY.tab]);
    const frame = instance.lastFrame() ?? "";
    // focus advanced
    expect(frame).toMatch(/▶ Wie viele Genehmigungsstufen\?/);
    // value preserved on field 0 (visible in the unfocused display)
    expect(frame).toContain("x");
  });
});

describe("FormPrompt — text and number input", () => {
  test("typing a word into the focused text field reflects in the frame", async () => {
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} />,
    );
    await type(instance, "urlaub");
    expect(instance.lastFrame() ?? "").toContain("urlaub");
  });

  test("Backspace deletes the last char", async () => {
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} />,
    );
    await type(instance, "urlaub");
    await writeKeys(instance, [KEY.backspace, KEY.backspace]);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("urla");
    expect(frame).not.toMatch(/urlaub(?!\w)/);
  });

  test("value preserved across focus changes (regression for uncontrolled TextInput)", async () => {
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} />,
    );
    await type(instance, "urlaub");
    await writeKeys(instance, [KEY.tab]); // focus → field 1
    await writeKeys(instance, [KEY.shiftTab]); // focus → field 0
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("urlaub");
  });

  test("number field rejects non-digit keys; accepts digits and . and -", async () => {
    const onResponse = mock();
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={onResponse} />,
    );
    // Tab to number field (index 1)
    await writeKeys(instance, [KEY.tab]);
    await type(instance, "a");
    // "a" should not have been inserted — number field still shows placeholder
    expect(instance.lastFrame() ?? "").toContain("z.B. 2 oder 3");
    await type(instance, "2");
    expect(instance.lastFrame() ?? "").toContain("2");
    await type(instance, ".5");
    expect(instance.lastFrame() ?? "").toContain("2.5");
  });
});

describe("FormPrompt — boolean and select", () => {
  test("Space toggles focused boolean; select unaffected", async () => {
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} />,
    );
    // Tab to boolean (index 2)
    await writeKeys(instance, [KEY.tab, KEY.tab]);
    await writeKeys(instance, [KEY.space]);
    expect(instance.lastFrame() ?? "").toContain("[✓] yes");
    await writeKeys(instance, [KEY.space]);
    expect(instance.lastFrame() ?? "").toContain("[ ] no");
  });

  test("Right arrow cycles focused select forward; Left cycles back with wrap", async () => {
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} />,
    );
    // Tab to select (index 3)
    await writeKeys(instance, [KEY.tab, KEY.tab, KEY.tab]);
    expect(instance.lastFrame() ?? "").toContain("[Webhook/API]");
    await writeKeys(instance, [KEY.right]);
    expect(instance.lastFrame() ?? "").toContain("[Formular-Eingabe]");
    await writeKeys(instance, [KEY.left, KEY.left]);
    // wrapped backwards from Webhook/API → Manuelle Eingabe (last option)
    expect(instance.lastFrame() ?? "").toContain("[Manuelle Eingabe]");
  });
});

describe("FormPrompt — submit and validation", () => {
  test("Enter with all required filled calls onResponse once with coerced values", async () => {
    const onResponse = mock();
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={onResponse} />,
    );
    await type(instance, "urlaub");
    await writeKeys(instance, [KEY.tab]); // → number
    await type(instance, "2");
    await writeKeys(instance, [KEY.enter]);

    expect(onResponse).toHaveBeenCalledTimes(1);
    const payload = onResponse.mock.calls[0]?.[0] as { values: Record<string, unknown> };
    expect(payload.values).toEqual({
      subject: "urlaub",
      stages: 2,
      notify: false,
      source: "webhook",
    });
  });

  test("Enter with missing required → no submit, error line visible, focus jumps to missing field", async () => {
    const onResponse = mock();
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={onResponse} />,
    );
    // Leave text required empty; Tab past number (also empty & required) — submit should point at field 0 first
    await writeKeys(instance, [KEY.tab, KEY.tab, KEY.tab]); // focus is on select now
    await writeKeys(instance, [KEY.enter]);

    expect(onResponse).not.toHaveBeenCalled();
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Please fill");
    // Focus jumped back to the first missing required field (subject = index 0)
    expect(frame).toMatch(/▶ Was soll genehmigt werden\?/);
  });

  test("Esc calls onCancel when provided", async () => {
    const onCancel = mock();
    const instance = render(
      <FormPrompt question="Q" fields={fixtureFields()} onResponse={mock()} onCancel={onCancel} />,
    );
    await writeKeys(instance, [KEY.esc]);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("FormPrompt — inputDisabled", () => {
  test("inputDisabled suppresses Tab, typing, and Enter", async () => {
    const onResponse = mock();
    const instance = render(
      <FormPrompt
        question="Q"
        fields={fixtureFields()}
        onResponse={onResponse}
        inputDisabled={true}
      />,
    );
    await writeKeys(instance, [KEY.tab]);
    await type(instance, "hello");
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).not.toHaveBeenCalled();
    // Focus marker did not move (still on field 0)
    expect(instance.lastFrame() ?? "").toMatch(/▶ Was soll genehmigt werden\?/);
  });

  test("password field masks keystroke echo but submits the plaintext", async () => {
    const onResponse = mock();
    const instance = render(
      <FormPrompt
        question="Credentials"
        fields={[{ name: "token", label: "API token", type: "password", required: true }]}
        onResponse={onResponse}
      />,
    );
    await type(instance, "secret123");
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("secret123");
    expect(frame).toContain("•••••••••");
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({ values: { token: "secret123" } });
  });

  test("text field with sensitive=true also masks the rendered value", async () => {
    const onResponse = mock();
    const instance = render(
      <FormPrompt
        question="Login"
        fields={[{ name: "pin", label: "PIN", type: "text", sensitive: true, required: true }]}
        onResponse={onResponse}
      />,
    );
    await type(instance, "0451");
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("0451");
    expect(frame).toContain("••••");
  });
});
