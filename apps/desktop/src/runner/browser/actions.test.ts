import { describe, expect, test } from "bun:test";
import type { BrowserStep } from "@shared/device/browser.ts";
import type { DeviceCommand, DeviceResult } from "@shared/device/protocol.ts";
import type { ProxySiteRules } from "@shared/local-policy/proxy-decision.ts";
import pin from "../../../vendor/agent-browser.json";
import { sha256Hex } from "../../shared/local/browser-rules.ts";
import { BrowserPinSchema, browserLayout } from "../../shared/local/browser-runtime.ts";
import {
  type BrowserFiles,
  createBrowserAdapter,
  type DownloadSink,
  REFUSING_SINK,
} from "./actions.ts";
import type { AgentBrowserClient, AgentBrowserResult } from "./agent-browser.ts";
import { decodePng, encodePng } from "./png-redact.ts";

const layout = browserLayout("/data", BrowserPinSchema.parse(pin), "darwin-arm64", "/tmp-test");

type Handler = (args: Record<string, unknown>, signal: AbortSignal) => Promise<AgentBrowserResult>;

interface Page {
  url: string;
  title: string;
  fields?: unknown;
  attrs?: Record<string, string | null>;
}

function ok(data: unknown): Promise<AgentBrowserResult> {
  return Promise.resolve({ ok: true, data });
}

function fakeClient(page: Page, extra: Record<string, Handler> = {}) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const handlers: Record<string, Handler> = {
    agent_browser_get_url: () => ok({ url: page.url }),
    agent_browser_get_title: () => ok({ title: page.title }),
    agent_browser_open: (args) => {
      page.url = String(args.url);
      return ok({ url: page.url });
    },
    agent_browser_click: () => ok({}),
    agent_browser_press: () => ok({}),
    agent_browser_scroll: () => ok({}),
    agent_browser_fill: () => ok({}),
    agent_browser_type: () => ok({}),
    agent_browser_select: () => ok({}),
    agent_browser_snapshot: () => ok({ snapshot: '- button "Buy" [ref=e1]', refs: { e1: {} } }),
    agent_browser_get_text: () => ok({ text: "Hello page" }),
    agent_browser_wait_for_load: () => ok({}),
    agent_browser_wait_for_text: () => ok({}),
    agent_browser_wait_ms: () => ok({}),
    agent_browser_get_attr: (args) => ok({ value: page.attrs?.[String(args.name)] ?? null }),
    agent_browser_eval: () => ok({ result: JSON.stringify(page.fields ?? { dpr: 1, fields: [] }) }),
    agent_browser_screenshot: () => ok({ path: "x" }),
    agent_browser_download: () => ok({}),
    ...extra,
  };
  const client: AgentBrowserClient = {
    call(tool, args, signal) {
      calls.push({ tool, args });
      const handler = handlers[tool];
      if (!handler) return Promise.resolve({ ok: false, code: "unknown_tool", error: tool });
      return handler(args, signal);
    },
  };
  return { client, calls };
}

function memoryFiles(seed: Record<string, Uint8Array> = {}) {
  const store = new Map(Object.entries(seed));
  const purged: string[] = [];
  const files: BrowserFiles = {
    read: async (path) => store.get(path) ?? null,
    remove: async (path) => {
      store.delete(path);
    },
    purge: async (folder) => {
      purged.push(folder);
      for (const key of [...store.keys()]) if (key.startsWith(`${folder}/`)) store.delete(key);
    },
    mkdir: async () => {},
  };
  return { files, store, purged };
}

function command(
  kind: DeviceCommand["kind"],
  args: unknown,
  overrides: Partial<DeviceCommand> = {},
) {
  return {
    command_id: "cmd-1",
    tenant_id: "t1",
    execution_id: null,
    task_run_id: "task-1",
    conversation_id: null,
    step_id: "s1",
    authority_id: null,
    manifest_digest: null,
    kind,
    args,
    deadline_at: "2026-11-21T10:00:00.000Z",
    generation: 0,
    confirmation: null,
    ...overrides,
  } satisfies DeviceCommand;
}

