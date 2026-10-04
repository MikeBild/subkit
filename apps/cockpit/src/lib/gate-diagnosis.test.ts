import { describe, expect, test } from "bun:test";
import type { components } from "@/api/schema";
import { diagnosisActs, diagnosisRepairable } from "@/lib/gate-diagnosis";

type GateDiagnosis = components["schemas"]["GateDiagnosis"];

const RUN = "5b7d9f1a-3c2e-4a46-8b60-1d3f5a7c9e24";
const all = { write: true, run: true, chat: true };

function block(stepId: string, overrides: Partial<GateDiagnosis> = {}): GateDiagnosis {
  return {
    code: "execution_authority_changed",
    subject: { step_id: stepId },
    evidence: {},
    remedy_kind: "author",
    ...overrides,
  } as GateDiagnosis;
}

function diagnosis(diagnoses: GateDiagnosis[], isCurrent = true) {
  return { is_current: isCurrent, workflow_version_id: "version", diagnoses };
}

describe("diagnosisActs", () => {
  test("an act that does the same for every block is offered once", () => {
    const acts = diagnosisActs(
      diagnosis([
        block("send", { evidence: { execution_id: RUN } }),
        block("notify"),
        block("load", { remedy_kind: "prepare" }),
        block("store", { remedy_kind: "prepare" }),
        block("encode", { remedy_kind: "patch", fixer: "use_utf8_encoder", candidate_id: "c1" }),
        block("report", { remedy_kind: "patch", fixer: "use_utf8_encoder", candidate_id: "c2" }),
      ]),
      all,
    );
    expect(acts).toEqual({
      review: true,
      prepare: true,
      author: ["send", "notify"],
      authorRunId: RUN,
    });
  });

  test("a repair that is not filed yet is the step's own act, not a shared one", () => {
    const entry = block("encode", { remedy_kind: "patch", fixer: "use_utf8_encoder" });
    const acts = diagnosisActs(diagnosis([entry]), all);
    expect(acts).toEqual({ review: false, prepare: false, author: [], authorRunId: null });
    expect(diagnosisRepairable(entry, true, all)).toBe(true);
    expect(diagnosisRepairable(entry, false, all)).toBe(false);
    expect(diagnosisRepairable(entry, true, { write: false })).toBe(false);
  });

  test("a refused repair hands its step to an author", () => {
    const entry = block("encode", { remedy_kind: "patch", fixer: "use_utf8_encoder" });
    expect(diagnosisActs(diagnosis([entry]), all, ["encode"]).author).toEqual(["encode"]);
  });

  test("nothing is offered to a reader who may not perform it", () => {
    const acts = diagnosisActs(
      diagnosis([
        block("send"),
        block("load", { remedy_kind: "prepare" }),
        block("encode", { remedy_kind: "patch", fixer: "use_utf8_encoder", candidate_id: "c1" }),
      ]),
      { write: false, run: false, chat: false },
    );
    expect(acts).toEqual({ review: false, prepare: false, author: [], authorRunId: null });
  });

  test("a trial run needs a version to run", () => {
    const entries = [block("load", { remedy_kind: "prepare" })];
    expect(
      diagnosisActs({ is_current: true, workflow_version_id: null, diagnoses: entries }, all)
        .prepare,
    ).toBe(false);
  });
});
