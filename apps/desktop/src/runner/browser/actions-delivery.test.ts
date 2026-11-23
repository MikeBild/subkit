import { describe, expect, test } from "bun:test";
import type { DeviceResult } from "@shared/device/protocol.ts";
import { command, live, ok, setup } from "./actions.fixture.ts";

describe("delivery after a click or key press", () => {
  const CLICK_UNCERTAIN: DeviceResult = {
    status: "failed",
    code: "delivery_uncertain",
    detail: "The click may have reached the page. SubKit does not repeat it.",
  };
  const KEY_UNCERTAIN: DeviceResult = {
    status: "failed",
    code: "delivery_uncertain",
    detail: "The key press may have reached the page. SubKit does not repeat it.",
  };
  const click = command("browser.press", { action: "click", ref: "e1" });
  const clicks = (calls: { tool: string }[]) =>
    calls.filter((call) => call.tool === "agent_browser_click").length;

  test("a failed page read after the click is uncertain and the click ran once", async () => {
    const { adapter, calls, steps } = setup(
      { url: "https://shop.example.com/", title: "" },
      {
        extra: {
          agent_browser_get_url: () =>
            Promise.resolve({ ok: false, code: "browser_unreadable", error: "no answer" }),
        },
      },
    );
    expect(await adapter.execute(click, live())).toEqual(CLICK_UNCERTAIN);
    expect(clicks(calls)).toBe(1);
    expect(steps.at(-1)).toMatchObject({ outcome: "failed", code: "delivery_uncertain" });
  });

  test("a click whose page settles on a blocked site is uncertain, not refused", async () => {
    const page = { url: "https://shop.example.com/", title: "" };
    const { adapter, calls } = setup(page, {
      refusal: "origin_not_allowed",
      extra: {
        agent_browser_click: () => {
          page.url = "chrome-error://chromewebdata/";
          return ok({});
        },
      },
    });
    expect(await adapter.execute(click, live())).toEqual(CLICK_UNCERTAIN);
    expect(clicks(calls)).toBe(1);
  });

  test("a stop after the click stays uncertain and still closes the page", async () => {
    const controller = new AbortController();
    const { adapter, teardowns, steps } = setup(
      { url: "https://shop.example.com/", title: "" },
      {
        extra: {
          agent_browser_click: () => {
            controller.abort();
            return ok({});
          },
        },
      },
    );
    expect(
      await adapter.execute(
        command("browser.press", { action: "click", ref: "e1", partition: "task-7" }),
        controller.signal,
      ),
    ).toEqual(CLICK_UNCERTAIN);
    expect(teardowns).toEqual(["task-7"]);
    expect(steps.at(-1)).toMatchObject({ outcome: "failed", code: "delivery_uncertain" });
  });

  test("a click that times out after it was handed over is uncertain", async () => {
    const { adapter, calls } = setup(
      { url: "https://shop.example.com/", title: "" },
      {
        extra: {
          agent_browser_click: () =>
            Promise.resolve({ ok: false, code: "browser_timeout", error: "slow" }),
        },
      },
    );
    expect(await adapter.execute(click, live())).toEqual(CLICK_UNCERTAIN);
    expect(clicks(calls)).toBe(1);
  });

  test("a stop before the click ends stopped and never clicks", async () => {
    const { adapter, calls, teardowns } = setup({ url: "https://shop.example.com/", title: "" });
    const controller = new AbortController();
    controller.abort();
    expect(await adapter.execute(click, controller.signal)).toEqual({ status: "stopped" });
    expect(clicks(calls)).toBe(0);
    expect(teardowns).toEqual(["default"]);
  });

  test("a key press with a failed page read is uncertain", async () => {
    const { adapter, calls } = setup(
      { url: "https://shop.example.com/", title: "" },
      {
        extra: {
          agent_browser_get_title: () =>
            Promise.resolve({ ok: false, code: "browser_unreadable", error: "no answer" }),
        },
      },
    );
    expect(
      await adapter.execute(command("browser.press", { action: "key", key: "Enter" }), live()),
    ).toEqual(KEY_UNCERTAIN);
    expect(calls.filter((call) => call.tool === "agent_browser_press")).toHaveLength(1);
  });

  test("navigation keys and refusals before the action keep their codes", async () => {
    const page = { url: "https://shop.example.com/", title: "" };
    const tab = setup(page, {
      extra: {
        agent_browser_get_url: () =>
          Promise.resolve({ ok: false, code: "browser_unreadable", error: "no answer" }),
      },
    });
    expect(
      await tab.adapter.execute(command("browser.press", { action: "key", key: "Tab" }), live()),
    ).toMatchObject({ status: "failed", code: "browser_unreadable" });
    const focused = setup({
      ...page,
      fields: {
        dpr: 1,
        fields: [
          { type: "password", autocomplete: "", focused: true, x: 0, y: 0, width: 5, height: 5 },
        ],
      },
    });
    expect(
      await focused.adapter.execute(command("browser.press", { action: "key", key: "a" }), live()),
    ).toMatchObject({ status: "refused", code: "credential_field" });
    const unreadable = setup({ ...page, fields: "nope" });
    expect(
      await unreadable.adapter.execute(
        command("browser.press", { action: "key", key: "a" }),
        live(),
      ),
    ).toMatchObject({ status: "failed", code: "field_check_unavailable" });
    const workflow = setup(page);
    expect(
      await workflow.adapter.execute(
        command(
          "browser.press",
          { action: "click", ref: "e1" },
          { execution_id: "e1", task_run_id: null },
        ),
        live(),
      ),
    ).toMatchObject({ status: "refused", code: "outside_boundary" });
    expect(workflow.calls).toEqual([]);
  });
});