function setup(
  page: Page,
  options: {
    extra?: Record<string, Handler>;
    seed?: Record<string, Uint8Array>;
    sink?: DownloadSink;
    refusal?: string | null;
    download?: Uint8Array;
  } = {},
) {
  const memory = memoryFiles(options.seed);
  const delivered = options.download;
  const downloadHandler: Record<string, Handler> =
    delivered === undefined
      ? {}
      : {
          agent_browser_download: (args) => {
            memory.store.set(String(args.path), delivered);
            return ok({});
          },
        };
  const { client, calls } = fakeClient(page, { ...downloadHandler, ...options.extra });
  const rules: ProxySiteRules[] = [];
  const steps: BrowserStep[] = [];
  const teardowns: string[] = [];
  const adapter = createBrowserAdapter({
    layout,
    version: "0.43.0",
    clientFor: () => client,
    setRules: (next) => rules.push(next),
    refusals: { reset: () => {}, last: () => options.refusal ?? null },
    allowances: () => ({
      sites: [
        { origin: "https://shop.example.com", entered_by: "approval" },
        { origin: "http://192.168.1.5", entered_by: "person" },
      ],
    }),
    sink: options.sink ?? REFUSING_SINK,
    files: memory.files,
    teardown: async (partition) => {
      teardowns.push(partition);
    },
    onStep: (step) => steps.push(step),
  });
  return { adapter, calls, rules, steps, teardowns, memory };
}

const live = () => new AbortController().signal;

function outputOf(result: DeviceResult): Record<string, unknown> {
  if (result.status !== "done") throw new Error(`expected done, got ${JSON.stringify(result)}`);
  return result.output as Record<string, unknown>;
}

