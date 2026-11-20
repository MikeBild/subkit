import { describe, expect, test } from "bun:test";
import { INTAKE_ID, now, VERSION_UUID, WORKFLOW_UUID } from "../tests/draft-fixtures.ts";
import {
  getTaskRunCheck,
  getTaskRunMarker,
  normalizeDraftDocument,
  normalizeTaskRunMarker,
  withoutTaskRunCheck,
  withoutTaskRunMarker,
} from "./draft.ts";

const TASK_ID = "44444444-5555-4666-8777-888888888888";
const RUN_ID = "55555555-6666-4777-8888-999999999999";
const CONNECTOR_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const marker = {
  task_id: TASK_ID,
  task_run_id: RUN_ID,
  environment: "prod" as const,
  workflow_ids: [WORKFLOW_UUID, VERSION_UUID],
  connector_ids: [CONNECTOR_ID],
  web_search: true,
};

const NIL = "00000000-0000-0000-0000-000000000000";

const sealed = {
  task_id: NIL,
  task_run_id: NIL,
  environment: "dev" as const,
  workflow_ids: [],
  connector_ids: [],
  web_search: false,
  sealed: true as const,
};

const invalidMarkers: unknown[] = [
  null,
  "marker",
  7,
  false,
  [marker],
  {},
  { ...marker, task_id: "task" },
  { ...marker, task_id: [TASK_ID] },
  { ...marker, task_id: undefined },
  { ...marker, task_run_id: "run" },
  { ...marker, task_run_id: [RUN_ID] },
  { ...marker, task_run_id: undefined },
  { ...marker, environment: "staging" },
  { ...marker, environment: undefined },
  { ...marker, sealed: true },
  { ...marker, sealed: false },
  { ...marker, sealed: null },
  sealed,
];

const check = { at: "2026-11-20T08:30:00.000Z", reason: "The export is ready after eight" };

describe("task run marker normalization", () => {
  test("a complete marker survives normalization unchanged", () => {
    expect(normalizeTaskRunMarker(marker)).toEqual(marker);
    expect(normalizeDraftDocument(now, { session: { task_run: marker } }).session).toEqual({
      task_run: marker,
    });
    expect(
      normalizeDraftDocument(now, { session: { task_run: { ...marker, environment: "dev" } } })
        .session?.task_run?.environment,
    ).toBe("dev");
  });

  test("the marker is kept next to the other session keys", () => {
    expect(
      normalizeDraftDocument(now, {
        session: { permission_mode: "auto", intake_item_ids: [INTAKE_ID], task_run: marker },
      }).session,
    ).toEqual({ permission_mode: "auto", intake_item_ids: [INTAKE_ID], task_run: marker });
  });

  test("unknown marker keys are dropped and missing optional parts fall back to the closed defaults", () => {
    expect(
      normalizeTaskRunMarker({ ...marker, owner_id: TASK_ID, permission_mode: "yolo" }),
    ).toEqual(marker);
    expect(
      normalizeTaskRunMarker({ task_id: TASK_ID, task_run_id: RUN_ID, environment: "dev" }),
    ).toEqual({
      task_id: TASK_ID,
      task_run_id: RUN_ID,
      environment: "dev",
      workflow_ids: [],
      connector_ids: [],
      web_search: false,
    });
  });

  test("bound id lists are deduplicated and keep only uuid strings", () => {
    const normalized = normalizeTaskRunMarker({
      ...marker,
      workflow_ids: [WORKFLOW_UUID, WORKFLOW_UUID, "nightly", 7, null, [VERSION_UUID]],
      connector_ids: "all",
    });
    expect(normalized?.workflow_ids).toEqual([WORKFLOW_UUID]);
    expect(normalized?.connector_ids).toEqual([]);
    expect(normalizeTaskRunMarker({ ...marker, workflow_ids: { 0: WORKFLOW_UUID } })).toEqual({
      ...marker,
      workflow_ids: [],
    });
  });

  test("web search is granted only by a literal true", () => {
    for (const web_search of [false, "true", 1, null, undefined])
      expect(normalizeTaskRunMarker({ ...marker, web_search })?.web_search).toBe(false);
  });

  test("a value that does not validate is not a marker", () => {
    for (const broken of [undefined, ...invalidMarkers])
      expect(normalizeTaskRunMarker(broken)).toBeNull();
  });

  test("a session without the marker key stays unmarked", () => {
    expect(normalizeDraftDocument(now, { session: { task_run: undefined } }).session).toBe(
      undefined,
    );
    expect(normalizeDraftDocument(now, { session: { playground: true } }).session).toEqual({
      playground: true,
    });
  });

  test("a stored marker that does not validate is sealed instead of dropped", () => {
    for (const broken of invalidMarkers)
      expect(normalizeDraftDocument(now, { session: { task_run: broken } }).session).toEqual({
        task_run: sealed,
      });
  });

  test("a sealed marker stays sealed through repeated normalization and keeps the session", () => {
    const once = normalizeDraftDocument(now, {
      session: { permission_mode: "auto", task_run: { ...marker, environment: "staging" } },
    });
    expect(once.session).toEqual({ permission_mode: "auto", task_run: sealed });
    const stored: unknown = JSON.parse(JSON.stringify(once));
    expect(normalizeDraftDocument(now, stored).session).toEqual({
      permission_mode: "auto",
      task_run: sealed,
    });
    expect(getTaskRunMarker(stored)).toEqual(sealed);
  });

  test("a sealed marker binds nothing and grants no web search", () => {
    const read = getTaskRunMarker({
      session: { task_run: { ...marker, task_run_id: "run", web_search: true } },
    });
    expect(read?.sealed).toBe(true);
    expect(read?.workflow_ids).toEqual([]);
    expect(read?.connector_ids).toEqual([]);
    expect(read?.web_search).toBe(false);
    expect(read?.environment).toBe("dev");
    expect(read?.task_id).toBe(NIL);
    expect(read?.task_run_id).toBe(NIL);
    expect(normalizeTaskRunMarker(marker)).not.toHaveProperty("sealed");
  });

  test("an unknown session key next to the marker is dropped", () => {
    expect(
      normalizeDraftDocument(now, { session: { task_run: marker, task_owner: TASK_ID } }).session,
    ).toEqual({ task_run: marker });
  });
});

