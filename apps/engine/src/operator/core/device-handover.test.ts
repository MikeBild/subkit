import { expect, test } from "bun:test";
import {
  type HandoverCommandRow,
  handoverAttentionItem,
  projectHandovers,
} from "./device-handover.ts";

const row = (over: Partial<HandoverCommandRow> = {}): HandoverCommandRow => ({
  device_id: "d1",
  device_label: "Studio Mac",
  owner_user_id: "u1",
  claimed_at: new Date("2026-11-23T10:00:00Z"),
  deadline_at: new Date("2026-11-23T10:30:00Z"),
  execution_id: null,
  conversation_id: "c1",
  ...over,
});

test("one waiting handover in a chat links to that chat", () => {
  const [handover] = projectHandovers([row()]);
  expect(handover).toEqual({
    device_id: "d1",
    device_label: "Studio Mac",
    owner_user_id: "u1",
    steps: 1,
    since: new Date("2026-11-23T10:00:00Z"),
    deadline: new Date("2026-11-23T10:30:00Z"),
    href: "/cockpit/chat/c1",
  });
});

test("a handover inside a run links to the run", () => {
  const [handover] = projectHandovers([row({ conversation_id: null, execution_id: "e 1" })]);
  expect(handover?.href).toBe("/cockpit/runs/e%201");
});

test("a handover with neither chat nor run links to the devices", () => {
  const [handover] = projectHandovers([row({ conversation_id: null })]);
  expect(handover?.href).toBe("/cockpit/settings?area=devices");
});

test("several handovers on one device fold into one entry with the earliest times", () => {
  const handovers = projectHandovers([
    row(),
    row({
      conversation_id: "c2",
      claimed_at: new Date("2026-11-23T09:50:00Z"),
      deadline_at: new Date("2026-11-23T10:40:00Z"),
    }),
    row({ device_id: "d2", device_label: "Laptop", owner_user_id: "u2" }),
  ]);
  expect(handovers.map((handover) => [handover.device_id, handover.steps])).toEqual([
    ["d1", 2],
    ["d2", 1],
  ]);
  expect(handovers[0]?.since).toEqual(new Date("2026-11-23T09:50:00Z"));
  expect(handovers[0]?.deadline).toEqual(new Date("2026-11-23T10:30:00Z"));
  expect(handovers[0]?.href).toBe("/cockpit/settings?area=devices");
});

test("no rows give no entries", () => {
  expect(projectHandovers([])).toEqual([]);
});

test("the attention item asks the owner to take over", () => {
  const [handover] = projectHandovers([row()]);
  if (!handover) throw new Error("expected a handover");
  expect(handoverAttentionItem(handover)).toEqual({
    id: "device_handover:d1",
    class: "decide",
    severity: "urgent",
    kind: "device_handover_waiting",
    subject: { kind: "device", id: "d1", name: "Studio Mac" },
    reason: "device_handover_waiting",
    trigger: null,
    cause_class: null,
    counts: {},
    since: "2026-11-23T10:00:00.000Z",
    deadline: "2026-11-23T10:30:00.000Z",
    detail: "1 step waits for you to take over on this device",
    actions: [{ verb: "open", href: "/cockpit/chat/c1", primary: true, permission: "device:read" }],
  });
  expect(handoverAttentionItem({ ...handover, steps: 3 }).detail).toBe(
    "3 steps wait for you to take over on this device",
  );
});
