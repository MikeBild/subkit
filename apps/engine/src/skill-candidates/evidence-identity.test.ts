import { expect, test } from "bun:test";
import { uniqueEvidence } from "./evidence-identity.ts";

test("repeated observations never multiply evidence", () => {
  const evidence = ["one", "two", "three"].map((execution_id) => ({
    execution_id,
    evidence_type: "step_failure",
    summary: "Failed",
  }));
  expect(uniqueEvidence(Array.from({ length: 20 }, () => evidence).flat())).toHaveLength(3);
  expect(
    uniqueEvidence([...evidence, { ...evidence[0]!, summary: "Same execution, new wording" }]),
  ).toHaveLength(3);
});

test("different unlinked notes and different event kinds remain distinct", () => {
  expect(
    uniqueEvidence([
      { evidence_type: "conversation", summary: "First lesson" },
      { evidence_type: "conversation", summary: "Second lesson" },
      { execution_id: "one", evidence_type: "step_failure", summary: "Failure" },
      { execution_id: "one", evidence_type: "step_success", summary: "Success" },
    ]),
  ).toHaveLength(4);
});
