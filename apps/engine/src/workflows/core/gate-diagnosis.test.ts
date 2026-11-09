import { expect, test } from "bun:test";
import fc from "fast-check";
import type { GateDiagnosis } from "../gate-diagnosis.ts";
import {
  collapseDiagnoses,
  immediateReportRemedy,
  observedReportRemedy,
  planForDiagnosis,
} from "./gate-diagnosis.ts";

const definition = {
  steps: [
    { id: "encode", kind: "transform", expression: "({raw: sk.base64UrlEncode(scope.text)})" },
    { id: "send", kind: "request", method: "POST", body: { raw: `\${scope.encode.raw}` } },
  ],
};
const observed = {
  to: "to@example.org",
  from: "from@example.org",
  content_type: "text/plain" as const,
};
const diagnosis: GateDiagnosis = {
  code: "execution_authority_changed",
  subject: { step_id: "send" },
  evidence: {},
  remedy_kind: "author",
};

test("encoder refusals propose only applicable repairs and message errors need authoring", () => {
  for (const reason of ["not_utf8", "header_control_byte"] as const) {
    expect(immediateReportRemedy(definition, "send", reason, "run")).toEqual({
      evidence: { execution_id: "run" },
      remedy_kind: "patch",
      fixer: "use_utf8_encoder",
    });
    expect(immediateReportRemedy({}, "send", reason, undefined)).toEqual({
      evidence: {},
      remedy_kind: "author",
    });
  }
  expect(immediateReportRemedy(definition, "send", "not_json_raw", undefined)).toEqual({
    evidence: {},
    remedy_kind: "author",
  });
  expect(immediateReportRemedy(definition, "send", "recipient_differs", "run")).toBeNull();
  expect(immediateReportRemedy(definition, "send", null, undefined)).toBeNull();
});

test("observed declaration includes the observation run only for an applicable plan", () => {
  expect(
    observedReportRemedy(definition, "send", "old", { execution_id: "observation", observed }),
  ).toEqual({
    evidence: { execution_id: "observation", observed },
    remedy_kind: "declare",
    fixer: "declare_report_delivery",
  });
  expect(
    observedReportRemedy({}, "send", "old", { execution_id: "observation", observed }),
  ).toEqual({ evidence: { execution_id: "old" }, remedy_kind: "declare" });
  expect(observedReportRemedy(definition, "send", undefined, null)).toEqual({
    evidence: {},
    remedy_kind: "declare",
  });
});

test("plans dispatch to the named fixer only when its required evidence exists", () => {
  expect(planForDiagnosis(definition, { ...diagnosis, fixer: "use_utf8_encoder" })).toEqual({
    step_id: "encode",
    ops: [
      { op: "replace", path: "/expression", value: "({raw: sk.base64UrlEncodeUtf8(scope.text)})" },
    ],
  });
  expect(
    planForDiagnosis(definition, {
      ...diagnosis,
      fixer: "declare_report_delivery",
      evidence: { observed },
    })?.step_id,
  ).toBe("send");
  expect(
    planForDiagnosis(definition, { ...diagnosis, fixer: "declare_report_delivery" }),
  ).toBeNull();
  expect(planForDiagnosis(definition, diagnosis)).toBeNull();
});

test("collapse preserves first code and fixer priority, enriching only a missing execution without mutation", () => {
  const first: GateDiagnosis = {
    ...diagnosis,
    code: "report_delivery_unobserved",
    fixer: "declare_report_delivery",
    evidence: {},
  };
  const next: GateDiagnosis = {
    ...diagnosis,
    code: "report_delivery_contradicted",
    fixer: "declare_report_delivery",
    evidence: { execution_id: "run" },
  };
  const facts = Object.freeze([
    Object.freeze({ ...first, evidence: Object.freeze({}) }),
    Object.freeze(next),
    next,
    diagnosis,
  ]);
  const before = JSON.stringify(facts);
  const result = collapseDiagnoses(facts);
  expect(result).toEqual([{ ...first, evidence: { execution_id: "run" } }, diagnosis]);
  expect(JSON.stringify(facts)).toBe(before);
  expect(
    collapseDiagnoses([{ ...first, evidence: { execution_id: "first" } }, next])[0]?.evidence
      .execution_id,
  ).toBe("first");
  expect(collapseDiagnoses([first, { ...next, evidence: {} }])[0]?.evidence).toEqual({});
});

test("repeated diagnoses do not add output and never mutate their original evidence", () => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 20 }), (count) => {
      const facts = Object.freeze(
        Array.from({ length: count }, () =>
          Object.freeze({ ...diagnosis, evidence: Object.freeze({}) }),
        ),
      );
      expect(collapseDiagnoses(facts)).toEqual(count === 0 ? [] : [diagnosis]);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
