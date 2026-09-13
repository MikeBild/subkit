// next_best_actions chip tests. Mounts `<InkApp>` end-to-end with a
// stubbed onPrompt that emits a tool result whose `next_best_actions`
// list should render as numbered chips. Asserts:
//
//   * The frame shows `[1] <tool_a>` and `[2] <tool_b>` chips.
//   * Pressing `1` with an empty composer dispatches a synthetic
//     `please run <tool_a>` prompt through onPrompt.
//   * Pressing `1` with a non-empty composer just inserts `1` — the
//     chip shortcut MUST NOT fire while the operator is typing
//     (e.g. partial slash arg, port number, free-text reply).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TurnEvent } from "@cli-core/index.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";

import { extractNextBestActions, InkApp, type InkAppProps } from "../ink-app.tsx";
import type { PersonaProbe } from "../slash.ts";

const ADMIN: PersonaProbe = { allows: () => true };

async function* framesOf(...events: TurnEvent[]): AsyncIterable<TurnEvent> {
  for (const ev of events) yield ev;
}

const histDirs: string[] = [];
function tmpHistory(): string {
  const d = mkdtempSync(join(tmpdir(), "sk-chips-"));
  histDirs.push(d);
  return join(d, "history.jsonl");
}

async function tick(ms = 40): Promise<void> {
  // allow-wall-clock: ink's input parser, like the journey tests in
  // ink-app.test.tsx, needs a real macrotask gap so async useEffects
  // and the keypress decoder both finish before we read the frame.
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll the rendered frame until a predicate matches. Same rationale as
 * ink-app.test.tsx's `waitForFrame`: fixed `tick(N)` waits race under
 * CI's parallel bun-test pressure, but local runs settle in <50 ms. Poll
 * up to maxMs (default 2 s) at stepMs intervals.
 */
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
      } catch {
        // ignore
      }
    }
  }
});

// First-turn helper — drives a turn whose tool result advertises the
// chip list under the inspect-view path so the ToolCard renders. The
// authoring-card path swallows certain tool names; we use a no-op
// tool name (`compile_widget`) so neither branch matches and the
// generic ToolCard fallback fires, with the chips appended below.
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
          // First turn — emit the chip-bearing tool result.
          // Subsequent turns — bare completion (the synthetic
          // `please run …` reply triggers a second onPrompt; we
          // don't need to emit anything more).
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
  // mount
  await tick();
  for (const p of prompts) {
    await type(instance, p);
    await pressEnter(instance);
  }
  // Inspect view (Ctrl-O) so the generic ToolCard renders for the
  // unrecognized tool name — the chips render under either path,
  // but inspect view also gives us the tool name in the frame for a
  // sanity check. Poll for the chip marker to land instead of a fixed
  // tick — CI's parallel runner can take 100+ ms wall-clock to settle.
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
    // First prompt was the user's `needs chips`. The chip handler
    // should fire on `1` and queue a synthetic prompt.
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
    // Type a non-empty buffer first so the chip-empty guard is broken.
    await type(instance, "abc");
    await tick(20);
    instance.stdin.write("1");
    await tick(60);
    // No new onPrompt call — the digit landed in the composer.
    expect(prompts).toEqual(["fail"]);
    const frame = instance.lastFrame() ?? "";
    // The composer line should now show `abc1` somewhere.
    expect(frame).toContain("abc1");
    instance.unmount();
  });

  test("digit 1..9 outside the chip list bounds is a no-op (no synthetic dispatch)", async () => {
    const { instance, prompts } = await driveChipTurn(["fail"], chipResult(["only_one"]));
    instance.stdin.write("3");
    await tick(60);
    // Index 2 (chip [3]) has no action — the helper bails out
    // without touching onPrompt. Nothing else should change.
    expect(prompts).toEqual(["fail"]);
    instance.unmount();
  });
});
