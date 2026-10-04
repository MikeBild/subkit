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
    await type(instance, "{");
    await writeKeys(instance, [KEY.enter]);
    await type(instance, '"a":1');
    await writeKeys(instance, [KEY.enter]);
    await type(instance, "}");
    await writeKeys(instance, [KEY.ctrlD]);
    const frame = instance.lastFrame() ?? "";
    expect(frame).not.toContain("invalid JSON");
    await writeKeys(instance, [KEY.tab, KEY.enter]);
    expect(onResponse).toHaveBeenCalledTimes(1);
    const payload = onResponse.mock.calls[0]?.[0] as { values: Record<string, unknown> };
    expect(payload.values.config).toBe('{\n"a":1\n}');
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
    await type(instance, "{");
    await writeKeys(instance, [KEY.tab]);
    const afterBlur = instance.lastFrame() ?? "";
    expect(afterBlur).toContain("invalid JSON");
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse).not.toHaveBeenCalled();
    await type(instance, "}");
    await writeKeys(instance, [KEY.ctrlD]);
    const afterFix = instance.lastFrame() ?? "";
    expect(afterFix).not.toContain("invalid JSON");
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
    let frame = instance.lastFrame() ?? "";
    expect(frame).toContain("[ ] read:org");
    expect(frame).toContain("[ ] write:repo");
    expect(frame).toContain("[ ] admin:user");
    await writeKeys(instance, [KEY.space]);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("[x] read:org");
    await writeKeys(instance, [KEY.down, KEY.down, KEY.space]);
    frame = instance.lastFrame() ?? "";
    expect(frame).toContain("[x] read:org");
    expect(frame).toContain("[x] admin:user");
    expect(frame).toContain("[ ] write:repo");
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

describe("FormPrompt — field metadata", () => {
  test("renders group/help text and submits defaults when unchanged", async () => {
    const onResponse = mock();
    const fields: FormField[] = [
      {
        name: "environment",
        label: "Environment",
        type: "select",
        group: "Target",
        help: "Pick the target deployment environment.",
        default: "prod",
        options: [
          { value: "dev", label: "Development" },
          { value: "prod", label: "Production" },
        ],
      },
      {
        name: "enabled",
        label: "Enabled",
        type: "boolean",
        default: true,
      },
    ];
    const instance = render(
      <FormPrompt question="Configure connector" fields={fields} onResponse={onResponse} />,
    );
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("Target");
    expect(frame).toContain("Pick the target deployment environment.");
    expect(frame).toContain("[Production]");
    await writeKeys(instance, [KEY.enter]);
    expect(onResponse.mock.calls[0]?.[0]).toEqual({
      values: { environment: "prod", enabled: true },
    });
  });

  test("orders fields by priority and renders multi-row text fields", async () => {
    const fields: FormField[] = [
      { name: "second", label: "Second", type: "text", priority: 2 },
      {
        name: "first",
        label: "First",
        type: "text",
        priority: 1,
        rows: 3,
        placeholder: "multi-line",
      },
    ];
    const instance = render(
      <FormPrompt question="Configure" fields={fields} onResponse={mock()} />,
    );
    const frame = instance.lastFrame() ?? "";
    expect(frame.indexOf("First")).toBeLessThan(frame.indexOf("Second"));
    expect(frame).toContain("multi-line");
    expect(frame).toContain("Enter for newline");
  });
});
