import { describe, expect, test } from "bun:test";
import {
  connector,
  DIGEST,
  INTAKE_ID,
  MODES,
  NOW,
  now,
  OTHER_INTAKE_ID,
  VERSION_UUID,
  WORKFLOW_UUID,
  workflow,
} from "../tests/draft-fixtures.ts";
import { createEmptyDraftDocument, normalizeDraftDocument } from "./draft.ts";

describe("createEmptyDraftDocument", () => {
  test("strict normalization drops latest_preview: null and fills the optional state nulls", () => {
    const empty = createEmptyDraftDocument(now);
    const normalized = normalizeDraftDocument(now, empty);
    expect(empty.mode).toBe("onboarding");
    expect(empty.latest_preview).toBeNull();
    expect("latest_preview" in normalized).toBe(false);
    expect(normalized.state).toMatchObject({
      grounding_fingerprint: null,
      grounding_connector_ids: null,
      last_denied_intent: null,
      authoring_focus: null,
    });
    const { latest_preview: _dropped, ...rest } = empty;
    expect(normalized).toEqual(rest);
  });

  test("a non-record input normalizes to the empty onboarding draft", () => {
    expect(normalizeDraftDocument(now, "nope")).toEqual(createEmptyDraftDocument(now));
    expect(normalizeDraftDocument(now, null).mode).toBe("onboarding");
  });
});

describe("mode inference", () => {
  test("an unknown mode falls back to the draft content", () => {
    expect(normalizeDraftDocument(now, { mode: "unknown", connector }).mode).toBe(
      "connector_authoring",
    );
    expect(
      normalizeDraftDocument(now, {
        mode: "unknown",
        connector: { ...connector, saved_connector_id: "connector-1" },
        workflow: workflow(1),
      }).mode,
    ).toBe("workflow_authoring");
    expect(normalizeDraftDocument(now, { mode: "unknown" }).mode).toBe("onboarding");
  });

  test("a known mode is kept", () => {
    for (const mode of MODES) {
      expect(normalizeDraftDocument(now, { mode }).mode).toBe(mode);
    }
  });
});

describe("session normalization", () => {
  test("drops a stored permission mode and keeps a true playground flag", () => {
    expect(
      normalizeDraftDocument(now, { session: { permission_mode: "ask" } }).session,
    ).toBeUndefined();
    expect(
      normalizeDraftDocument(now, { session: { permission_mode: "other", playground: true } })
        .session,
    ).toEqual({ playground: true });
    expect("session" in normalizeDraftDocument(now, { session: { playground: false } })).toBe(
      false,
    );
    expect("session" in normalizeDraftDocument(now, { session: "x" })).toBe(false);
  });

  test("dedupes intake ids, drops invalid ones and keeps the lock only with ids", () => {
    const session = normalizeDraftDocument(now, {
      session: {
        intake_item_ids: [INTAKE_ID, INTAKE_ID, "bad", 7, OTHER_INTAKE_ID],
        intake_review_locked: true,
        intake_review_active: true,
      },
    }).session;
    expect(session).toEqual({
      intake_item_ids: [INTAKE_ID, OTHER_INTAKE_ID],
      intake_review_locked: true,
      intake_review_active: true,
    });
    expect(
      normalizeDraftDocument(now, {
        session: { intake_item_ids: ["bad"], intake_review_locked: true },
      }).session,
    ).toBeUndefined();
    expect(
      normalizeDraftDocument(now, { session: { intake_item_ids: [INTAKE_ID] } }).session,
    ).toEqual({ intake_item_ids: [INTAKE_ID] });
  });

  test("drops intake id lists above 100 entries", () => {
    const ids = Array.from(
      { length: 101 },
      (_, i) => `11111111-2222-4333-8444-${i.toString(16).padStart(12, "0")}`,
    );
    expect(normalizeDraftDocument(now, { session: { intake_item_ids: ids } }).session).toBe(
      undefined,
    );
  });

  test("keeps valid intake read versions and drops maps above 100 entries", () => {
    expect(
      normalizeDraftDocument(now, {
        session: {
          intake_read_item_versions: {
            [INTAKE_ID]: 2,
            [OTHER_INTAKE_ID]: 0,
            bad: 3,
            "11111111-2222-4333-8444-777777777777": 1.5,
          },
        },
      }).session,
    ).toEqual({ intake_read_item_versions: { [INTAKE_ID]: 2 } });
    const big = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [
        `11111111-2222-4333-8444-${i.toString(16).padStart(12, "0")}`,
        1,
      ]),
    );
    expect(
      normalizeDraftDocument(now, { session: { intake_read_item_versions: big } }).session,
    ).toBeUndefined();
  });

  test("keeps a well-formed live test with and without an execution id", () => {
    const live_test = {
      workflow_id: WORKFLOW_UUID,
      workflow_version_id: VERSION_UUID,
      environment: "dev",
      input: { a: 1 },
      input_digest: DIGEST,
      idempotency_key: "key-1",
      state: "pending",
    };
    expect(
      normalizeDraftDocument(now, { session: { live_test } }).session?.live_test as unknown,
    ).toEqual(live_test);
    for (const state of ["running", "succeeded", "failed", "blocked"]) {
      expect(
        normalizeDraftDocument(now, {
          session: { live_test: { ...live_test, state, execution_id: "execution-1" } },
        }).session?.live_test as unknown,
      ).toEqual({ ...live_test, state, execution_id: "execution-1" });
    }
  });

  test("drops a live test with any invalid field", () => {
    const valid = {
      workflow_id: WORKFLOW_UUID,
      workflow_version_id: VERSION_UUID,
      environment: "dev",
      input_digest: DIGEST,
      idempotency_key: "key-1",
      state: "pending",
    };
    const broken = [
      { workflow_id: 1 },
      { workflow_id: "not-a-uuid" },
      { workflow_version_id: 1 },
      { workflow_version_id: "not-a-uuid" },
      { environment: "prod" },
      { input_digest: 1 },
      { input_digest: "short" },
      { idempotency_key: 1 },
      { idempotency_key: "" },
      { idempotency_key: "k".repeat(201) },
      { state: "unknown" },
    ];
    for (const patch of broken) {
      expect(
        normalizeDraftDocument(now, { session: { live_test: { ...valid, ...patch } } }).session,
      ).toBeUndefined();
    }
    expect(normalizeDraftDocument(now, { session: { live_test: "x" } }).session).toBeUndefined();
  });
});

