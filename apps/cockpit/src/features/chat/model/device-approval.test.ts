import { expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import { deviceApprovalRows, deviceLabelOf } from "./device-approval";

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);
const confirmation = {
  device_id: "d1",
  capability: "computer" as const,
  target: "Type into Numbers",
  deadline_at: "2030-01-01T00:00:00Z",
};

test("the device label comes from the person's own devices", () => {
  const devices = [
    { id: "d0", device_label: "Old Mac" },
    { id: "d1", device_label: "Studio" },
  ];
  expect(deviceLabelOf(devices, "d1")).toBe("Studio");
  expect(deviceLabelOf(devices, "d9")).toBeNull();
  expect(deviceLabelOf(undefined, "d1")).toBeNull();
});

test("rows name the device, the capability and the target in that order", () => {
  expect(deviceApprovalRows(confirmation, "Studio", t, "card")).toEqual([
    ["Device", "Studio", "card-device"],
    ["Uses", "Computer Use", "card-capability"],
    ["Target", "Type into Numbers", "card-target"],
  ]);
  const files = deviceApprovalRows({ ...confirmation, capability: "files" }, null, t, "c");
  expect(files[0]).toEqual(["Device", "Your device", "c-device"]);
  expect(files[1]?.[1]).toBe("Files");
  const browser = deviceApprovalRows({ ...confirmation, capability: "browser" }, null, t, "c");
  expect(browser[1]?.[1]).toBe("Browser");
});
