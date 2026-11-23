import { describe, expect, test } from "bun:test";
import {
  assembleFixtures,
  baseStepKey,
  interruptedWriteKeys,
  type ResumeFacts,
  type ResumeRow,
  type ResumeStep,
  resolvedStepState,
  resolveWriteVerdict,
  resumeDecision,
  runSuperseded,
  storedStepOutput,
} from "./resume.ts";

const LEASE = 300_000;

function step(id: string, over: Partial<ResumeStep> = {}): ResumeStep {
  return { id, kind: "request", for_each: false, secret_outputs: false, writes: false, ...over };
}

function row(step_key: string, status: ResumeRow["status"], write_dispatched = false): ResumeRow {
  return { step_key, status, write_dispatched };
}

function facts(over: Partial<ResumeFacts> = {}): ResumeFacts {
  return {
    status: "running",
    heartbeat_age_ms: LEASE + 1,
    lease_ms: LEASE,
    sensitive: false,
    held: false,
    child: false,
    unsaved: false,
    direct: false,
    device: false,
    steps: [step("a"), step("b"), step("c")],
    rows: [],
    ...over,
  };
}

describe("baseStepKey", () => {
  test.each([
    ["fetch", "fetch"],
    ["fetch[0]", "fetch"],
    ["fetch[12]", "fetch"],
    ["fetch[3][7]", "fetch"],
    ["fetch[x]", "fetch[x]"],
    ["a[1]b", "a[1]b"],
  ])("%s → %s", (key, base) => {
    expect(baseStepKey(key)).toBe(base);
  });
});

