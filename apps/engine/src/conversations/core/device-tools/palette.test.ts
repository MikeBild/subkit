import { describe, expect, test } from "bun:test";
import { localAgenticRefusal } from "../../../devices/core/run-source.ts";
import {
  type DeviceFacts,
  eligibleDevices,
  paletteTools,
  personalBoundary,
  pickDevice,
  type TurnFacts,
  turnPerson,
  turnRunSource,
} from "./palette.ts";

const ANNA = "anna";
const BEN = "ben";

const device = (over: Partial<DeviceFacts> = {}): DeviceFacts => ({
  device_id: "d1",
  owner_user_id: ANNA,
  label: "MacBook (Anna)",
  online: true,
  personal: ["browser", "files"],
  ...over,
});

const chat: TurnFacts = { person_id: ANNA, interactive: true, task: null };

describe("who the device tools are for", () => {
  test("a chat needs an interactive person; a task uses its owner unless sealed", () => {
    expect(turnPerson(chat)).toBe(ANNA);
    expect(turnPerson({ ...chat, interactive: false })).toBeNull();
    expect(
      turnPerson({
        person_id: BEN,
        interactive: true,
        task: { owner_id: ANNA, started_by: BEN, sealed: false },
      }),
    ).toBe(ANNA);
    expect(
      turnPerson({
        person_id: ANNA,
        interactive: true,
        task: { owner_id: ANNA, started_by: null, sealed: true },
      }),
    ).toBeNull();
  });

  test("only the person's own online devices with the personal switch on count", () => {
    expect(
      eligibleDevices(chat, [
        device(),
        device({ device_id: "d2", owner_user_id: BEN }),
        device({ device_id: "d3", online: false }),
        device({ device_id: "d4", personal: [] }),
        device({ device_id: "d5", personal: ["computer", "computer"] }),
      ]),
    ).toEqual([
      { device_id: "d1", label: "MacBook (Anna)", capabilities: ["browser", "files"] },
      { device_id: "d5", label: "MacBook (Anna)", capabilities: ["computer"] },
    ]);
    expect(eligibleDevices({ ...chat, interactive: false }, [device()])).toEqual([]);
    expect(
      eligibleDevices(
        {
          person_id: BEN,
          interactive: true,
          task: { owner_id: BEN, started_by: BEN, sealed: false },
        },
        [device()],
      ),
    ).toEqual([]);
  });

  test("the palette shows the tools of the switched-on capabilities only", () => {
    const names = paletteTools(eligibleDevices(chat, [device({ personal: ["files"] })])).map(
      (tool) => tool.name,
    );
    expect(names).toEqual([
      "files_list",
      "files_read",
      "files_write",
      "files_mkdir",
      "files_move",
      "files_trash",
    ]);
    expect(paletteTools([])).toEqual([]);
  });

  test("picking a device", () => {
    const one = eligibleDevices(chat, [device()]);
    const two = eligibleDevices(chat, [device(), device({ device_id: "d2" })]);
    expect(pickDevice(one, "browser", null)).toEqual({ ok: true, device: one[0] } as never);
    expect(pickDevice(one, "computer", null)).toEqual({ ok: false, reason: "no_device" } as never);
    expect(pickDevice(two, "browser", null)).toEqual({
      ok: false,
      reason: "choose_device",
    } as never);
    expect(pickDevice(two, "browser", "d2")).toEqual({ ok: true, device: two[1] } as never);
    expect(pickDevice(two, "computer", "d2")).toEqual({ ok: false, reason: "no_device" } as never);
    expect(pickDevice(two, "browser", "d9")).toEqual({ ok: false, reason: "no_device" } as never);
  });
});

describe("the run source of a turn", () => {
  test("a chat is started by its interactive person", () => {
    const source = turnRunSource(chat, ANNA);
    expect(source).toEqual({
      trigger: "chat",
      started_by: ANNA,
      schedule_created_by: null,
      device_owner: ANNA,
    });
    expect(localAgenticRefusal(source)).toBeNull();
    expect(localAgenticRefusal(turnRunSource(chat, BEN))).toBe("started_by_someone_else");
    expect(turnRunSource({ ...chat, interactive: false }, ANNA).started_by).toBeNull();
  });

  test("the owner's own schedule runs; a task someone else started refuses", () => {
    const scheduled = turnRunSource(
      {
        person_id: null,
        interactive: false,
        task: { owner_id: ANNA, started_by: null, sealed: false },
      },
      ANNA,
    );
    expect(scheduled).toEqual({
      trigger: "schedule",
      started_by: null,
      schedule_created_by: ANNA,
      device_owner: ANNA,
    });
    expect(localAgenticRefusal(scheduled)).toBeNull();
    const started = turnRunSource(
      {
        person_id: ANNA,
        interactive: true,
        task: { owner_id: ANNA, started_by: ANNA, sealed: false },
      },
      ANNA,
    );
    expect(started).toEqual({
      trigger: "task",
      started_by: ANNA,
      schedule_created_by: null,
      device_owner: ANNA,
    });
    expect(localAgenticRefusal(started)).toBeNull();
    const other = turnRunSource(
      {
        person_id: BEN,
        interactive: true,
        task: { owner_id: ANNA, started_by: BEN, sealed: false },
      },
      ANNA,
    );
    expect(localAgenticRefusal(other)).toBe("started_by_someone_else");
  });
});

describe("the personal boundary of a device", () => {
  test("keep-out folders and sites the person typed in", () => {
    expect(
      personalBoundary([
        {
          kind: "folder",
          display: "/Users/anna/Odd",
          entered_by: "person",
          keep_out_target: "folder",
        },
        {
          kind: "site",
          display: "http://192.168.1.10",
          entered_by: "person",
          keep_out_target: null,
        },
        {
          kind: "site",
          display: "https://a.example.com",
          entered_by: "approval",
          keep_out_target: null,
        },
        {
          kind: "keep_out",
          display: "/Users/anna/Private",
          entered_by: "person",
          keep_out_target: "folder",
        },
        {
          kind: "keep_out",
          display: "com.example.app",
          entered_by: "person",
          keep_out_target: "app",
        },
        {
          kind: "folder",
          display: "/Users/anna/Docs",
          entered_by: "person",
          keep_out_target: null,
        },
      ]),
    ).toEqual({
      sites: { entered_by_person: ["http://192.168.1.10"] },
      paths: { os: "darwin", data_dir: null, keep_out: ["/Users/anna/Private"] },
    });
  });
});