describe("browser adapter", () => {
  test("open navigates an allowed site and records only origin and title hash", async () => {
    const page = { url: "about:blank", title: "Secret order 4711" };
    const { adapter, calls, rules, steps } = setup(page);
    const result = await adapter.execute(
      command("browser.open", { url: "https://shop.example.com/cart?id=4711" }),
      live(),
    );
    const output = outputOf(result);
    expect(output.origin).toBe("https://shop.example.com");
    const step = output.step as BrowserStep;
    expect(step).toEqual({
      action: "browser.open",
      origin: "https://shop.example.com",
      title_sha256: sha256Hex("Secret order 4711"),
      outcome: "done",
    });
    expect(JSON.stringify(step)).not.toContain("4711");
    expect(steps).toEqual([step]);
    expect(calls[0]).toEqual({
      tool: "agent_browser_open",
      args: { url: "https://shop.example.com/cart?id=4711" },
    });
    expect(rules[0]?.mode).toBe("personal");
    if (result.status === "done") expect(result.evidence.after_version).toStartWith("page:");
  });

  test("open refuses odd ports, private and non-web targets before the browser runs", async () => {
    for (const [url, code] of [
      ["https://bank.example.com:8443/", "origin_not_allowed"],
      ["http://10.0.0.1/", "private_address"],
      ["file:///etc/passwd", "origin_not_allowed"],
      ["ws://shop.example.com/", "origin_not_allowed"],
    ] as const) {
      const { adapter, calls, steps } = setup({ url: "about:blank", title: "" });
      const result = await adapter.execute(command("browser.open", { url }), live());
      expect(result).toMatchObject({ status: "refused", code });
      expect(calls).toEqual([]);
      expect(steps[0]).toMatchObject({ outcome: "refused", code, origin: null });
    }
  });

  test("a navigation the proxy blocked ends refused with the proxy's reason", async () => {
    const page = { url: "about:blank", title: "" };
    const { adapter } = setup(page, {
      refusal: "private_address",
      extra: {
        agent_browser_open: () => {
          page.url = "chrome-error://chromewebdata/";
          return ok({});
        },
      },
    });
    const result = await adapter.execute(
      command("browser.open", { url: "https://shop.example.com/" }),
      live(),
    );
    expect(result).toMatchObject({ status: "refused", code: "private_address" });
  });

  test("workflow runs use the approved sites intersected with the device allowance", async () => {
    const { adapter, rules } = setup({ url: "about:blank", title: "" });
    const boundary = {
      device_id: "d1",
      capability: "browser",
      sites: [
        { origin: "https://shop.example.com", private: false, site_digest: "a".repeat(64) },
        { origin: "https://other.example.com", private: false, site_digest: "b".repeat(64) },
      ],
    };
    await adapter.execute(
      command(
        "browser.open",
        { url: "https://other.example.com/", boundary },
        { execution_id: "e1", task_run_id: null },
      ),
      live(),
    );
    expect(rules[0]).toEqual({
      mode: "workflow",
      sites: [{ origin: "https://shop.example.com", entered_by: "approval" }],
    });
  });

  test("a workflow run without approved sites is refused before the browser runs", async () => {
    const { adapter, calls, rules } = setup({ url: "about:blank", title: "" });
    const result = await adapter.execute(
      command(
        "browser.open",
        { url: "https://shop.example.com/" },
        { execution_id: "e1", task_run_id: null },
      ),
      live(),
    );
    expect(result).toMatchObject({ status: "refused", code: "outside_boundary" });
    expect(calls).toEqual([]);
    expect(rules).toEqual([{ mode: "closed" }]);
  });

  test("fill refuses password, one-time code and card fields before typing", async () => {
    for (const attrs of [
      { type: "password", autocomplete: null },
      { type: "text", autocomplete: "one-time-code" },
      { type: "text", autocomplete: "billing cc-number" },
    ]) {
      const page = { url: "https://shop.example.com/", title: "", attrs };
      const { adapter, calls } = setup(page);
      const result = await adapter.execute(
        command("browser.fill", { mode: "fill", ref: "e3", text: "hunter2" }),
        live(),
      );
      expect(result).toMatchObject({ status: "refused", code: "credential_field" });
      expect(calls.some((call) => call.tool === "agent_browser_fill")).toBe(false);
      expect(JSON.stringify(result)).not.toContain("hunter2");
    }
  });

  test("fill, type and select reach the browser for ordinary fields", async () => {
    const page = { url: "https://shop.example.com/", title: "", attrs: { type: "email" } };
    const { adapter, calls } = setup(page);
    await adapter.execute(
      command("browser.fill", { mode: "type", ref: "@e3", text: "a@b.c" }),
      live(),
    );
    await adapter.execute(
      command("browser.fill", { mode: "select", ref: "e4", values: ["DE"] }),
      live(),
    );
    expect(calls.filter((call) => call.tool === "agent_browser_type")[0]?.args).toEqual({
      selector: "@e3",
      text: "a@b.c",
    });
    expect(calls.filter((call) => call.tool === "agent_browser_select")[0]?.args).toEqual({
      selector: "@e4",
      values: ["DE"],
    });
  });

  test("press covers click, key and scroll", async () => {
    const page = { url: "https://shop.example.com/", title: "Shop" };
    const { adapter, calls } = setup(page);
    for (const args of [
      { action: "click", ref: "e1" },
      { action: "key", key: "Enter" },
      { action: "scroll", direction: "down" },
    ]) {
      expect((await adapter.execute(command("browser.press", args), live())).status).toBe("done");
    }
    const tools = calls.map((call) => call.tool);
    expect(tools).toContain("agent_browser_click");
    expect(tools).toContain("agent_browser_press");
    expect(calls.find((call) => call.tool === "agent_browser_scroll")?.args).toEqual({
      direction: "down",
      amount: 600,
    });
  });

  test("keys are refused while a credential field has focus", async () => {
    const focusedPassword = {
      dpr: 1,
      fields: [
        { type: "password", autocomplete: "", focused: true, x: 0, y: 0, width: 5, height: 5 },
      ],
    };
    const page = { url: "https://shop.example.com/", title: "", fields: focusedPassword };
    const { adapter, calls } = setup(page);
    expect(
      await adapter.execute(command("browser.press", { action: "key", key: "a" }), live()),
    ).toMatchObject({ status: "refused", code: "credential_field" });
    expect(calls.some((call) => call.tool === "agent_browser_press")).toBe(false);
    expect(
      (await adapter.execute(command("browser.press", { action: "key", key: "Tab" }), live()))
        .status,
    ).toBe("done");
    expect(calls.filter((call) => call.tool === "agent_browser_eval")).toHaveLength(1);
    const unknown = setup({
      url: "https://shop.example.com/",
      title: "",
      fields: { dpr: 1, focus_unknown: true, fields: [] },
    });
    expect(
      await unknown.adapter.execute(command("browser.press", { action: "key", key: "x" }), live()),
    ).toMatchObject({ status: "refused", code: "credential_field" });
    const unreadable = setup({ url: "https://shop.example.com/", title: "", fields: "nope" });
    expect(
      await unreadable.adapter.execute(
        command("browser.press", { action: "key", key: "x" }),
        live(),
      ),
    ).toMatchObject({ status: "failed", code: "field_check_unavailable" });
  });

  test("snapshot, wait and extract pass page content only in the output", async () => {
    const page = { url: "https://shop.example.com/", title: "Shop" };
    const { adapter, steps } = setup(page);
    const snapshot = outputOf(await adapter.execute(command("browser.snapshot", {}), live()));
    expect(JSON.stringify(snapshot.snapshot)).toContain("Buy");
    for (const args of [{ for: "load" }, { for: "text", text: "Done" }, { for: "ms", ms: 5 }]) {
      expect((await adapter.execute(command("browser.wait", args), live())).status).toBe("done");
    }
    const text = outputOf(await adapter.execute(command("browser.extract", { ref: "e2" }), live()));
    expect(text.text).toBe("Hello page");
    expect(JSON.stringify(steps)).not.toContain("Buy");
    expect(JSON.stringify(steps)).not.toContain("Hello page");
  });

  test("invalid arguments and browser failures fail without page text", async () => {
    const { adapter } = setup(
      { url: "https://shop.example.com/", title: "" },
      {
        extra: {
          agent_browser_click: () =>
            Promise.resolve({ ok: false, code: "Element Not Found", error: "no @e9 near 'Hello'" }),
        },
      },
    );
    expect(
      await adapter.execute(command("browser.press", { action: "click", ref: "div.x" }), live()),
    ).toMatchObject({ status: "failed", code: "invalid_args" });
    const failed = await adapter.execute(
      command("browser.press", { action: "click", ref: "e9" }),
      live(),
    );
    expect(failed).toEqual({
      status: "failed",
      code: "browser_action",
      detail: "The browser action failed.",
    });
  });
});

