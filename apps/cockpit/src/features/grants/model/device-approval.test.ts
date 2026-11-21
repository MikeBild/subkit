import { describe, expect, test } from "bun:test";
import {
  approvalDevice,
  approvalDeviceIds,
  deviceGrantBlocked,
  deviceRefusal,
  deviceRefusalKey,
} from "@/features/grants/model/device-approval";
import { CATALOGS, translate } from "@/lib/i18n";

type Preview = Parameters<typeof approvalDevice>[0];
type Devices = NonNullable<Parameters<typeof approvalDevice>[1]>;

const DEVICE = "66666666-6666-4666-8666-666666666666";
const OTHER = "77777777-7777-4777-8777-777777777777";

const preview = (ids: (string | null)[]) =>
  ({
    manifest: {
      issues: [],
      effects: ids.map((id, index) => ({
        step_id: `s${index}`,
        ...(id ? { device: { device_id: id, capability: "files" } } : {}),
      })),
    },
    unavailable_steps: [],
  }) as unknown as Preview;

const listed = (online: boolean, label = "MacBook Pro (Mike)", here = true) =>
  [{ id: DEVICE, device_label: label, online, is_this_installation: here }] as unknown as Devices;

describe("the device a workflow runs on", () => {
  test("is named once, however many steps use it", () => {
    expect(approvalDeviceIds(preview([DEVICE, null, DEVICE]))).toEqual([DEVICE]);
    expect(approvalDeviceIds(null)).toEqual([]);
  });

  test("a workflow without a device shows no device row", () => {
    expect(approvalDevice(preview([null]), listed(true))).toBeNull();
  });

  test("a workflow that names two devices shows no row; the server refuses it", () => {
    expect(approvalDevice(preview([DEVICE, OTHER]), listed(true))).toBeNull();
  });

  test("an online device has a label and nothing waits", () => {
    expect(approvalDevice(preview([DEVICE]), listed(true))).toEqual({
      deviceId: DEVICE,
      label: "MacBook Pro (Mike)",
      online: true,
      waiting: false,
      elsewhere: false,
    });
  });

  test("on another installation the approval says where it works before anything is sent", () => {
    const device = approvalDevice(preview([DEVICE]), listed(false, "MacBook Pro (Mike)", false));
    expect(device?.elsewhere).toBe(true);
    expect(device?.waiting).toBe(false);
    expect(deviceGrantBlocked(device, true)).toBe(true);
    expect(approvalDevice(preview([DEVICE]), [] as unknown as Devices)?.elsewhere).toBe(true);
  });

  test("an offline device can still be approved; the run waits", () => {
    expect(approvalDevice(preview([DEVICE]), listed(false))?.waiting).toBe(true);
  });

  test("while the devices load, nothing claims the device is offline", () => {
    expect(approvalDevice(preview([DEVICE]), undefined)).toEqual({
      deviceId: DEVICE,
      label: null,
      online: false,
      waiting: false,
      elsewhere: false,
    });
  });

  test("a device without a name falls back to the generic label", () => {
    expect(approvalDevice(preview([DEVICE]), listed(true, "  "))?.label).toBeNull();
  });

  test("unchecking the device blocks the approval only when the workflow needs a device", () => {
    const device = approvalDevice(preview([DEVICE]), listed(true));
    expect(deviceGrantBlocked(device, false)).toBe(true);
    expect(deviceGrantBlocked(device, true)).toBe(false);
    expect(deviceGrantBlocked(null, false)).toBe(false);
  });
});

describe("device refusals of an approval", () => {
  test("only the three device codes are recognised", () => {
    expect(deviceRefusal("device_approval_elsewhere")).toBe("device_approval_elsewhere");
    expect(deviceRefusal("device_unavailable")).toBe("device_unavailable");
    expect(deviceRefusal("device_binding_multiple")).toBe("device_binding_multiple");
    expect(deviceRefusal("authority_effect_unbound")).toBeNull();
    expect(deviceRefusal(undefined)).toBeNull();
  });

  test("each reads as a sentence with a remedy in both languages", () => {
    for (const code of [
      "device_approval_elsewhere",
      "device_unavailable",
      "device_binding_multiple",
    ] as const) {
      const key = deviceRefusalKey(code);
      expect(CATALOGS.de[key]).toBeString();
      expect(CATALOGS.en[key]).toBeString();
    }
    expect(
      translate("de", deviceRefusalKey("device_approval_elsewhere"), {
        device: "MacBook Pro (Mike)",
      }),
    ).toBe(
      "Diese Freigabe geht nur auf dem Gerät selbst, also öffne SubKit auf „MacBook Pro (Mike)“ und gib den Workflow dort frei.",
    );
  });
});
