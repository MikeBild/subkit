import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  diagnosis,
  INTAKE_ID,
  MODES,
  NOW,
  now,
  OTHER_INTAKE_ID,
  stripNulls,
} from "../tests/draft-fixtures.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;

import type {
  AuthoringMode,
  ConnectorDraftDocument,
  DraftDocument,
  WorkflowDraftDocument,
} from "../types.ts";
import {
  bindPersistedWorkflow,
  createEmptyDraftDocument,
  normalizeDraftDocument,
  refreshDraftSummary,
  startNewWorkflowDraft,
  withAuthoringFocus,
  withConnectorAuthenticated,
  withConnectorDraft,
  withConnectorInspection,
  withConnectorPersisted,
  withConnectorProbe,
  withConnectorValidation,
  withFocusedExecution,
  withJudgeBreaker,
  withLatestPreview,
  withWorkflowDiagnosis,
  withWorkflowDraft,
  withWorkflowExecution,
  withWorkflowInspection,
  withWorkflowPersisted,
  withWorkflowSaveError,
  withWorkflowValidation,
} from "./draft.ts";

type Op = { name: string; run: (draft: DraftDocument) => DraftDocument };

const textArb = fc.string({ maxLength: 12 });
const lastActionArb = fc.option(textArb, { nil: null });
const connectorArb: fc.Arbitrary<ConnectorDraftDocument | null> = fc.option(
  fc.record({
    name: textArb,
    slug: fc.constantFrom("orders-api", "crm"),
    driver: fc.constant("http" as const),
    base_url: fc.constantFrom("https://orders.example.test", ""),
    saved_connector_id: fc.option(fc.constant("connector-1"), { nil: null }),
  }),
  { nil: null },
);
const workflowArb: fc.Arbitrary<WorkflowDraftDocument> = fc.record(
  {
    name: fc.constantFrom("orders-sync", "crm-digest"),
    slug: fc.constantFrom("orders-sync", "crm-digest"),
    goal: textArb,
    steps: fc.array(
      fc.record({
        id: fc.constantFrom("s0", "s1", "s2"),
        kind: fc.constant("wait"),
        duration_ms: fc.nat(5),
      }),
      { maxLength: 3 },
    ),
  },
  { requiredKeys: ["name", "steps"] },
);
const traceArb = fc.record({
  step_id: fc.constantFrom("s0", "s1", "s2"),
  kind: fc.constant("wait"),
  status: fc.constantFrom("succeeded", "failed"),
  fingerprint: fc.constantFrom("fp-a", "fp-b"),
});
const previewArb = fc.option(
  fc.record(
    {
      ok: fc.boolean(),
      summary: textArb,
      redacted: fc.boolean(),
      warnings: fc.array(fc.record({ code: textArb }), { maxLength: 2 }),
      step_traces: fc.array(traceArb, { maxLength: 3 }),
    },
    { requiredKeys: ["ok", "summary"] },
  ),
  { nil: null },
);
const resourceArb = fc.record({
  kind: fc.constantFrom("connector" as const, "workflow" as const),
  id: fc.constantFrom("r-1", "r-2"),
  slug: fc.option(fc.constantFrom("orders-sync", "orders-api"), { nil: null }),
  name: fc.option(textArb, { nil: null }),
  version_id: fc.option(fc.constant("version-1"), { nil: null }),
  version: fc.option(fc.nat(3), { nil: null }),
  environment: fc.constantFrom("dev" as const, "prod" as const, null),
  saved_at: fc.constant(NOW),
  persistence_kind: fc.constantFrom("draft" as const, "active" as const),
});
const executionArb = fc.record({
  execution_id: fc.constantFrom("e-1", "e-2"),
  workflow_id: fc.option(fc.constant("w-1"), { nil: null }),
  workflow_version_id: fc.option(fc.constant("v-1"), { nil: null }),
  status: fc.constantFrom("succeeded", "failed"),
  environment: fc.constantFrom("dev" as const, "prod" as const),
  warnings_count: fc.nat(3),
  recorded_at: fc.constant(NOW),
  diagnosis_available: fc.boolean(),
});

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.tuple(workflowArb, lastActionArb).map(([w, a]) => ({
    name: "withWorkflowDraft",
    run: (d: DraftDocument) => withWorkflowDraft(now, d, w, a),
  })),
  fc.tuple(connectorArb, lastActionArb).map(([c, a]) => ({
    name: "withConnectorDraft",
    run: (d: DraftDocument) => withConnectorDraft(now, d, c, a),
  })),
  fc
    .tuple(fc.constantFrom("connector" as const, "workflow" as const), fc.boolean())
    .map(([focus, dropConnector]) => ({
      name: "withAuthoringFocus",
      run: (d: DraftDocument) => withAuthoringFocus(now, d, focus, { dropConnector }),
    })),
  fc.option(fc.record({ blocks_since_commit: fc.nat(4) }), { nil: null }).map((b) => ({
    name: "withJudgeBreaker",
    run: (d: DraftDocument) => withJudgeBreaker(now, d, b),
  })),
  previewArb.map((p) => ({
    name: "withLatestPreview",
    run: (d: DraftDocument) => withLatestPreview(now, d, p),
  })),
  fc.constant({
    name: "withConnectorInspection",
    run: (d: DraftDocument) => withConnectorInspection(now, d),
  }),
  fc.constant({
    name: "withWorkflowInspection",
    run: (d: DraftDocument) => withWorkflowInspection(now, d),
  }),
  fc.tuple(connectorArb, fc.boolean(), textArb).map(([c, ok, s]) => ({
    name: "withConnectorValidation",
    run: (d: DraftDocument) => withConnectorValidation(now, d, c, ok, s),
  })),
  fc.tuple(fc.boolean(), textArb).map(([ok, s]) => ({
    name: "withWorkflowValidation",
    run: (d: DraftDocument) => withWorkflowValidation(now, d, ok, s),
  })),
  fc.tuple(connectorArb, fc.boolean(), textArb).map(([c, ok, s]) => ({
    name: "withConnectorAuthenticated",
    run: (d: DraftDocument) => withConnectorAuthenticated(now, d, c, ok, s, "authenticate_oauth"),
  })),
  fc.tuple(connectorArb, fc.boolean(), textArb).map(([c, ok, s]) => ({
    name: "withConnectorProbe",
    run: (d: DraftDocument) => withConnectorProbe(now, d, c, ok, s),
  })),
  fc.tuple(connectorArb, resourceArb).map(([c, r]) => ({
    name: "withConnectorPersisted",
    run: (d: DraftDocument) => withConnectorPersisted(now, d, c, { ...r, kind: "connector" }),
  })),
  resourceArb.map((r) => ({
    name: "withWorkflowPersisted",
    run: (d: DraftDocument) => withWorkflowPersisted(now, d, { ...r, kind: "workflow" }),
  })),
  textArb.map((message) => ({
    name: "withWorkflowSaveError",
    run: (d: DraftDocument) => withWorkflowSaveError(now, d, { code: "draft_conflict", message }),
  })),
  resourceArb.map((r) => ({
    name: "bindPersistedWorkflow",
    run: (d: DraftDocument) => bindPersistedWorkflow(now, d, { ...r, kind: "workflow" }),
  })),
  executionArb.map((e) => ({
    name: "withWorkflowExecution",
    run: (d: DraftDocument) => withWorkflowExecution(now, d, e),
  })),
  executionArb.map((e) => ({
    name: "withFocusedExecution",
    run: (d: DraftDocument) => withFocusedExecution(now, d, e),
  })),
  fc.constant({
    name: "withWorkflowDiagnosis",
    run: (d: DraftDocument) => withWorkflowDiagnosis(now, d, diagnosis),
  }),
  lastActionArb.map((a) => ({
    name: "startNewWorkflowDraft",
    run: (d: DraftDocument) => startNewWorkflowDraft(now, d, a),
  })),
);

