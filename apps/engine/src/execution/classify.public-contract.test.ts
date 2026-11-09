import { expect, test } from "bun:test";
import * as refusal from "../workflows/core/report-refusal.ts";
import * as boundary from "../workflows/report-delivery-boundary.ts";
import * as api from "./classify.ts";
import { CONNECTOR_DISABLED_CODE } from "./connector-availability.ts";
import * as core from "./core/classify.ts";
import { classifyRunFailure } from "./outcome.ts";

test("classification and report refusal public paths preserve the same values and functions", () => {
  expect(api.PREVIEW_CLASSIFICATIONS).toBe(core.PREVIEW_CLASSIFICATIONS);
  expect(api.classifyRunResult).toBe(core.classifyRunResult);
  expect(api.isTransientRunResult).toBe(core.isTransientRunResult);
  expect(api.classifyFailure).toBe(core.classifyFailure);
  expect(api.classifyPersistedFailure).toBe(core.classifyPersistedFailure);
  expect(api.humanizeClassification).toBe(core.humanizeClassification);
  expect(classifyRunFailure).toBe(core.classifyRunFailure);
  expect(CONNECTOR_DISABLED_CODE).toBe("connector_disabled");
  expect(boundary.REPORT_MESSAGE_REFUSALS).toBe(refusal.REPORT_MESSAGE_REFUSALS);
  expect(boundary.REPORT_DELIVERY_DISCREPANCIES).toBe(refusal.REPORT_DELIVERY_DISCREPANCIES);
  expect(boundary.REPORT_DELIVERY_REFUSALS).toBe(refusal.REPORT_DELIVERY_REFUSALS);
  expect(boundary.reportRefusalReason).toBe(refusal.reportRefusalReason);
  expect(boundary.isReportMessageRefusal).toBe(refusal.isReportMessageRefusal);
});
