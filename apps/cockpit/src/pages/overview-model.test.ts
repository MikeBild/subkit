import { describe, expect, test } from "bun:test";

import type { FailureGroup } from "./overview-model";
import { partitionFailures, recentRuns } from "./overview-model";

const group = (origin: FailureGroup["origin"], count: number, signature: string): FailureGroup =>
  ({
    signature,
    workflow_id: "w",
    workflow_name: "Report",
    step_key: "s",
    error_code: "boom",
    origin,
    count,
    last_seen: "2026-08-18T10:00:00.000Z",
    cause: "it broke",
    guidance: "",
  }) as FailureGroup;

describe("partitionFailures", () => {
  test("keeps trial runs out of the incident picture", () => {
    // Someone building a workflow can fail two dozen trial runs in an
    // afternoon. Counting those as incidents reports a crisis that is not
    // happening.
    const { incidents, trials } = partitionFailures([
      group("authoring", 30, "a"),
      group("scheduled", 4, "b"),
      group("manual", 7, "c"),
      group("mixed", 2, "d"),
    ]);
    expect(incidents.map((entry) => entry.signature)).toEqual(["b", "d"]);
    expect(trials.map((entry) => entry.signature)).toEqual(["a", "c"]);
  });

  test("sorts the loudest failure first within each pile", () => {
    const { incidents } = partitionFailures([
      group("scheduled", 2, "small"),
      group("mixed", 9, "big"),
    ]);
    expect(incidents.map((entry) => entry.signature)).toEqual(["big", "small"]);
  });
});

describe("recentRuns", () => {
  const run = (id: string, created: string, started?: string, finished?: string) =>
    ({
      id,
      workflow_id: "w",
      workflow_name: "Report",
      status: "succeeded",
      created_at: created,
      started_at: started ?? null,
      finished_at: finished ?? null,
    }) as never;

  test("newest first, capped", () => {
    const runs = recentRuns(
      [
        run("a", "2026-08-18T09:00:00.000Z"),
        run("b", "2026-08-18T11:00:00.000Z"),
        run("c", "2026-08-18T10:00:00.000Z"),
      ],
      2,
    );
    expect(runs.map((entry) => entry.id)).toEqual(["b", "c"]);
  });

  test("an unfinished run has no duration rather than a zero one", () => {
    const [only] = recentRuns([run("a", "2026-08-18T09:00:00.000Z", "2026-08-18T09:00:00.000Z")]);
    expect(only?.durationMs).toBeNull();
  });

  test("a finished run measures wall clock", () => {
    const [only] = recentRuns([
      run("a", "2026-08-18T09:00:00.000Z", "2026-08-18T09:00:00.000Z", "2026-08-18T09:00:12.000Z"),
    ]);
    expect(only?.durationMs).toBe(12_000);
  });
});