const opsArb = fc.tuple(fc.constantFrom(...MODES), fc.array(opArb, { minLength: 1, maxLength: 8 }));

function applyOps(mode: AuthoringMode, ops: Op[]): DraftDocument {
  return ops.reduce<DraftDocument>(
    (draft, op) => op.run(draft),
    createEmptyDraftDocument(now, mode),
  );
}

const rawDraftArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything(),
  opsArb.map(([mode, ops]) => applyOps(mode, ops)),
  fc.record({
    mode: fc.constantFrom(...MODES, "unknown"),
    workflow: workflowArb,
    connector: connectorArb,
    state: fc.record({
      mode: fc.constantFrom("workflow", "connector", "execution", "diagnosis", 7),
      persisted_resources: fc.array(fc.oneof(resourceArb, fc.anything()), { maxLength: 2 }),
      latest_execution: fc.option(executionArb, { nil: null }),
      last_denied_intent: fc.option(fc.record({ fingerprint: textArb }), { nil: null }),
    }),
    latest_preview: previewArb,
    session: fc.record({
      unknown_key: fc.constantFrom("auto", "ask", "other"),
      playground: fc.boolean(),
      intake_item_ids: fc.array(fc.constantFrom(INTAKE_ID, OTHER_INTAKE_ID, "bad"), {
        maxLength: 3,
      }),
    }),
  }),
);

