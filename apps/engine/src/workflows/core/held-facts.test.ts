import { expect, test } from "bun:test";
import fc from "fast-check";
import { gateEndpointKey, heldInspected, heldReason } from "./gate-diagnosis.ts";
import { REPORT_MESSAGE_REFUSALS } from "./report-refusal.ts";

test("held facts preserve first matching loop step, refusal and inspection presence", () => {
  const reason = REPORT_MESSAGE_REFUSALS[0]!;
  const steps = Object.freeze([
    Object.freeze({
      step_id: "send[1]",
      report_delivery_inspection: Object.freeze({ ok: false as const, reason }),
    }),
    Object.freeze({
      step_id: "send[2]",
      report_delivery_inspection: Object.freeze({ ok: true as const }),
    }),
    Object.freeze({ step_id: "uninspected" }),
    Object.freeze({
      step_id: "successful",
      report_delivery_inspection: Object.freeze({ ok: true as const }),
    }),
  ]);
  expect(heldInspected(steps, "send")).toBe(true);
  expect(heldReason(steps, "send")).toBe(reason);
  for (const id of ["missing", "uninspected", "send[1]"]) {
    expect(heldInspected(steps, id)).toBe(false);
    expect(heldReason(steps, id)).toBeNull();
  }
  expect(heldReason(steps, "successful")).toBeNull();
  expect(heldInspected(steps, "successful")).toBe(true);
  expect(heldInspected(undefined, "send")).toBe(false);
  expect(heldReason(undefined, "send")).toBeNull();
});

test("endpoint identities preserve arbitrary codes without normalizing them", () => {
  fc.assert(
    fc.property(fc.string(), (code) => {
      expect(gateEndpointKey(code)).toBe(`gate:${code}`);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});

test("loop suffixes accept multiple digits but never strip an internal bracket segment", () => {
  const reason = REPORT_MESSAGE_REFUSALS[0]!;
  const inspection = { ok: false as const, reason };
  expect(
    heldInspected([{ step_id: "send[12]", report_delivery_inspection: inspection }], "send"),
  ).toBe(true);
  expect(
    heldReason([{ step_id: "send[12]", report_delivery_inspection: inspection }], "send"),
  ).toBe(reason);
  expect(
    heldInspected(
      [{ step_id: "send[1].child", report_delivery_inspection: inspection }],
      "send.child",
    ),
  ).toBe(false);
  expect(
    heldReason(
      [{ step_id: "send[1].child", report_delivery_inspection: inspection }],
      "send.child",
    ),
  ).toBeNull();
});
