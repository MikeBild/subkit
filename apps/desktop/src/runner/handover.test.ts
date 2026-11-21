import { describe, expect, test } from "bun:test";
import type { DeviceCommand } from "@shared/device/protocol.ts";
import type { LiveProgress } from "../shared/local/live-progress.ts";
import { createHandover } from "./handover.ts";

function command(id: string, kind: DeviceCommand["kind"], args: unknown): DeviceCommand {
  return {
    command_id: id,
    tenant_id: "t",
    execution_id: null,
    task_run_id: null,
    conversation_id: "conv-1",
    step_id: "browser_handover",
    authority_id: null,
    manifest_digest: null,
    kind,
    args,
    deadline_at: "2026-11-21T12:00:00.000Z",
    generation: 0,
    confirmation: null,
  };
}

function setup() {
  const seen: [string, LiveProgress][] = [];
  const handover = createHandover("11.3.0", (cmd, progress) =>
    seen.push([cmd.command_id, progress]),
  );
  return { handover, seen };
}

describe("a step handed to the person", () => {
  test("the browser pauses, the live view learns why, and goes on once handed back", async () => {
    const { handover, seen } = setup();
    const waiting = handover.adapter.execute(
      command("a", "browser.handover", { partition: "c-1", reason: "Anmeldung" }),
      new AbortController().signal,
    );
    expect(seen).toEqual([
      ["a", { type: "running", target: "Anmeldung" }],
      ["a", { type: "handover" }],
    ]);
    handover.handBack("other");
    handover.handBack("a");
    expect(await waiting).toEqual({ status: "done", output: { handed_back: true }, evidence: {} });
  });

  test("on the Mac, stop ends the wait without going on", async () => {
    const { handover } = setup();
    const waiting = handover.adapter.execute(
      command("b", "computer.handover", { reason: "Passwort" }),
      new AbortController().signal,
    );
    handover.stop();
    expect(await waiting).toEqual({ status: "stopped" });
  });

  test("an aborted step stops, an aborted one never waits", async () => {
    const { handover, seen } = setup();
    const abort = new AbortController();
    const waiting = handover.adapter.execute(
      command("c", "computer.handover", { reason: "x" }),
      abort.signal,
    );
    abort.abort();
    expect(await waiting).toEqual({ status: "stopped" });
    const gone = new AbortController();
    gone.abort();
    expect(
      await handover.adapter.execute(
        command("d", "browser.handover", { reason: "x" }),
        gone.signal,
      ),
    ).toEqual({ status: "stopped" });
    expect(seen.some(([id]) => id === "d")).toBe(false);
  });

  test("a handover without a reason is not valid", async () => {
    const { handover } = setup();
    expect(
      await handover.adapter.execute(
        command("e", "browser.handover", {}),
        new AbortController().signal,
      ),
    ).toEqual({ status: "failed", code: "invalid_args", detail: "The handover is not valid." });
    expect(
      await handover.adapter.execute(
        command("f", "computer.handover", { reason: "x", partition: "c-1" }),
        new AbortController().signal,
      ),
    ).toMatchObject({ status: "failed" });
    expect(handover.adapter.name).toBe("handover");
    expect(handover.adapter.kinds).toEqual(["browser.handover", "computer.handover"]);
  });
});