describe("getTaskRunMarker", () => {
  test("reads the marker from a stored or normalized draft", () => {
    expect(getTaskRunMarker({ session: { task_run: marker } })).toEqual(marker);
    expect(
      getTaskRunMarker(normalizeDraftDocument(now, { session: { task_run: marker } })),
    ).toEqual(marker);
    expect(getTaskRunMarker({ session: { task_run: { ...marker, extra: 1 } } })).toEqual(marker);
  });

  test("answers null only for drafts without the marker key", () => {
    for (const draft of [
      null,
      undefined,
      "draft",
      {},
      { session: null },
      { session: "task_run" },
      { session: {} },
      { session: { task_run: undefined } },
      { task_run: marker },
    ])
      expect(getTaskRunMarker(draft)).toBeNull();
  });

  test("answers the sealed marker when the key is present but does not validate", () => {
    for (const broken of invalidMarkers)
      expect(getTaskRunMarker({ session: { task_run: broken } })).toEqual(sealed);
  });

  test("every sealed read is a fresh object", () => {
    const first = getTaskRunMarker({ session: { task_run: null } });
    const second = getTaskRunMarker({ session: { task_run: null } });
    expect(first).toEqual(sealed);
    expect(first).not.toBe(second);
    expect(first?.workflow_ids).not.toBe(second?.workflow_ids);
  });
});

describe("withoutTaskRunMarker", () => {
  test("removes only the marker and leaves the source draft untouched", () => {
    const source = Object.freeze({
      mode: "onboarding",
      session: Object.freeze({ permission_mode: "auto", playground: true, task_run: marker }),
    });
    const stripped: unknown = withoutTaskRunMarker(source);
    expect(stripped).toEqual({
      mode: "onboarding",
      session: { permission_mode: "auto", playground: true },
    });
    expect(source.session.task_run).toEqual(marker);
    expect(getTaskRunMarker(stripped)).toBeNull();
  });

  test("a marker that is present but empty is removed as well", () => {
    expect<unknown>(
      withoutTaskRunMarker({ session: { task_run: null, playground: true } }),
    ).toEqual({
      session: { playground: true },
    });
  });

  test("drafts without a marker are returned as they are", () => {
    for (const draft of [
      null,
      undefined,
      "draft",
      {},
      { session: null },
      { session: "task_run" },
      { session: { permission_mode: "ask" } },
      { task_run: marker },
    ])
      expect(withoutTaskRunMarker(draft)).toBe(draft);
  });
});