describe("screenshots", () => {
  function screenshotSetup(fields: unknown, url = "https://shop.example.com/") {
    const pixels = new Uint8Array(20 * 10 * 4).fill(200);
    const png = encodePng({ width: 20, height: 10, channels: 4, pixels });
    const path = `${layout.captures}/${sha256Hex("cmd-1")}.png`;
    return setup({ url, title: "Shop", fields }, { seed: { [path]: png } });
  }

  test("credential fields are blacked out before the image leaves the device", async () => {
    const { adapter, memory } = screenshotSetup({
      dpr: 2,
      fields: [
        { type: "password", autocomplete: "", focused: false, x: 3, y: 2, width: 2, height: 1 },
        { type: "text", autocomplete: "", focused: true, x: 0, y: 0, width: 2, height: 2 },
      ],
    });
    const result = await adapter.execute(command("browser.screenshot", {}), live());
    const output = outputOf(result);
    const image = output.image as { mime: string; base64: string };
    expect(image.mime).toBe("image/png");
    const decoded = decodePng(Buffer.from(image.base64, "base64"));
    const at = (x: number, y: number) => [
      ...decoded.pixels.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 4),
    ];
    expect(at(4, 2)).toEqual([0, 0, 0, 255]);
    expect(at(13, 7)).toEqual([0, 0, 0, 255]);
    expect(at(0, 0)).toEqual([200, 200, 200, 200]);
    expect(at(19, 9)).toEqual([200, 200, 200, 200]);
    if (result.status === "done")
      expect(result.evidence.screenshot_ref).toBe(
        `sha256:${sha256Hex(Buffer.from(image.base64, "base64"))}`,
      );
    expect(memory.store.size).toBe(0);
  });

  test("a focused password field refuses the screenshot", async () => {
    const { adapter, calls } = screenshotSetup({
      dpr: 1,
      fields: [
        { type: "password", autocomplete: "", focused: true, x: 0, y: 0, width: 5, height: 5 },
      ],
    });
    const result = await adapter.execute(command("browser.screenshot", {}), live());
    expect(result).toMatchObject({ status: "refused", code: "secure_focus" });
    expect(calls.some((call) => call.tool === "agent_browser_screenshot")).toBe(false);
  });

  test("unreadable scans never send raw pixels", async () => {
    const broken = screenshotSetup("not json");
    expect(await broken.adapter.execute(command("browser.screenshot", {}), live())).toMatchObject({
      status: "failed",
      code: "redaction_unavailable",
    });
  });
});

