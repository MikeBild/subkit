import { describe, expect, test } from "bun:test";
import { command } from "../shared/local/runner-queue.fixture.ts";
import { type DeviceAdapter, routeCommands } from "./adapter.ts";

const files: DeviceAdapter = {
  name: "files",
  version: "1",
  kinds: ["files.list"],
  execute: async (item) => ({ status: "done", output: item.kind, evidence: {} }),
};

describe("routeCommands", () => {
  test("hands a command to the adapter that owns its kind", async () => {
    const route = routeCommands([files]);
    expect(await route(command("a"), new AbortController().signal)).toEqual({
      status: "done",
      output: "files.list",
      evidence: {},
    });
  });

  test("fails a kind no adapter owns", async () => {
    const route = routeCommands([files]);
    expect(
      await route(command("a", { kind: "browser.open" }), new AbortController().signal),
    ).toMatchObject({ status: "failed", code: "kind_not_ready" });
  });

  test("does not start an adapter after the signal was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await routeCommands([files])(command("a"), controller.signal)).toEqual({
      status: "stopped",
    });
  });

  test("refuses two adapters for the same kind", () => {
    expect(() => routeCommands([files, { ...files, name: "other" }])).toThrow(
      "Two device adapters claim files.list",
    );
  });
});
