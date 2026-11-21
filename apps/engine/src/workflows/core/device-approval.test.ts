import { describe, expect, test } from "bun:test";
import { DEVICE_APPROVAL_REFUSALS, deviceApprovalRefusal } from "./device-approval.ts";

const DEVICE = "66666666-6666-4666-8666-666666666666";
const OTHER_DEVICE = "77777777-7777-4777-8777-777777777777";
const THIS_MAC = "44444444-4444-4444-8444-444444444444";
const BROWSER = "55555555-5555-4555-8555-555555555555";

describe("approving a workflow that names a device", () => {
  test("a workflow without a device is approved anywhere", () => {
    expect(deviceApprovalRefusal([], null, null)).toBeNull();
    expect(deviceApprovalRefusal([], BROWSER, null)).toBeNull();
  });

  test("the device's own desktop session may approve", () => {
    expect(
      deviceApprovalRefusal([DEVICE], THIS_MAC, { installation_id: THIS_MAC, revoked: false }),
    ).toBeNull();
  });

  test("another installation or a session without one must go to the device", () => {
    const registered = { installation_id: THIS_MAC, revoked: false };
    expect(deviceApprovalRefusal([DEVICE], BROWSER, registered)).toBe("device_approval_elsewhere");
    expect(deviceApprovalRefusal([DEVICE], null, registered)).toBe("device_approval_elsewhere");
  });

  test("an unknown or revoked device cannot be approved", () => {
    expect(deviceApprovalRefusal([DEVICE], THIS_MAC, null)).toBe("device_unavailable");
    expect(
      deviceApprovalRefusal([DEVICE], THIS_MAC, { installation_id: THIS_MAC, revoked: true }),
    ).toBe("device_unavailable");
  });

  test("two devices in one workflow are refused before anything else", () => {
    expect(
      deviceApprovalRefusal([DEVICE, OTHER_DEVICE], THIS_MAC, {
        installation_id: THIS_MAC,
        revoked: false,
      }),
    ).toBe("device_binding_multiple");
  });

  test("every refusal has a message", () => {
    expect(Object.keys(DEVICE_APPROVAL_REFUSALS)).toEqual([
      "device_binding_multiple",
      "device_unavailable",
      "device_approval_elsewhere",
    ]);
    for (const message of Object.values(DEVICE_APPROVAL_REFUSALS))
      expect(message.length).toBeGreaterThan(20);
  });
});