describe("resumeDecision", () => {
  test("a run with a recent heartbeat is alive", () => {
    expect(resumeDecision(facts({ heartbeat_age_ms: LEASE - 1 }))).toEqual({ kind: "alive" });
  });

  test("a run that never wrote a heartbeat is alive", () => {
    expect(resumeDecision(facts({ heartbeat_age_ms: null }))).toEqual({ kind: "alive" });
  });

  test("the lease boundary counts as stale", () => {
    expect(resumeDecision(facts({ heartbeat_age_ms: LEASE })).kind).toBe("fresh");
  });

  test.each([
    "succeeded",
    "failed",
    "aborted",
    "timed_out",
    "uncertain",
    "waiting_for_device",
  ] as const)("a %s run is not touched", (status) => {
    expect(resumeDecision(facts({ status }))).toEqual({
      kind: "not_resumable",
      reason: "not_running",
      interrupted_writes: [],
    });
  });

  test("a stale run without step rows starts fresh", () => {
    expect(resumeDecision(facts())).toEqual({ kind: "fresh" });
  });

  test("superseded rows do not count as progress", () => {
    expect(resumeDecision(facts({ rows: [row("a", "skipped")] }))).toEqual({ kind: "fresh" });
  });

  test("succeeded steps become fixtures and the interrupted read runs again", () => {
    expect(
      resumeDecision(
        facts({ rows: [row("a", "succeeded"), row("b", "succeeded"), row("c", "running")] }),
      ),
    ).toEqual({ kind: "resume", fixtures: ["a", "b"], completed_for_each: [], superseded: ["c"] });
  });

  test("a dispatched write makes the run uncertain", () => {
    expect(
      resumeDecision(facts({ rows: [row("a", "succeeded"), row("b", "running", true)] })),
    ).toEqual({ kind: "uncertain", step_keys: ["b"] });
  });

  test("a running step declared as a write is uncertain without a dispatch mark", () => {
    expect(
      resumeDecision(facts({ steps: [step("a", { writes: true })], rows: [row("a", "running")] })),
    ).toEqual({ kind: "uncertain", step_keys: ["a"] });
  });

  test("a dispatched write inside a for_each is reported by its iteration key", () => {
    expect(
      resumeDecision(
        facts({
          steps: [step("a"), step("send", { for_each: true, writes: true })],
          rows: [
            row("a", "succeeded"),
            row("send", "running"),
            row("send[0]", "succeeded"),
            row("send[1]", "running", true),
          ],
        }),
      ),
    ).toEqual({ kind: "uncertain", step_keys: ["send[1]"] });
  });

  test("a step row left uncertain keeps the run uncertain", () => {
    expect(resumeDecision(facts({ status: "queued", rows: [row("a", "uncertain")] }))).toEqual({
      kind: "uncertain",
      step_keys: ["a"],
    });
  });

  test.each([
    ["sensitive", { sensitive: true }],
    ["held", { held: true }],
    ["child", { child: true }],
    ["unsaved", { unsaved: true }],
    ["direct", { direct: true }],
    ["device_step", { device: true }],
  ] as const)("a %s run is not resumable and names its interrupted writes", (reason, over) => {
    expect(
      resumeDecision(facts({ ...over, rows: [row("a", "succeeded"), row("b", "running", true)] })),
    ).toEqual({ kind: "not_resumable", reason, interrupted_writes: ["b"] });
  });

  test("a stale blocked run is not restarted even without step rows", () => {
    expect(resumeDecision(facts({ held: true }))).toEqual({
      kind: "not_resumable",
      reason: "held",
      interrupted_writes: [],
    });
  });

  test("a queued run without step rows starts fresh whatever its kind", () => {
    expect(resumeDecision(facts({ status: "queued", held: true, heartbeat_age_ms: null }))).toEqual(
      { kind: "fresh" },
    );
  });

  test("a succeeded step with a declared secret output cannot be rebuilt", () => {
    expect(
      resumeDecision(
        facts({
          steps: [step("a", { secret_outputs: true }), step("b")],
          rows: [row("a", "succeeded"), row("b", "running")],
        }),
      ),
    ).toEqual({ kind: "not_resumable", reason: "secret_output", interrupted_writes: [] });
  });

  test("a secret output that did not finish does not block the resume", () => {
    expect(
      resumeDecision(
        facts({ steps: [step("a", { secret_outputs: true })], rows: [row("a", "running")] }),
      ),
    ).toEqual({ kind: "resume", fixtures: [], completed_for_each: [], superseded: ["a"] });
  });

  test.each(["failed", "timed_out", "aborted"] as const)("a %s step ends the run", (status) => {
    expect(resumeDecision(facts({ rows: [row("a", "succeeded"), row("b", status)] }))).toEqual({
      kind: "not_resumable",
      reason: "step_failed",
      interrupted_writes: [],
    });
  });

  test("a row of a step the definition does not know is not resumable", () => {
    expect(resumeDecision(facts({ rows: [row("ghost", "succeeded")] }))).toEqual({
      kind: "not_resumable",
      reason: "unknown_step",
      interrupted_writes: [],
    });
  });

  test.each(["loop", "parallel"])("a %s step cannot be rebuilt", (kind) => {
    for (const status of ["succeeded", "running"] as const) {
      expect(
        resumeDecision(facts({ steps: [step("a", { kind })], rows: [row("a", status)] })),
      ).toEqual({ kind: "not_resumable", reason: "container_step", interrupted_writes: [] });
    }
  });

  test("a call step in flight is not started twice, a finished one is a fixture", () => {
    const steps = [step("a", { kind: "call" })];
    expect(resumeDecision(facts({ steps, rows: [row("a", "running")] }))).toEqual({
      kind: "not_resumable",
      reason: "container_step",
      interrupted_writes: [],
    });
    expect(resumeDecision(facts({ steps, rows: [row("a", "succeeded")] }))).toEqual({
      kind: "resume",
      fixtures: ["a"],
      completed_for_each: [],
      superseded: [],
    });
  });

  test("an interrupted for_each keeps its finished iterations", () => {
    expect(
      resumeDecision(
        facts({
          steps: [step("a"), step("each", { for_each: true })],
          rows: [
            row("a", "succeeded"),
            row("each", "running"),
            row("each[0]", "succeeded"),
            row("each[1]", "running"),
          ],
        }),
      ),
    ).toEqual({
      kind: "resume",
      fixtures: ["a", "each[0]"],
      completed_for_each: [],
      superseded: ["each", "each[1]"],
    });
  });

  test("a finished for_each is rebuilt from its iterations", () => {
    expect(
      resumeDecision(
        facts({
          steps: [step("each", { for_each: true }), step("b")],
          rows: [
            row("each", "succeeded"),
            row("each[1]", "succeeded"),
            row("each[0]", "succeeded"),
            row("b", "running"),
          ],
        }),
      ),
    ).toEqual({
      kind: "resume",
      fixtures: ["each[1]", "each[0]"],
      completed_for_each: ["each"],
      superseded: ["b"],
    });
  });

  test("a resolved run continues from the queue without a heartbeat check", () => {
    expect(
      resumeDecision(
        facts({
          status: "queued",
          heartbeat_age_ms: 0,
          rows: [row("a", "succeeded"), row("b", "skipped"), row("b", "succeeded")],
        }),
      ),
    ).toEqual({ kind: "resume", fixtures: ["a", "b"], completed_for_each: [], superseded: [] });
  });
});