describe("latest_preview normalization", () => {
  test("fills defaults for a minimal preview", () => {
    expect(normalizeDraftDocument(now, { latest_preview: {} }).latest_preview).toEqual({
      ok: false,
      step_id: null,
      summary: "Preview executed.",
    });
  });

  test("keeps every optional preview field", () => {
    const preview = normalizeDraftDocument(now, {
      latest_preview: {
        ok: true,
        step_id: "s0",
        summary: "Ran.",
        preview: { rows: 1 },
        warnings: [{ code: "w" }],
        requires_repair: true,
        redacted: true,
        mode: "schema_only",
        input: { a: 1 },
        step_traces: [],
      },
    }).latest_preview;
    expect(preview).toEqual({
      ok: true,
      step_id: "s0",
      summary: "Ran.",
      preview: { rows: 1 },
      warnings: [{ code: "w" }],
      requires_repair: true,
      redacted: true,
      mode: "schema_only",
      input: { a: 1 },
      step_traces: [],
    });
  });

  test("normalizes step traces field by field", () => {
    const traces = normalizeDraftDocument(now, {
      latest_preview: {
        step_traces: [
          "skip",
          {},
          {
            step_id: "s0",
            kind: "http",
            status: "succeeded",
            fingerprint: "fp",
            duration_ms: 5,
            output_preview: { a: 1 },
            raw_preview: "raw",
            scope_at_step: {
              available_paths: ["a", 1],
              shape_summary: "object",
              primary_data_path: "a",
            },
            request_meta: { method: "GET" },
            held: true,
            held_request: { url: "https://orders.example.test" },
            error_code: "E1",
          },
          { step_id: "s1", scope_at_step: { available_paths: [] }, held_request: { x: 1 } },
          { step_id: "s2", scope_at_step: { available_paths: "nope" } },
          { step_id: "s3", held: true },
        ],
      },
    }).latest_preview?.step_traces;
    expect(traces).toEqual([
      { step_id: "(unknown)", kind: "unknown", status: "unknown" },
      {
        step_id: "s0",
        kind: "http",
        status: "succeeded",
        fingerprint: "fp",
        duration_ms: 5,
        output_preview: { a: 1 },
        raw_preview: "raw",
        scope_at_step: { available_paths: ["a"], shape_summary: "object", primary_data_path: "a" },
        request_meta: { method: "GET" },
        held: true,
        held_request: { url: "https://orders.example.test" },
        error_code: "E1",
      } as never,
      {
        step_id: "s1",
        kind: "unknown",
        status: "unknown",
        scope_at_step: { available_paths: [], shape_summary: "unknown", primary_data_path: null },
      },
      { step_id: "s2", kind: "unknown", status: "unknown" },
      { step_id: "s3", kind: "unknown", status: "unknown", held: true } as never,
    ]);
  });
});

describe("state and summary normalization", () => {
  test("revives a stored state and keeps the stored last action", () => {
    const draft = normalizeDraftDocument(now, {
      mode: "workflow_authoring",
      workflow: workflow(1),
      state: { workflow_mutation_seq: 3, persisted_resources: [{ kind: "workflow", id: "w" }] },
      summary: { last_action: "kept" },
    });
    expect(draft.state?.workflow_mutation_seq).toBe(3);
    expect(draft.state?.persisted_resources[0]?.saved_at).toBe(NOW);
    expect(draft.summary?.last_action).toBe("kept");
  });
});
