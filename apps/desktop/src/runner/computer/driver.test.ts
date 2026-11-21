import { describe, expect, test } from "bun:test";
import type { RawNode } from "../../shared/local/computer-tree.ts";
import { SAVE_SHEET_DE } from "../../shared/local/file-dialog.fixture.ts";
import {
  command,
  error,
  harness,
  NUMBERS,
  ON,
  ok,
  snap,
  snapshotFirst,
  tree,
  windows,
} from "./driver.fixture.ts";
import { COMPUTER_KINDS } from "./driver.ts";

describe("computer adapter", () => {
  test("the app list opens no live step, so the session takes the app name", async () => {
    const h = harness({ snapshot: snap() });
    await h.run(command("computer.apps", {}));
    await snapshotFirst(h);
    expect(h.progress.map((item) => item.progress)[0]).toEqual({
      type: "result",
      result: expect.anything(),
    });
    expect(h.progress.find((item) => item.progress.type === "running")?.progress).toEqual({
      type: "running",
      target: "Numbers",
    });
  });

  test("reports running with the app name, a waiting owner and a quiet result", async () => {
    let idle = 0;
    const h = harness(
      { click: ok("click", { disposition: { delivery: "delivered_unverified" } }) },
      {
        idleSeconds: async () => (idle++ === 0 ? 0 : 5),
      },
    );
    await snapshotFirst(h);
    await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" }));
    const press = h.progress
      .filter((item) => item.kind === "computer.press")
      .map((item) => item.progress);
    expect(press.map((item) => item.type)).toEqual([
      "running",
      "owner_typing",
      "owner_idle",
      "result",
    ]);
    expect(press[0]).toEqual({ type: "running", target: "Numbers" });
  });

  test("claims the implemented computer kinds", () => {
    expect([...COMPUTER_KINDS]).toEqual([
      "computer.apps",
      "computer.snapshot",
      "computer.screenshot",
      "computer.press",
      "computer.focus",
      "computer.select",
      "computer.set_value",
      "computer.type",
      "computer.key",
      "computer.scroll",
    ]);
  });

  test("lists only windows of allowed apps", async () => {
    const h = harness({});
    const result = await h.run(command("computer.apps", {}));
    expect(result).toEqual({
      status: "done",
      output: {
        windows: [
          {
            window_id: "w-1",
            bundle_id: NUMBERS,
            app: "Numbers",
            title: "Budget",
            focused: true,
            view_only: false,
          },
          {
            window_id: "w-4",
            bundle_id: "com.apple.Safari",
            app: "Safari",
            title: "News",
            focused: false,
            view_only: true,
          },
        ],
      },
      evidence: {},
    });
  });

  test("refuses while computer use is off and never starts the helper", async () => {
    const h = harness({}, {}, { ...ON, enabled: false });
    expect(await h.run(command("computer.apps", {}))).toMatchObject({
      status: "refused",
      code: "outside_allowance",
    });
    expect(h.fake.calls()).toEqual([]);
  });

  test("a snapshot masks password fields and records evidence without screen content", async () => {
    const h = harness({});
    const result = await h.run(command("computer.snapshot", { window_id: "w-1" }));
    if (result.status !== "done") throw new Error(JSON.stringify(result));
    const output = result.output as {
      tree: { children: unknown[] };
      audit: unknown;
      state_hash: string;
    };
    expect(output.tree.children[2]).toEqual({ role: "password", name: "[password, hidden]" });
    expect(output.audit).toEqual({
      app_bundle_id: NUMBERS,
      action: "computer.snapshot",
      ax_role: null,
      label_hash: null,
    });
    expect(result.evidence).toEqual({ after_version: output.state_hash });
    expect(h.fake.commands()).toEqual(["list-windows", "list-apps", "snapshot"]);
    expect(h.idleAsked()).toBe(0);
  });

  test("a snapshot of a blocked app is refused before it is read", async () => {
    const h = harness({});
    expect(await h.run(command("computer.snapshot", { window_id: "w-2" }))).toMatchObject({
      status: "refused",
      code: "blocked_app",
    });
    expect(h.fake.commands()).toEqual(["list-windows", "list-apps"]);
  });

  test("an unknown window is stale", async () => {
    const h = harness({});
    expect(await h.run(command("computer.snapshot", { window_id: "w-9" }))).toMatchObject({
      status: "refused",
      code: "stale",
    });
  });

  test("bad arguments fail before anything runs", async () => {
    const h = harness({});
    expect(await h.run(command("computer.press", { window_id: "w-1", ref: "@e2" }))).toMatchObject({
      status: "failed",
      code: "bad_args",
    });
    expect(await h.run(command("computer.snapshot", { window_id: "--headed" }))).toMatchObject({
      code: "bad_args",
    });
    expect(h.fake.calls()).toEqual([]);
  });

  test("a press waits for idle, checks the frontmost app, re-reads the window and presses by ref", async () => {
    const h = harness({
      click: ok("click", {
        action: "click",
        disposition: { delivery: "delivered_unverified", retry: "unsafe" },
      }),
    });
    await snapshotFirst(h);
    const result = await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" }));
    if (result.status !== "done") throw new Error(JSON.stringify(result));
    const output = result.output as {
      delivery: string;
      audit: { label_hash: string; ax_role: string };
    };
    expect(output.delivery).toBe("delivered_unverified");
    expect(output.audit.ax_role).toBe("button");
    expect(output.audit.label_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("Send");
    expect(h.idleAsked()).toBe(1);
    expect(h.fake.commands().slice(3)).toEqual([
      "list-windows",
      "list-apps",
      "snapshot",
      "click",
      "snapshot",
    ]);
    expect(h.fake.calls().at(-2)?.argv).toEqual(["click", "@s1:e2", "--timeout-ms", "5000"]);
  });

  test("a ref the runner never saw is stale and nothing runs", async () => {
    const h = harness({});
    expect(
      await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" })),
    ).toMatchObject({
      status: "refused",
      code: "stale",
    });
    expect(h.fake.calls()).toEqual([]);
  });

  test("a ref from another window is stale", async () => {
    const h = harness({});
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.press", { window_id: "w-4", ref: "@s1:e2" })),
    ).toMatchObject({
      code: "stale",
    });
  });

  test("acting on a password field is refused", async () => {
    const h = harness({});
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.type", { window_id: "w-1", ref: "@s1:e3", text: "1234" })),
    ).toMatchObject({
      status: "refused",
      code: "credential_field",
    });
    expect(h.fake.commands()).toEqual(["list-windows", "list-apps", "snapshot"]);
  });

  test("refuses when the frontmost app is not allowed", async () => {
    const h = harness({ "list-windows": [windows(), windows("w-2")] });
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" })),
    ).toMatchObject({
      status: "refused",
      code: "blocked_app",
    });
    expect(h.fake.commands()).not.toContain("click");
  });

  test("view-only apps cannot be operated", async () => {
    const h = harness({});
    expect(await h.run(command("computer.key", { window_id: "w-4", keys: "cmd+s" }))).toMatchObject(
      {
        code: "blocked_app",
      },
    );
  });

  test("hands over with owner_active while the person keeps typing", async () => {
    const h = harness(
      {},
      {
        idleSeconds: async () => 0,
        idlePolicy: { min_idle_s: 1, max_wait_ms: 3000, poll_ms: 250 },
      },
    );
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" })),
    ).toMatchObject({
      status: "refused",
      code: "owner_active",
    });
    expect(h.sleeps).toEqual([1000, 1000, 1000]);
    expect(
      h.progress.filter((item) => item.kind === "computer.press").map((item) => item.progress.type),
    ).toEqual(["running", "owner_typing", "result"]);
    expect(h.fake.commands()).not.toContain("click");
  });

  test("a stop during the idle wait ends the step", async () => {
    const controller = new AbortController();
    const h = harness({}, { idleSeconds: async () => 0, sleep: async () => controller.abort() });
    await snapshotFirst(h);
    expect(
      await h.run(
        command("computer.press", { window_id: "w-1", ref: "@s1:e2" }),
        controller.signal,
      ),
    ).toEqual({
      status: "stopped",
    });
  });

  test("a changed window is stale and nothing is pressed", async () => {
    const h = harness({ snapshot: [snap(), snap(tree(["secure"], "Delete"))] });
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" })),
    ).toMatchObject({
      code: "stale",
    });
    expect(h.fake.commands()).not.toContain("click");
  });

  test("an explicit state hash must match", async () => {
    const h = harness({});
    await snapshotFirst(h);
    expect(
      await h.run(
        command("computer.press", { window_id: "w-1", ref: "@s1:e2", state_hash: "0".repeat(64) }),
      ),
    ).toMatchObject({ code: "stale" });
  });

  test("typing sends the text on stdin only and re-checks the focus afterwards", async () => {
    const h = harness({
      type: ok("type", {
        action: "type",
        disposition: { delivery: "delivered_verified", retry: "unsafe" },
      }),
    });
    await snapshotFirst(h);
    const result = await h.run(
      command("computer.type", { window_id: "w-1", ref: "@s1:e1", text: "--headed 42" }),
    );
    expect(result.status).toBe("done");
    const typed = h.fake.calls().find((call) => call.argv[0] === "type");
    expect(typed?.argv).toEqual(["type", "@s1:e1", "--stdin"]);
    expect(typed?.stdin).toBe("--headed 42");
    expect(h.fake.commands().slice(-2)).toEqual(["type", "snapshot"]);
  });

  test("typing stops when a password field got the focus", async () => {
    const h = harness({
      snapshot: [snap(), snap(), snap(tree(["secure", "focused"]))],
      type: ok("type", { action: "type", disposition: { delivery: "delivered_verified" } }),
    });
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.type", { window_id: "w-1", ref: "@s1:e1", text: "x" })),
    ).toMatchObject({
      status: "failed",
      code: "secure_focus_after_input",
    });
  });

  test("typing is refused while a password field has focus", async () => {
    const focused = snap(tree(["secure", "focused"]));
    const h = harness({ snapshot: focused });
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.set_value", { window_id: "w-1", ref: "@s1:e1", value: "x" })),
    ).toMatchObject({
      code: "secure_focus",
    });
    expect(h.fake.commands()).not.toContain("set-value");
  });

  test("input that reached a password field fails", async () => {
    const h = harness({
      "set-value": ok("set-value", {
        disposition: { delivery: "delivered_unverified" },
        details: { verification_reason: "secure_field" },
      }),
    });
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.set_value", { window_id: "w-1", ref: "@s1:e1", value: "x" })),
    ).toMatchObject({
      status: "failed",
      code: "secure_field_touched",
    });
  });

  test("an unsupported press falls back to a pointer click in the middle of the control", async () => {
    const h = harness({
      click: error("click", "ACTION_NOT_SUPPORTED"),
      "mouse-click": ok("mouse-click", {
        action: "mouse-click",
        disposition: { delivery: "delivered_unverified" },
      }),
    });
    await snapshotFirst(h);
    const result = await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" }));
    expect(result.status).toBe("done");
    expect(h.fake.calls().at(-2)?.argv).toEqual(["--headed", "mouse-click", "--xy", "330,410"]);
  });

  test("no pointer fallback for stale refs", async () => {
    const h = harness({ click: error("click", "STALE_REF") });
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" })),
    ).toMatchObject({
      code: "stale",
    });
    expect(h.fake.commands()).not.toContain("mouse-click");
  });

  test("an uncertain delivery fails and is never repeated", async () => {
    const h = harness({ click: error("click", "TIMEOUT", "delivery_uncertain") });
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" })),
    ).toMatchObject({
      status: "failed",
      code: "delivery_uncertain",
    });
    expect(h.fake.commands().filter((name) => name === "click")).toHaveLength(1);
  });

  test("blocked shortcuts never reach the helper", async () => {
    const h = harness({});
    expect(await h.run(command("computer.key", { window_id: "w-1", keys: "cmd+q" }))).toMatchObject(
      {
        status: "refused",
        code: "blocked_shortcut",
      },
    );
    expect(h.fake.calls()).toEqual([]);
  });

  test("a key combo goes to the checked window", async () => {
    const h = harness({
      press: ok("press", { action: "press", disposition: { delivery: "delivered_unverified" } }),
    });
    const result = await h.run(command("computer.key", { window_id: "w-1", keys: "Command+S" }));
    expect(result.status).toBe("done");
    expect(h.fake.calls().find((call) => call.argv[0] === "press")?.argv).toEqual([
      "press",
      "cmd+s",
      "--window-id",
      "w-1",
    ]);
  });

  test("a missing permission from the helper is a refusal", async () => {
    const h = harness({ "list-windows": error("list-windows", "PERM_DENIED") });
    expect(await h.run(command("computer.snapshot", { window_id: "w-1" }))).toMatchObject({
      status: "refused",
      code: "permission_missing",
    });
  });

  const withDialog = () => {
    const base = tree();
    return { ...base, children: [...base.children, SAVE_SHEET_DE.children?.[1] as RawNode] };
  };

  test("a window with an open file dialog is neither read nor operated", async () => {
    const h = harness({ snapshot: snap(withDialog()) });
    expect(await h.run(command("computer.snapshot", { window_id: "w-1" }))).toEqual({
      status: "refused",
      code: "blocked_app",
      detail:
        "File dialogs are yours to use; for files SubKit uses the allowed folders. Nothing was sent.",
    });
    expect(
      await h.run(command("computer.key", { window_id: "w-1", keys: "return" })),
    ).toMatchObject({
      code: "blocked_app",
    });
    expect(h.fake.commands()).not.toContain("press");
  });

  test("an action is refused once a file dialog appeared after the snapshot", async () => {
    const h = harness({ snapshot: [snap(), snap(withDialog())] });
    await snapshotFirst(h);
    expect(
      await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" })),
    ).toMatchObject({
      status: "refused",
      code: "blocked_app",
    });
    expect(h.fake.commands()).not.toContain("click");
  });

  test("a press that opens a file dialog stops and hands over", async () => {
    const h = harness({
      snapshot: [snap(), snap(), snap(withDialog())],
      click: ok("click", { disposition: { delivery: "delivered_unverified" } }),
    });
    await snapshotFirst(h);
    expect(await h.run(command("computer.press", { window_id: "w-1", ref: "@s1:e2" }))).toEqual({
      status: "failed",
      code: "file_dialog_opened",
      detail:
        "A file dialog opened. File dialogs are yours to use; for files SubKit uses the allowed folders. SubKit stops here.",
    });
  });
});