describe("interruptedWriteKeys", () => {
  test("ignores running reads and finished writes", () => {
    expect(
      interruptedWriteKeys(
        [step("read"), step("write", { writes: true })],
        [row("read", "running"), row("write", "succeeded", true)],
      ),
    ).toEqual([]);
  });

  test("matches iteration rows to their step", () => {
    expect(
      interruptedWriteKeys(
        [step("write", { writes: true, for_each: true })],
        [row("write", "running"), row("write[0]", "succeeded"), row("write[1]", "running")],
      ),
    ).toEqual(["write[1]"]);
  });
});

describe("assembleFixtures", () => {
  test("passes top-level and in-flight iteration envelopes through", () => {
    const envelopes = { a: { data: 1 }, "each[0]": { data: "x" } };
    expect(assembleFixtures(envelopes, [])).toEqual(envelopes);
  });

  test("rebuilds a finished for_each in iteration order", () => {
    expect(
      assembleFixtures(
        {
          a: { data: 1 },
          "each[10]": { data: "k" },
          "each[2]": { data: "c" },
          "each[0]": { data: "a" },
        },
        ["each"],
      ),
    ).toEqual({
      a: { data: 1 },
      each: {
        data: [{ each: { data: "a" } }, { each: { data: "c" } }, { each: { data: "k" } }],
        duration_ms: 0,
        error: null,
      },
    });
  });

  test("a finished for_each over nothing is an empty list", () => {
    expect(assembleFixtures({}, ["each"])).toEqual({
      each: { data: [], duration_ms: 0, error: null },
    });
  });
});

describe("storedStepOutput", () => {
  test("unwraps an output stored together with its warnings", () => {
    expect(storedStepOutput({ value: [1], warnings: [{ code: "x" }] })).toEqual([1]);
  });

  test.each([
    [null],
    ["text"],
    [[1, 2]],
    [{ value: 1 }],
    [{ value: 1, warnings: [] }],
    [{ value: 1, warnings: [{ code: "x" }], more: true }],
  ])("keeps %j as stored", (preview) => {
    expect(storedStepOutput(preview)).toEqual(preview);
  });
});

describe("resolvedStepState", () => {
  test("an arrived change counts as done", () => {
    expect(resolvedStepState("arrived")).toEqual({ status: "succeeded", error: null });
  });

  test("a change that did not arrive frees the step to be sent again", () => {
    const state = resolvedStepState("not_arrived");
    expect(state.status).toBe("skipped");
    expect(state.error?.code).toBe("write_not_arrived");
  });
});

describe("resolveWriteVerdict", () => {
  test("only an uncertain run can be resolved", () => {
    for (const status of ["queued", "running", "failed", "succeeded"] as const) {
      expect(resolveWriteVerdict({ status, uncertain_step_keys: ["a"], step_key: "a" })).toBe(
        "not_uncertain",
      );
    }
  });

  test("the step must be one of the uncertain ones", () => {
    expect(
      resolveWriteVerdict({ status: "uncertain", uncertain_step_keys: ["a"], step_key: "b" }),
    ).toBe("unknown_step");
  });

  test("the last uncertain step sends the run back to the queue", () => {
    expect(
      resolveWriteVerdict({ status: "uncertain", uncertain_step_keys: ["a[2]"], step_key: "a[2]" }),
    ).toBe("requeue");
  });

  test("the run waits while other steps are still uncertain", () => {
    expect(
      resolveWriteVerdict({
        status: "uncertain",
        uncertain_step_keys: ["a[1]", "a[2]"],
        step_key: "a[1]",
      }),
    ).toBe("wait");
  });
});

describe("runSuperseded", () => {
  test("keeps the copy whose attempt is still current", () => {
    expect(runSuperseded(2, 2)).toBe(false);
  });

  test("stops the copy once another one claimed the run", () => {
    expect(runSuperseded(0, 1)).toBe(true);
  });

  test("stops the copy when the run row is gone", () => {
    expect(runSuperseded(0, null)).toBe(true);
  });
});
