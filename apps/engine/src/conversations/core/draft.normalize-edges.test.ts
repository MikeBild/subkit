import { describe, expect, test } from "bun:test";
import {
  connector,
  DIGEST,
  INTAKE_ID,
  now,
  VERSION_UUID,
  WORKFLOW_UUID,
  workflow,
} from "../tests/draft-fixtures.ts";
import { normalizeDraftDocument } from "./draft.ts";

const intakeId = (i: number) => `11111111-2222-4333-8444-${i.toString(16).padStart(12, "0")}`;

const liveTest = {
  workflow_id: WORKFLOW_UUID,
  workflow_version_id: VERSION_UUID,
  environment: "dev",
  input: { a: 1 },
  input_digest: DIGEST,
  idempotency_key: "key-1",
  state: "pending",
};

function sessionOf(session: unknown) {
  return normalizeDraftDocument(now, { session }).session;
}

describe("mode normalization edges", () => {
  test("an explicit onboarding mode wins over an unsaved connector", () => {
    expect(normalizeDraftDocument(now, { mode: "onboarding", connector }).mode).toBe("onboarding");
  });

  test("a non-string mode is inferred from the content", () => {
    expect(normalizeDraftDocument(now, { mode: 5, workflow: workflow(1) }).mode).toBe(
      "workflow_authoring",
    );
  });
});

describe("session normalization edges", () => {
  test("intake ids must be an array of anchored uuid strings", () => {
    expect(sessionOf({ intake_item_ids: 5 })).toBeUndefined();
    expect(sessionOf({ intake_item_ids: INTAKE_ID })).toBeUndefined();
    expect(sessionOf({ intake_item_ids: [[INTAKE_ID]] })).toBeUndefined();
    expect(sessionOf({ intake_item_ids: [`x${INTAKE_ID}`, `${INTAKE_ID}x`] })).toBeUndefined();
    expect(sessionOf({ intake_item_ids: [INTAKE_ID.toUpperCase()] })).toEqual({
      intake_item_ids: [INTAKE_ID.toUpperCase()],
    });
  });

  test("exactly 100 intake ids are kept", () => {
    const ids = Array.from({ length: 100 }, (_, i) => intakeId(i));
    expect(sessionOf({ intake_item_ids: ids })).toEqual({ intake_item_ids: ids });
  });

  test("intake read versions need anchored ids and positive safe integers", () => {
    expect(
      sessionOf({
        intake_read_item_versions: {
          [`x${INTAKE_ID}`]: 1,
          [`${INTAKE_ID}x`]: 1,
          [intakeId(1)]: "2",
          [intakeId(2)]: -1,
          [intakeId(3)]: 2 ** 53,
          [intakeId(4)]: 7,
        },
      }),
    ).toEqual({ intake_read_item_versions: { [intakeId(4)]: 7 } });
  });

  test("exactly 100 intake read versions are kept", () => {
    const versions = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [intakeId(i), 1]));
    expect(sessionOf({ intake_read_item_versions: versions })).toEqual({
      intake_read_item_versions: versions,
    });
  });

  test("a live test rejects values that only look valid after string coercion", () => {
    const coerced = [
      { workflow_id: [WORKFLOW_UUID] },
      { workflow_version_id: [VERSION_UUID] },
      { input_digest: [DIGEST] },
      { idempotency_key: ["k"] },
    ];
    for (const patch of coerced) {
      expect(sessionOf({ live_test: { ...liveTest, ...patch } })).toBeUndefined();
    }
  });

  test("a live test needs anchored uuids and an exact 64 character digest", () => {
    const unanchored = [
      { workflow_id: `x${WORKFLOW_UUID}` },
      { workflow_id: `${WORKFLOW_UUID}x` },
      { workflow_version_id: `x${VERSION_UUID}` },
      { workflow_version_id: `${VERSION_UUID}x` },
      { input_digest: `${DIGEST}a` },
      { input_digest: `x${DIGEST}` },
    ];
    for (const patch of unanchored) {
      expect(sessionOf({ live_test: { ...liveTest, ...patch } })).toBeUndefined();
    }
  });

  test("a live test keeps a 200 character idempotency key and only a string execution id", () => {
    const key = "k".repeat(200);
    expect(
      sessionOf({ live_test: { ...liveTest, idempotency_key: key } }) as unknown,
    ).toStrictEqual({
      live_test: { ...liveTest, idempotency_key: key },
    });
    expect(sessionOf({ live_test: { ...liveTest, execution_id: 5 } }) as unknown).toStrictEqual({
      live_test: liveTest,
    });
  });

  test("a live test counts an astral character in the idempotency key as one character", () => {
    const key = `${"k".repeat(199)}🚚`;
    expect(
      sessionOf({ live_test: { ...liveTest, idempotency_key: key } }) as unknown,
    ).toStrictEqual({
      live_test: { ...liveTest, idempotency_key: key },
    });
    expect(sessionOf({ live_test: { ...liveTest, idempotency_key: `${key}k` } })).toBeUndefined();
  });
});

describe("latest_preview normalization edges", () => {
  test("absent optional preview fields stay absent", () => {
    expect(normalizeDraftDocument(now, { latest_preview: {} }).latest_preview).toStrictEqual({
      ok: false,
      step_id: null,
      summary: "Preview executed.",
    });
  });

  test("absent or mistyped optional trace fields stay absent", () => {
    const traces = normalizeDraftDocument(now, {
      latest_preview: {
        step_traces: [
          { step_id: "s0" },
          {
            step_id: "s1",
            fingerprint: 5,
            duration_ms: "5",
            error_code: 1,
            held: true,
          },
        ],
      },
    }).latest_preview?.step_traces;
    expect(traces).toStrictEqual([
      { step_id: "s0", kind: "unknown", status: "unknown" },
      { step_id: "s1", kind: "unknown", status: "unknown", held: true } as never,
    ]);
  });
});
