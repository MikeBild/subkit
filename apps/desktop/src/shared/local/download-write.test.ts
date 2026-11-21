import { describe, expect, test } from "bun:test";
import type { DeviceCommand } from "@shared/device/protocol.ts";
import { downloadWriteCommand } from "./download-write.ts";

const download: DeviceCommand = {
  command_id: "c".repeat(64),
  tenant_id: "t1",
  execution_id: "e1",
  task_run_id: null,
  conversation_id: null,
  step_id: "save",
  authority_id: "a1",
  manifest_digest: "d".repeat(64),
  kind: "browser.download",
  args: {
    ref: "e5",
    folder_id: "reports",
    name: "invoice.pdf",
    boundary: {
      device_id: "dev1",
      capability: "browser",
      folders: [{ folder_id: "reports", access: "write", root_digest: "r".repeat(64) }],
      sites: [{ origin: "https://shop.example.com", private: false, site_digest: "s".repeat(64) }],
    },
  },
  deadline_at: "2026-11-21T12:00:00.000Z",
  generation: 3,
  confirmation: null,
};

describe("a browser download is written through the files path", () => {
  test("as a new file in the named folder, under the approval of the download step", () => {
    expect(
      downloadWriteCommand({
        command: download,
        folder_id: "reports",
        name: "invoice.pdf",
        bytes: new Uint8Array([104, 105]),
      }),
    ).toEqual({
      ...download,
      kind: "files.write",
      args: {
        target: { folder_id: "reports", path: "invoice.pdf" },
        content: { encoding: "base64", data: "aGk=" },
        replace: false,
        boundary: {
          device_id: "dev1",
          capability: "files",
          folders: [{ folder_id: "reports", access: "write", root_digest: "r".repeat(64) }],
          sites: [
            { origin: "https://shop.example.com", private: false, site_digest: "s".repeat(64) },
          ],
        },
      },
    });
  });

  test("without an approval the write carries no boundary", () => {
    const written = downloadWriteCommand({
      command: { ...download, execution_id: null, args: { ref: "e5" } },
      folder_id: "reports",
      name: "a.pdf",
      bytes: new Uint8Array(),
    });
    expect(written.args).toEqual({
      target: { folder_id: "reports", path: "a.pdf" },
      content: { encoding: "base64", data: "" },
      replace: false,
    });
    expect(
      downloadWriteCommand({
        command: { ...download, args: null },
        folder_id: "x",
        name: "b.pdf",
        bytes: new Uint8Array([1]),
      }).args,
    ).not.toHaveProperty("boundary");
  });
});
