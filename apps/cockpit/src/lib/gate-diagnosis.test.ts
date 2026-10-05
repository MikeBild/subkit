import { describe, expect, test } from "bun:test";
import type { components } from "@/api/schema";
import { diagnosisFix, diagnosisRepairable } from "@/lib/gate-diagnosis";

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

describe("the fix a blocked step offers", () => {
  const fix = (entry: GateDiagnosis, rights = all, rejected: string[] = [], isCurrent = true) =>
    diagnosisFix(entry, diagnosis([entry], isCurrent), rights, rejected);
  const patch = { remedy_kind: "patch", fixer: "use_utf8_encoder" } as const;

  test("each step names its own fix", () => {
    expect(fix(block("encode", patch))).toBe("auto");
    expect(fix(block("encode", { ...patch, candidate_id: "c1" }))).toBe("review");
    expect(fix(block("load", { remedy_kind: "prepare" }))).toBe("prepare");
    expect(fix(block("send", { evidence: { execution_id: RUN } }))).toBe("chat");
  });

  test("a refused repair hands its step to an author", () => {
    expect(fix(block("encode", patch), all, ["encode"])).toBe("chat");
  });

  test("a draft's computable repair waits for its version instead of going to chat", () => {
    const entry = block("encode", patch);
    expect(fix(entry, all, [], false)).toBeNull();
    expect(diagnosisRepairable(entry, true, all)).toBe(true);
    expect(diagnosisRepairable(entry, false, all)).toBe(false);
    expect(diagnosisRepairable(entry, true, { write: false })).toBe(false);
  });

  test("nothing is offered to a reader who may not perform it", () => {
    const none = { write: false, run: false, chat: false };
    expect(fix(block("send"), none)).toBeNull();
    expect(fix(block("load", { remedy_kind: "prepare" }), none)).toBeNull();
    expect(fix(block("encode", { ...patch, candidate_id: "c1" }), none)).toBeNull();
  });

  test("a trial run needs a version to run", () => {
    const entry = block("load", { remedy_kind: "prepare" });
    expect(diagnosisFix(entry, { is_current: true, workflow_version_id: null }, all)).toBeNull();
  });
});
