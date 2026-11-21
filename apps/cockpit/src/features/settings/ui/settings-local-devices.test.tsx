import { describe, expect, test } from "bun:test";
import { ApprovalDeviceRow } from "@/features/grants/ui/approval-device-row";
import type { LocalDeviceRow } from "@/features/settings/model/settings-local-devices-model";
import { render } from "../model/settings-fixtures";
import { LocalDeviceList } from "./settings-local-devices";

const row: LocalDeviceRow = {
  id: "d1",
  name: "MacBook Pro (Mike)",
  online: false,
  own: false,
  here: false,
  capabilities: ["files"],
  counts: { folder: 2, site: 1, app: 0 },
  lastSeen: null,
};

describe("devices for local steps in settings", () => {
  test("a row shows the device, its counts and capabilities, and a revoke button", () => {
    const html = render(<LocalDeviceList rows={[row]} onRevoke={() => {}} />);
    expect(html).toContain("MacBook Pro (Mike)");
    expect(html).toContain("2 Ordner · 1 Website · 0 Apps · Dateien");
    expect(html).toContain("Offline");
    expect(html).toContain("Gerät einer anderen Person");
    expect(html).toContain('data-testid="settings-local-device-revoke-0"');
  });

  test("this installation is marked, and can be managed only when the desktop offers it", () => {
    const here = { ...row, own: true, here: true };
    const plain = render(<LocalDeviceList rows={[here]} onRevoke={() => {}} />);
    expect(plain).toContain("Dieses Gerät");
    expect(plain).not.toContain("settings-local-device-manage-0");
    const offered = render(
      <LocalDeviceList rows={[here]} onRevoke={() => {}} onManageHere={() => {}} />,
    );
    expect(offered).toContain('data-testid="settings-local-device-manage-0"');
    expect(offered).toContain("Auf diesem Gerät verwalten");
    expect(
      render(<LocalDeviceList rows={[row]} onRevoke={() => {}} onManageHere={() => {}} />),
    ).not.toContain("settings-local-device-manage-0");
  });

  test("without devices the list says so", () => {
    expect(render(<LocalDeviceList rows={[]} onRevoke={() => {}} />, "en")).toContain(
      "No device runs local steps yet.",
    );
  });
});

describe("the device row of an approval", () => {
  const device = {
    deviceId: "d1",
    label: "MacBook Pro (Mike)",
    online: false,
    waiting: true,
    elsewhere: false,
  };

  test("on another installation it names the device and cannot be ticked", () => {
    const html = render(
      <ApprovalDeviceRow
        device={{ ...device, waiting: false, elsewhere: true }}
        checked
        disabled={false}
        onCheckedChange={() => {}}
      />,
    );
    expect(html).toContain(
      "Diesen Workflow gibst du nur auf „MacBook Pro (Mike)“ frei, also öffne SubKit dort.",
    );
    expect(html).toContain("disabled");
  });

  test("names the device and says the run waits while it is offline", () => {
    const html = render(
      <ApprovalDeviceRow device={device} checked disabled={false} onCheckedChange={() => {}} />,
    );
    expect(html).toContain("Darf auf „MacBook Pro (Mike)“ laufen");
    expect(html).toContain("Der Run wartet, bis das Gerät wieder da ist.");
    expect(html).toContain('data-testid="authority-device-run"');
  });

  test("unchecked, it says the workflow cannot run without the device", () => {
    const html = render(
      <ApprovalDeviceRow
        device={{ ...device, label: null, waiting: false }}
        checked={false}
        disabled={false}
        onCheckedChange={() => {}}
      />,
      "en",
    );
    expect(html).toContain("May run on “Desktop device”");
    expect(html).toContain(
      "Without the device, this workflow can’t run, so tick the box to approve it.",
    );
  });
});
