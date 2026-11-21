import { expect, test } from "bun:test";
import { deviceProbeVerdict } from "./device-probe.ts";

test("a local connector probe checks the device and its capability", () => {
  expect(deviceProbeVerdict(null, "files")).toEqual({
    ok: false,
    error_code: "remote_resource_not_found",
    detail: "This device is no longer connected to this workspace. Nothing was sent.",
  });
  expect(deviceProbeVerdict({ online: false, capabilities: {} }, "files")).toEqual({
    ok: false,
    error_code: "remote_api_disabled",
    detail: "The device is offline. Open SubKit on it; nothing was sent.",
  });
  for (const capabilities of [{}, { capabilities: "files" }, { capabilities: ["browser"] }])
    expect(deviceProbeVerdict({ online: true, capabilities }, "files")).toEqual({
      ok: false,
      error_code: "remote_api_disabled",
      detail: "The device has files turned off in Settings › Local capabilities. Nothing was sent.",
    });
  expect(
    deviceProbeVerdict(
      { online: true, capabilities: { capabilities: ["files", "browser"] } },
      "browser",
    ),
  ).toEqual({ ok: true, detail: "The device is online and offers browser." });
});