describe("draft core properties", () => {
  test("every with* reducer leaves its input deep-unchanged", () => {
    fc.assert(
      fc.property(opsArb, ([mode, ops]) => {
        let draft: DraftDocument = createEmptyDraftDocument(now, mode);
        for (const op of ops) {
          const before = structuredClone(draft);
          const next = op.run(draft);
          expect(draft).toStrictEqual(before);
          draft = next;
        }
      }),
      FC,
    );
  });

  test("with* reducers never mutate a raw, non-normalized input", () => {
    fc.assert(
      fc.property(rawDraftArb, opArb, (raw, op) => {
        const before = structuredClone(raw);
        op.run(raw as DraftDocument);
        expect(raw).toStrictEqual(before);
      }),
      FC,
    );
  });

  test("normalizeDraftDocument changes a normalized draft only by filling explicit nulls", () => {
    fc.assert(
      fc.property(rawDraftArb, (raw) => {
        const once = normalizeDraftDocument(now, raw);
        const twice = normalizeDraftDocument(now, once);
        expect(stripNulls(twice)).toEqual(stripNulls(once));
      }),
      FC,
    );
  });

  test("normalizeDraftDocument reaches its fixpoint after two applications", () => {
    fc.assert(
      fc.property(rawDraftArb, (raw) => {
        const twice = normalizeDraftDocument(now, normalizeDraftDocument(now, raw));
        expect(normalizeDraftDocument(now, twice)).toEqual(twice);
      }),
      FC,
    );
  });

  test("refreshDraftSummary is idempotent", () => {
    fc.assert(
      fc.property(rawDraftArb, (raw) => {
        const once = refreshDraftSummary(now, normalizeDraftDocument(now, raw));
        expect(refreshDraftSummary(now, once)).toEqual(once);
      }),
      FC,
    );
  });

  test("createEmptyDraftDocument passes normalizeDraftDocument unchanged up to explicit nulls", () => {
    fc.assert(
      fc.property(fc.constantFrom(...MODES), (mode) => {
        const empty = createEmptyDraftDocument(now, mode);
        const normalized = normalizeDraftDocument(now, empty);
        expect(stripNulls(normalized)).toEqual(stripNulls(empty));
        expect(normalized.mode).toBe(mode);
        expect(normalizeDraftDocument(now, normalized)).toEqual(normalized);
      }),
      FC,
    );
  });

  test("the injected clock is the only time source for checkpoints", () => {
    fc.assert(
      fc.property(opsArb, ([mode, ops]) => {
        const draft = applyOps(mode, ops);
        for (const record of Object.values(draft.state?.checkpoints ?? {})) {
          expect(record?.verified_at).toBe(NOW);
        }
      }),
      FC,
    );
  });
});
