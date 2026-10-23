import { expect, test } from "bun:test";
import { GateDiagnosisSchema } from "./gate-diagnosis.ts";
import { classifyUnboundSteps, missingBindingEvidence } from "./unbound-bindings.ts";

const DELETED = "00000000-0000-4000-8000-0000000000a1";
const LIVE_PROD = "00000000-0000-4000-8000-0000000000b2";
const LIVE_DEV = "00000000-0000-4000-8000-0000000000b1";
const OTHER_DRIVER = "00000000-0000-4000-8000-0000000000c1";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";

const rows = [
  { id: DELETED, slug: "knowledge-ingest", driver: "http", environment: "prod", deleted: true },
  { id: LIVE_DEV, slug: "knowledge-ingest", driver: "http", environment: "dev", deleted: false },
  { id: LIVE_PROD, slug: "knowledge-ingest", driver: "http", environment: "prod", deleted: false },
  {
    id: OTHER_DRIVER,
    slug: "knowledge-ingest",
    driver: "postgres",
    environment: "prod",
    deleted: false,
  },
] as const;

test("a deleted connector points at the live one with the same slug and driver in this environment", () => {
  const [entry] = classifyUnboundSteps(
    [{ step_id: "ingest_findings", connector_id: DELETED }],
    rows,
    "prod",
  );
  expect(entry).toEqual({
    step_id: "ingest_findings",
    connector_id: DELETED,
    state: "deleted",
    connector_slug: "knowledge-ingest",
    driver: "http",
    replacement: {
      connector_id: LIVE_PROD,
      connector_slug: "knowledge-ingest",
      environment: "prod",
    },
  });
});

test("an unknown reference is reported as not found, without a guessed replacement", () => {
  expect(
    classifyUnboundSteps([{ step_id: "ingest_findings", connector_id: UNKNOWN }], rows, "prod"),
  ).toEqual([{ step_id: "ingest_findings", connector_id: UNKNOWN, state: "not_found" }]);
});

test("a deleted connector without a live successor asks for a restore", () => {
  const unbound = classifyUnboundSteps(
    [{ step_id: "ingest_findings", connector_id: DELETED }],
    [rows[0]],
    "prod",
  );
  const evidence = missingBindingEvidence({ step_id: "ingest_findings" }, unbound, "prod");
  expect(evidence).toEqual({
    kind: "connector",
    state: "deleted",
    environment: "prod",
    reference: { connector_id: DELETED, connector_slug: "knowledge-ingest", driver: "http" },
    repair: "restore_connector",
  });
});

test("evidence names the rebind target and survives the diagnosis schema", () => {
  const unbound = classifyUnboundSteps(
    [{ step_id: "ingest_findings", connector_id: DELETED }],
    rows,
    "prod",
  );
  const binding = missingBindingEvidence({ step_id: "ingest_findings" }, unbound, "prod");
  expect(binding.repair).toBe("rebind_connector");
  expect(binding.replacement?.connector_id).toBe(LIVE_PROD);
  const parsed = GateDiagnosisSchema.parse({
    code: "missing_binding",
    subject: { step_id: "ingest_findings" },
    evidence: { binding },
    remedy_kind: "author",
  });
  expect(parsed.evidence.binding).toEqual(binding);
});

test("a called workflow's step is matched by its call path and repaired there", () => {
  const unbound = [
    {
      step_id: "publish",
      connector_id: UNKNOWN,
      state: "not_found" as const,
      call_path: ["run_child"],
    },
  ];
  expect(
    missingBindingEvidence({ step_id: "publish", call_path: ["run_child"] }, unbound, "dev"),
  ).toEqual({
    kind: "connector",
    state: "not_found",
    environment: "dev",
    reference: { connector_id: UNKNOWN },
    call_step_id: "run_child",
    repair: "repair_called_workflow",
  });
  expect(missingBindingEvidence({ step_id: "publish" }, unbound, "dev").state).toBe("unresolved");
});
