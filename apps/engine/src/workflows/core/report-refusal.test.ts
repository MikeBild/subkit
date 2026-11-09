import { expect, test } from "bun:test";
import {
  isReportMessageRefusal,
  REPORT_DELIVERY_DISCREPANCIES,
  REPORT_MESSAGE_REFUSALS,
  reportRefusalReason,
} from "./report-refusal.ts";

test("message faults and delivery discrepancies are recognized only for the authority-change code", () => {
  for (const reason of [...REPORT_MESSAGE_REFUSALS, ...REPORT_DELIVERY_DISCREPANCIES]) {
    expect(
      reportRefusalReason(Object.freeze({ code: "execution_authority_changed", reason })),
    ).toBe(reason);
    expect(reportRefusalReason({ code: "other", reason })).toBeNull();
    expect(isReportMessageRefusal(reason)).toBe(
      REPORT_MESSAGE_REFUSALS.some((message) => message === reason),
    );
  }
  for (const reason of [null, undefined, {}, [], 0, true, "", "unknown"]) {
    expect(reportRefusalReason({ code: "execution_authority_changed", reason })).toBeNull();
    expect(isReportMessageRefusal(reason)).toBe(false);
  }
  for (const error of [null, undefined, {}, false, "execution_authority_changed"])
    expect(reportRefusalReason(error)).toBeNull();
});

test("refusal membership never coerces callable or boxed values", () => {
  for (const reason of [
    Object(REPORT_MESSAGE_REFUSALS[0]),
    Object.assign(() => undefined, { toString: () => REPORT_MESSAGE_REFUSALS[0] }),
    Symbol("not_utf8"),
    1n,
  ]) {
    expect(isReportMessageRefusal(reason)).toBe(false);
    expect(reportRefusalReason({ code: "execution_authority_changed", reason })).toBeNull();
  }
});
