import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  browserRunning,
  browserScreenshot,
  endsSession,
  LIVE_SCREENSHOT_MAX_BYTES,
  LiveWireSchema,
  liveCapabilityOf,
  liveEventOf,
  liveWires,
  quietResult,
  sessionOf,
} from "./live-progress.ts";
import { INITIAL_LIVE, reduceLiveAll } from "./live-view-model.ts";

const TASK = {
  command_id: "c1",
  kind: "computer.press" as const,
  execution_id: null,
  task_run_id: "run-1",
  conversation_id: null,
  step_id: "step",
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("sessionOf", () => {
  test("a workflow run is a schedule session, a task run a task, a conversation a chat", () => {
    const none = { execution_id: null, task_run_id: null, conversation_id: null, step_id: "s" };
    expect(sessionOf({ ...none, execution_id: "e1", task_run_id: "r" })).toEqual({
      session_id: "e1",
      source: "schedule",
    });
    expect(sessionOf(TASK)).toEqual({ session_id: "run-1", source: "task" });
    expect(sessionOf({ ...none, conversation_id: "conv-1" })).toEqual({
      session_id: "conv-1",
      source: "chat",
    });
    expect(sessionOf(none)).toEqual({ session_id: "s", source: "chat" });
  });

  test("the session's capability follows the step", () => {
    expect(liveCapabilityOf("browser.open")).toBe("browser");
    expect(liveCapabilityOf("computer.press")).toBe("computer");
  });
});

describe("liveWires", () => {
  test("starts a session on the first step and only once", () => {
    const first = liveWires(null, TASK, { type: "running", target: "Numbers" });
    expect(first).toEqual({
      session: "run-1",
      wires: [
        {
          type: "started",
          session_id: "run-1",
          source: "task",
          capability: "computer",
          target: "Numbers",
        },
        { type: "running", command_id: "c1", kind: "computer.press", target: "Numbers" },
      ],
    });
    expect(
      liveWires("run-1", { ...TASK, command_id: "c2" }, { type: "running", target: "Numbers" }),
    ).toEqual({
      session: "run-1",
      wires: [{ type: "running", command_id: "c2", kind: "computer.press", target: "Numbers" }],
    });
  });

  test("results leave the screen content behind", () => {
    const done = {
      status: "done" as const,
      output: { tree: "secret" },
      evidence: { after_version: "x" },
    };
    expect(liveWires("run-1", TASK, { type: "result", result: done })).toEqual({
      session: "run-1",
      wires: [
        {
          type: "result",
          command_id: "c1",
          result: { status: "done", output: null, evidence: {} },
        },
      ],
    });
    const refusal = { status: "refused" as const, code: "owner_active" as const, detail: "d" };
    expect(quietResult(refusal)).toBe(refusal);
  });

  test("maps the other progress kinds", () => {
    expect(liveWires(null, TASK, { type: "owner_typing" }).wires).toEqual([
      { type: "owner_typing" },
    ]);
    expect(liveWires(null, TASK, { type: "owner_idle" }).wires).toEqual([{ type: "owner_idle" }]);
    expect(liveWires(null, TASK, { type: "injection" }).wires).toEqual([{ type: "injection" }]);
    expect(liveWires(null, TASK, { type: "handover" }).wires).toEqual([
      { type: "handover", command_id: "c1" },
    ]);
    expect(liveWires("s", TASK, { type: "screenshot", png: PNG, sha256: sha(PNG) })).toEqual({
      session: "s",
      wires: [{ type: "screenshot", png: PNG, sha256: sha(PNG) }],
    });
  });
});

describe("LiveWireSchema", () => {
  test("accepts the wire events and rejects anything else", () => {
    expect(LiveWireSchema.safeParse({ type: "owner_typing" }).success).toBe(true);
    expect(
      LiveWireSchema.safeParse({ type: "screenshot", png: PNG, sha256: sha(PNG) }).success,
    ).toBe(true);
    expect(
      LiveWireSchema.safeParse({ type: "screenshot", png: "AAAA", sha256: sha(PNG) }).success,
    ).toBe(false);
    expect(
      LiveWireSchema.safeParse({
        type: "screenshot",
        png: new Uint8Array(LIVE_SCREENSHOT_MAX_BYTES + 1),
        sha256: sha(PNG),
      }).success,
    ).toBe(false);
    expect(LiveWireSchema.safeParse({ type: "finished" }).success).toBe(false);
    expect(LiveWireSchema.safeParse({ type: "owner_typing", extra: 1 }).success).toBe(false);
  });
});

describe("liveEventOf", () => {
  test("passes screenshots only as PNG bytes that match their hash", () => {
    expect(liveEventOf({ type: "screenshot", png: PNG, sha256: sha(PNG) })).toEqual({
      event: { type: "screenshot" },
      screenshot: PNG,
    });
    expect(liveEventOf({ type: "screenshot", png: PNG, sha256: "0".repeat(64) })).toBeNull();
    const text = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(liveEventOf({ type: "screenshot", png: text, sha256: sha(text) })).toBeNull();
  });

  test("feeds the U3 live view model", () => {
    const wires = [
      ...liveWires(null, TASK, { type: "running", target: "Numbers" }).wires,
      { type: "owner_typing" as const },
    ];
    const events = wires.flatMap((wire) => {
      const live = liveEventOf(wire);
      return live ? [live.event] : [];
    });
    const state = reduceLiveAll(INITIAL_LIVE, events);
    expect(state.capability).toBe("computer");
    expect(state.target).toBe("Numbers");
    expect(state.status).toBe("typing");
    expect(state.steps).toEqual([
      { command_id: "c1", kind: "computer.press", target: "Numbers", status: "running" },
    ]);
  });
});

describe("browser steps in the live view", () => {
  const BROWSER = {
    ...TASK,
    kind: "browser.press" as const,
    task_run_id: null,
    conversation_id: "conv-1",
  };

  test("a browser session starts as a browser session in the chat", () => {
    const wires = liveWires(null, BROWSER, {
      type: "running",
      target: "https://shop.example",
    }).wires;
    const events = wires.flatMap((wire) => {
      const live = liveEventOf(wire);
      return live ? [live.event] : [];
    });
    const state = reduceLiveAll(INITIAL_LIVE, events);
    expect(state).toMatchObject({
      session_id: "conv-1",
      capability: "browser",
      source: "chat",
      target: "https://shop.example",
      status: "running",
    });
  });

  test("a step names its address, otherwise the page it is on", () => {
    expect(
      browserRunning({ kind: "browser.open", args: { url: "https://a.example/x" } }, "p"),
    ).toEqual({ type: "running", target: "https://a.example/x" });
    expect(
      browserRunning({ kind: "browser.press", args: { ref: "e1" } }, "https://b.example"),
    ).toEqual({ type: "running", target: "https://b.example" });
    expect(browserRunning({ kind: "browser.press", args: null }, null)).toEqual({
      type: "running",
      target: "",
    });
    expect(browserRunning({ kind: "browser.open", args: { url: "u".repeat(300) } }, null)).toEqual({
      type: "running",
      target: "u".repeat(200),
    });
  });

  test("a done screenshot becomes the live picture, with its hash", () => {
    const base64 = Buffer.from(PNG).toString("base64");
    expect(
      browserScreenshot({
        status: "done",
        output: { image: { mime: "image/png", base64 } },
        evidence: {},
      }),
    ).toEqual({ type: "screenshot", png: PNG, sha256: sha(PNG) });
    expect(browserScreenshot({ status: "done", output: { origin: "x" }, evidence: {} })).toBeNull();
    expect(browserScreenshot({ status: "stopped" })).toBeNull();
  });

  test("the session ends when its turn or task run ends", () => {
    const chat = JSON.stringify({ device_id: "d", conversation_id: "conv-1" });
    const run = JSON.stringify({ device_id: "d", task_run_id: "run-1" });
    expect(endsSession("device.session_ended", chat, "conv-1")).toBe(true);
    expect(endsSession("device.session_ended", run, "run-1")).toBe(true);
    expect(endsSession("device.session_ended", chat, "run-1")).toBe(false);
    expect(endsSession("device.command", chat, "conv-1")).toBe(false);
    expect(endsSession("execution.succeeded", chat, "conv-1")).toBe(false);
  });
});

describe("wire limits", () => {
  const ok = (value: unknown) => LiveWireSchema.safeParse(value).success;
  const running = { type: "running", command_id: "c1", kind: "computer.press", target: "Numbers" };

  test("every wire kind parses in its own shape", () => {
    const started = { type: "started", session_id: "s", capability: "browser", target: "" };
    expect(ok({ ...started, source: "chat" })).toBe(true);
    expect(ok({ ...started, source: "schedule", capability: "computer" })).toBe(true);
    expect(ok({ ...started, source: "task" })).toBe(true);
    expect(ok({ ...started, source: "other" })).toBe(false);
    expect(ok({ ...started, source: "chat", capability: "files" })).toBe(false);
    expect(ok(running)).toBe(true);
    expect(ok({ type: "result", command_id: "c1", result: { status: "stopped" } })).toBe(true);
    expect(ok({ type: "handover", command_id: "c1" })).toBe(true);
    expect(ok({ type: "owner_idle" })).toBe(true);
    expect(ok({ type: "injection" })).toBe(true);
  });

  test("ids and targets are bounded", () => {
    expect(ok({ ...running, target: "t".repeat(200) })).toBe(true);
    expect(ok({ ...running, target: "t".repeat(201) })).toBe(false);
    expect(ok({ ...running, command_id: "" })).toBe(false);
    expect(ok({ ...running, command_id: "c".repeat(200) })).toBe(true);
    expect(ok({ ...running, command_id: "c".repeat(201) })).toBe(false);
  });

  test("screenshots up to sixteen MiB with a plain sha256", () => {
    expect(LIVE_SCREENSHOT_MAX_BYTES).toBe(16_777_216);
    expect(
      ok({ type: "screenshot", png: new Uint8Array(LIVE_SCREENSHOT_MAX_BYTES), sha256: sha(PNG) }),
    ).toBe(true);
    expect(ok({ type: "screenshot", png: PNG, sha256: `x${sha(PNG)}` })).toBe(false);
    expect(ok({ type: "screenshot", png: PNG, sha256: `${sha(PNG)}x` })).toBe(false);
  });

  test("the whole PNG signature must match", () => {
    const fake = new Uint8Array([0x89, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(liveEventOf({ type: "screenshot", png: fake, sha256: sha(fake) })).toBeNull();
  });
});

describe("the engine stream ends a live session", () => {
  const data = JSON.stringify({ execution_id: "e-1" });

  test("when the session's run reaches an end", () => {
    for (const name of [
      "execution.succeeded",
      "execution.failed",
      "execution.aborted",
      "execution.timed_out",
      "execution.uncertain",
    ])
      expect(endsSession(name, data, "e-1")).toBe(true);
  });

  test("not for another run, a running run, no session or a broken frame", () => {
    expect(endsSession("execution.succeeded", data, "e-2")).toBe(false);
    expect(endsSession("execution.step.finished", data, "e-1")).toBe(false);
    expect(endsSession("execution.succeeded", data, null)).toBe(false);
    expect(endsSession("execution.succeeded", JSON.stringify({ execution_id: null }), null)).toBe(
      false,
    );
    expect(endsSession("execution.succeeded", "{", "e-1")).toBe(false);
    expect(endsSession("execution.succeeded", "null", "e-1")).toBe(false);
  });
});
