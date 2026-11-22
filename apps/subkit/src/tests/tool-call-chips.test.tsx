import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@cli-core/index.ts";
import { cleanup, render } from "ink-testing-library";
import { extractNextBestActions, InkApp, type InkAppProps } from "../ink-app.tsx";
import type { PersonaProbe } from "../slash.ts";

const ADMIN: PersonaProbe = { allows: () => true };

async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const ev of events) yield ev;
}

const histDirs: string[] = [];
function tmpHistory(): string {
  const d = mkdtempSync(join(tmpdir(), "subkit-chips-"));
  histDirs.push(d);
  return join(d, "history.jsonl");
}

async function tick(ms = 40): Promise<void> {
  // allow-wall-clock: ink's input parser, like the journey tests in
  // ink-app.test.tsx, needs a real macrotask gap so async useEffects
  // and the keypress decoder both finish before we read the frame.
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForFrame(
  instance: ReturnType<typeof render>,
  pred: (frame: string) => boolean,
  { maxMs = 2000, stepMs = 20 }: { maxMs?: number; stepMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + maxMs; // allow-wall-clock: budget is real ms (CI scheduler pressure, not fake time)
  while (Date.now() < deadline) {
    // allow-wall-clock: see comment above
    const frame = instance.lastFrame() ?? "";
    if (pred(frame)) return;
    await new Promise((r) => setTimeout(r, stepMs)); // allow-wall-clock: paced poll; the ink render commit + scheduler yield need real wall time
  }
}

async function type(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (const ch of text) {
    instance.stdin.write(ch);
    await new Promise((r) => setImmediate(r));
  }
  await tick(5);
}

async function pressEnter(instance: ReturnType<typeof render>): Promise<void> {
  instance.stdin.write("\r");
  await tick(40);
}

function defaultProps(overrides: Partial<InkAppProps> = {}): InkAppProps {
  return {
    persona: {
      label: "admin",
      tenant: "tenant-alpha",
      engineUrl: "http://localhost:8080",
      profileName: "test",
      probe: ADMIN,
    },
    statusLineConfig: { format: "{persona}", refreshMs: 999_999 },
    initialConversationId: null,
    model: "claude-sonnet-4-6",
    cwd: "/tmp/ws",
    historyPath: tmpHistory(),
    onPrompt: async () => ({
      events: framesOf({ type: "completed", status: "active" }),
      conversationId: "c0",
    }),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  while (histDirs.length > 0) {
    const d = histDirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  }
});

function chipResult(actions: string[]): unknown {
  return {
    ok: false,
    error_code: "needs_input",
    next_best_actions: actions,
  };
}

async function driveChipTurn(
  prompts: string[],
  result: unknown,
  toolName = "compile_widget",
): Promise<{
  instance: ReturnType<typeof render>;
  prompts: string[];
}> {
  const calls: string[] = [];
  const instance = render(
    <InkApp
      {...defaultProps({
        onPrompt: async (text) => {
          calls.push(text);
          if (calls.length === 1) {
            return {
              events: framesOf(
                {
                  type: "tool_call_start",
                  call_id: "t1",
                  tool: toolName,
                  input_partial: {},
                },
                { type: "tool_result", call_id: "t1", tool: toolName, output: result },
                { type: "completed", status: "active" },
              ),
              conversationId: "c-chip-1",
            };
          }
          return {
            events: framesOf({ type: "completed", status: "active" }),
            conversationId: "c-chip-1",
          };
        },
      })}
    />,
  );
  await tick();
  for (const p of prompts) {
    await type(instance, p);
    await pressEnter(instance);
  }
  instance.stdin.write("\x0f");
  await waitForFrame(instance, (f) => /\[1\]/.test(f));
  return { instance, prompts: calls };
}

describe("extractNextBestActions", () => {
  test("returns top-level next_best_actions when ok=false", () => {
    expect(
      extractNextBestActions({
        ok: false,
        next_best_actions: ["ask_user_form", "inspect_connector_draft"],
      }),
    ).toEqual(["ask_user_form", "inspect_connector_draft"]);
  });

  test("returns nested data.next_best_actions when ok=false", () => {
    expect(
      extractNextBestActions({
        ok: false,
        data: { next_best_actions: ["a", "b", "c"] },
      }),
    ).toEqual(["a", "b", "c"]);
  });

  test("returns [] when ok=true (chips only surface for failures)", () => {
    expect(extractNextBestActions({ ok: true, next_best_actions: ["ignored"] })).toEqual([]);
  });

  test("returns [] for non-object / null input", () => {
    expect(extractNextBestActions(null)).toEqual([]);
    expect(extractNextBestActions("oops")).toEqual([]);
    expect(extractNextBestActions(42)).toEqual([]);
  });

  test("clamps to 9 chips and drops blank/non-string entries", () => {
    expect(
      extractNextBestActions({
        ok: false,
        next_best_actions: ["a", "  b  ", "", null, 1, "c", "d", "e", "f", "g", "h", "i", "j"],
      }),
    ).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i"]);
  });
});

describe("chip rendering — frame contains numbered chips", () => {
  test("renders [1] ask_user_form and [2] inspect_connector_draft below the tool result", async () => {
    const { instance } = await driveChipTurn(
      ["fail with chips"],
      chipResult(["ask_user_form", "inspect_connector_draft"]),
    );
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("[1] ask_user_form");
    expect(frame).toContain("[2] inspect_connector_draft");
    expect(frame).toContain("suggested next");
    instance.unmount();
  });
});

describe("chip key handler — digits 1..9", () => {
  test("pressing 1 with an empty composer dispatches `please run <action>`", async () => {
    const { instance, prompts } = await driveChipTurn(
      ["needs chips"],
      chipResult(["ask_user_form", "inspect_connector_draft"]),
    );
    expect(prompts).toEqual(["needs chips"]);
    instance.stdin.write("1");
    await tick(60);
    expect(prompts).toEqual(["needs chips", "please run ask_user_form"]);
    instance.unmount();
  });

  test("pressing 2 dispatches the second action (`please run inspect_connector_draft`)", async () => {
    const { instance, prompts } = await driveChipTurn(
      ["fail"],
      chipResult(["ask_user_form", "inspect_connector_draft"]),
    );
    instance.stdin.write("2");
    await tick(60);
    expect(prompts.at(-1)).toBe("please run inspect_connector_draft");
    instance.unmount();
  });

  test("pressing 1 with a non-empty composer DOES NOT dispatch — digit is typed", async () => {
    const { instance, prompts } = await driveChipTurn(["fail"], chipResult(["ask_user_form"]));
    await type(instance, "abc");
    await tick(20);
    instance.stdin.write("1");
    await tick(60);
    expect(prompts).toEqual(["fail"]);
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("abc1");
    instance.unmount();
  });

  test("digit 1..9 outside the chip list bounds is a no-op (no synthetic dispatch)", async () => {
    const { instance, prompts } = await driveChipTurn(["fail"], chipResult(["only_one"]));
    instance.stdin.write("3");
    await tick(60);
    expect(prompts).toEqual(["fail"]);
    instance.unmount();
  });
});
