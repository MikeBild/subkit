import { afterEach, describe, expect, mock, test } from "bun:test";
import { ElicitRouter } from "@chat-ui/index.ts";
import type { PendingElicitation } from "@cli-core/index.ts";
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

const KEY = { tab: "\t", enter: "\r" } as const;

afterEach(() => cleanup());

describe("ElicitRouter — ask_user_form", () => {
  test("renders FormPrompt from PendingElicitation payload and submits the typed values", async () => {
    const elicitation: PendingElicitation = {
      id: "elicit-1",
      tool_name: "ask_user_form",
      summary: "Lass uns deinen Genehmigungsprozess konfigurieren.",
      input: {
        question:
          "Lass uns deinen Genehmigungsprozess konfigurieren. Bitte gib mir ein paar Details:",
        fields: [
          { name: "subject", label: "Was soll genehmigt werden?", type: "text", required: true },
          {
            name: "stages",
            label: "Wie viele Genehmigungsstufen?",
            type: "number",
            placeholder: "z.B. 2 oder 3",
            required: true,
          },
          {
            name: "notify",
            label: "Sollen Benachrichtigungen gesendet werden?",
            type: "boolean",
          },
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
        ],
      },
    };

    const onResponse = mock();
    const instance = render(<ElicitRouter elicitation={elicitation} onResponse={onResponse} />);
    await yieldTick();

    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Bitte gib mir ein paar Details");
    expect(frame).toContain("Woher kommen die Anträge?");

    await type(instance, "urlaub");
    await writeKeys(instance, [KEY.tab]);
    await type(instance, "3");
    await writeKeys(instance, [KEY.enter]);

    expect(onResponse).toHaveBeenCalledTimes(1);
    const payload = onResponse.mock.calls[0]?.[0] as { values: Record<string, unknown> };
    expect(payload.values).toEqual({
      subject: "urlaub",
      stages: 3,
      notify: false,
      source: "webhook",
    });
  });

  test("falls back to summary when input.question is missing", () => {
    const elicitation: PendingElicitation = {
      id: "elicit-2",
      tool_name: "ask_user_form",
      summary: "fallback title",
      input: { fields: [{ name: "x", label: "x", type: "text" }] },
    };
    const instance = render(<ElicitRouter elicitation={elicitation} onResponse={mock()} />);
    expect(instance.lastFrame() ?? "").toContain("fallback title");
  });

  test("unknown tool_name renders the warning fallback", () => {
    const elicitation: PendingElicitation = {
      id: "elicit-3",
      tool_name: "ask_user_mystery",
      summary: "mystery prompt",
      input: {},
    };
    const instance = render(<ElicitRouter elicitation={elicitation} onResponse={mock()} />);
    expect(instance.lastFrame() ?? "").toContain("unknown elicitation");
  });
});