describe("downloads", () => {
  test("a download reaches the folder only through the write path", async () => {
    const writes: { folder_id: string; name: string; size: number }[] = [];
    const sink: DownloadSink = {
      write: async (input) => {
        writes.push({ folder_id: input.folder_id, name: input.name, size: input.bytes.length });
        return {
          status: "done",
          output: { version: "v1" },
          evidence: { after_version: "file:v1" },
        };
      },
    };
    const { adapter, memory } = setup(
      { url: "https://shop.example.com/", title: "" },
      { download: new Uint8Array([1, 2, 3]), sink },
    );
    const result = await adapter.execute(
      command("browser.download", { ref: "e5", folder_id: "f1", name: "report.pdf" }),
      live(),
    );
    expect(outputOf(result)).toMatchObject({ file: { version: "v1" }, bytes: 3 });
    expect(writes).toEqual([{ folder_id: "f1", name: "report.pdf", size: 3 }]);
    expect(memory.store.size).toBe(0);
    expect(memory.purged).toContain(layout.downloads);
  });

  test("without an allowed folder, programs or empty files nothing is kept", async () => {
    const refusedSink = setup(
      { url: "https://shop.example.com/", title: "" },
      { download: new Uint8Array([1]) },
    );
    expect(
      await refusedSink.adapter.execute(
        command("browser.download", { ref: "e5", folder_id: "f1", name: "report.pdf" }),
        live(),
      ),
    ).toMatchObject({ status: "refused", code: "outside_allowance" });
    expect(refusedSink.memory.store.size).toBe(0);
    const program = setup({ url: "https://shop.example.com/", title: "" });
    expect(
      await program.adapter.execute(
        command("browser.download", { ref: "e5", folder_id: "f1", name: "setup.dmg" }),
        live(),
      ),
    ).toMatchObject({ status: "refused", code: "executable" });
    expect(program.calls).toEqual([]);
    const empty = setup(
      { url: "https://shop.example.com/", title: "" },
      { download: new Uint8Array() },
    );
    expect(
      await empty.adapter.execute(
        command("browser.download", { ref: "e5", folder_id: "f1", name: "report.pdf" }),
        live(),
      ),
    ).toMatchObject({ status: "refused", code: "too_large" });
  });
});

describe("stop", () => {
  test("a stop ends the running action and closes the page", async () => {
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { adapter, teardowns, steps } = setup(
      { url: "https://shop.example.com/", title: "" },
      {
        extra: {
          agent_browser_wait_ms: (_args, signal) =>
            new Promise((resolve) => {
              started();
              signal.addEventListener("abort", () =>
                resolve({ ok: false, code: "stopped", error: "Stopped." }),
              );
            }),
        },
      },
    );
    const controller = new AbortController();
    const pending = adapter.execute(
      command("browser.wait", { for: "ms", ms: 30000, partition: "task-7" }),
      controller.signal,
    );
    await running;
    controller.abort();
    expect(await pending).toEqual({ status: "stopped" });
    expect(teardowns).toEqual(["task-7"]);
    expect(steps.at(-1)?.outcome).toBe("stopped");
  });

  test("a command that arrives already stopped never reaches the browser", async () => {
    const { adapter, calls, teardowns } = setup({ url: "about:blank", title: "" });
    const controller = new AbortController();
    controller.abort();
    expect(
      await adapter.execute(
        command("browser.open", { url: "https://shop.example.com/" }),
        controller.signal,
      ),
    ).toEqual({ status: "stopped" });
    expect(calls.filter((call) => call.tool === "agent_browser_open")).toEqual([]);
    expect(teardowns).toEqual(["default"]);
  });
});