describe("requested check time", () => {
  test("a complete check is kept next to the marker", () => {
    expect(getTaskRunCheck({ session: { task_check: check } })).toEqual(check);
    expect(
      normalizeDraftDocument(now, { session: { task_run: marker, task_check: check } }).session,
    ).toEqual({ task_run: marker, task_check: check });
    expect(
      getTaskRunCheck(normalizeDraftDocument(now, { session: { task_check: check } })),
    ).toEqual(check);
  });

  test("unknown keys are dropped and the limits are inclusive", () => {
    expect(getTaskRunCheck({ session: { task_check: { ...check, by: TASK_ID } } })).toEqual(check);
    for (const accepted of [
      { at: "2026-11-20T08:30:00Z", reason: "" },
      { at: "2026-01-01T00:00:00.5Z", reason: "x".repeat(200) },
      { at: "2026-12-31T23:59:59.999+02:00", reason: "later" },
      { at: "2026-10-09T19:09:09-11:30", reason: "later" },
    ])
      expect(getTaskRunCheck({ session: { task_check: accepted } })).toEqual(accepted);
  });

  test("a check that does not validate is dropped", () => {
    for (const broken of [
      null,
      undefined,
      "2026-11-20T08:30:00.000Z",
      [check],
      {},
      { at: check.at },
      { reason: check.reason },
      { ...check, reason: 7 },
      { ...check, at: [check.at] },
      { ...check, reason: "x".repeat(201) },
      { ...check, at: 1795163400000 },
      { ...check, at: "tomorrow" },
      { ...check, at: "2026-11-20" },
      { ...check, at: "2026-11-20 08:30:00Z" },
      { ...check, at: "2026-11-20T08:30:00" },
      { ...check, at: "2026-11-20T08:30Z" },
      { ...check, at: "2026-13-20T08:30:00Z" },
      { ...check, at: "2026-00-20T08:30:00Z" },
      { ...check, at: "2026-11-32T08:30:00Z" },
      { ...check, at: "2026-11-00T08:30:00Z" },
      { ...check, at: "2026-11-20T24:30:00Z" },
      { ...check, at: "2026-11-20T08:60:00Z" },
      { ...check, at: "2026-11-20T08:30:60Z" },
      { ...check, at: "2026-11-20T08:30:00.Z" },
      { ...check, at: "2026-11-20T08:30:00.0000Z" },
      { ...check, at: "2026-11-20T08:30:00+24:00" },
      { ...check, at: "2026-11-20T08:30:00+02:60" },
      { ...check, at: "2026-11-20T08:30:00+0200" },
      { ...check, at: " 2026-11-20T08:30:00Z" },
      { ...check, at: "2026-11-20T08:30:00Z\n" },
      { ...check, at: "x2026-11-20T08:30:00Z" },
      { ...check, at: "2026-11-20T08:30:00Zx" },
    ]) {
      expect(getTaskRunCheck({ session: { task_check: broken } })).toBeNull();
      expect(
        normalizeDraftDocument(now, { session: { task_check: broken } }).session,
      ).toBeUndefined();
    }
  });

  test("answers null for drafts without a session", () => {
    for (const draft of [null, undefined, "draft", {}, { session: null }, { task_check: check }])
      expect(getTaskRunCheck(draft)).toBeNull();
  });

  test("withoutTaskRunCheck removes only the check and leaves the source draft untouched", () => {
    const source = Object.freeze({
      mode: "onboarding",
      session: Object.freeze({ permission_mode: "auto", task_run: marker, task_check: check }),
    });
    const stripped: unknown = withoutTaskRunCheck(source);
    expect(stripped).toEqual({
      mode: "onboarding",
      session: { permission_mode: "auto", task_run: marker },
    });
    expect(source.session.task_check).toEqual(check);
    expect(getTaskRunCheck(stripped)).toBeNull();
    expect(getTaskRunMarker(stripped)).toEqual(marker);
  });

  test("withoutTaskRunCheck removes a present but empty check and returns other drafts as they are", () => {
    expect<unknown>(
      withoutTaskRunCheck({ session: { task_check: null, playground: true } }),
    ).toEqual({ session: { playground: true } });
    for (const draft of [
      null,
      undefined,
      "draft",
      {},
      { session: null },
      { session: "task_check" },
      { session: { task_run: marker } },
      { task_check: check },
    ])
      expect(withoutTaskRunCheck(draft)).toBe(draft);
  });

  test("stripping the marker keeps the check and the other way round", () => {
    const draft = { session: { task_run: marker, task_check: check } };
    expect<unknown>(withoutTaskRunMarker(draft)).toEqual({ session: { task_check: check } });
    expect<unknown>(withoutTaskRunCheck(withoutTaskRunMarker(draft))).toEqual({ session: {} });
  });
});
