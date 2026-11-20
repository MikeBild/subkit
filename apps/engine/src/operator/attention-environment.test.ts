import { describe, expect, test } from "bun:test";
import {
  applyWorkflowEnvironments,
  environmentOfSchedules,
  type ScheduleEnvironmentRow,
} from "./attention-environment.ts";
import type { Candidate, TenantFacts } from "./attention-readers.ts";
import { pausedScheduleCandidate } from "./schedule-pause-attention.ts";

const TEST_RUN = "5eed0013-0000-4000-8000-000000000001";
const LIVE_RUN = "5eed0013-0000-4000-8000-000000000002";
const BOTH = "5eed0013-0000-4000-8000-000000000003";
const HOOKED = "5eed0013-0000-4000-8000-000000000004";
const BARE = "5eed0013-0000-4000-8000-000000000005";

function paused(workflow_id: string): Candidate {
  return pausedScheduleCandidate({
    workflow_id,
    name: "Report",
    paused_at: new Date("2026-11-20T08:00:00.000Z"),
    failure_class: "timed_out",
    consecutive_failures: 5,
  });
}

function facts(candidates: Candidate[]): TenantFacts {
  return { sources: { schedules: "answered" }, candidates, status: null };
}

function schedule(
  workflow_id: string,
  environment: "dev" | "prod",
  stopped: boolean,
): ScheduleEnvironmentRow {
  return { workflow_id, environment, stopped };
}

function environments(result: TenantFacts): Array<string | undefined> {
  return result.candidates.map((candidate) => candidate.item.subject?.environment);
}

describe("the execution environment of an attention item", () => {
  test("a stopped schedule names its own environment, production wins among stopped ones", () => {
    expect(environmentOfSchedules([])).toBeNull();
    expect(environmentOfSchedules([schedule(TEST_RUN, "dev", true)])).toBe("dev");
    expect(
      environmentOfSchedules([schedule(BOTH, "dev", true), schedule(BOTH, "prod", false)]),
    ).toBe("dev");
    expect(
      environmentOfSchedules([schedule(BOTH, "dev", true), schedule(BOTH, "prod", true)]),
    ).toBe("prod");
    expect(
      environmentOfSchedules([schedule(BOTH, "dev", false), schedule(BOTH, "prod", false)]),
    ).toBe("prod");
  });

  test("workflow items get the environment of their schedule, hook or approval", () => {
    const approved = paused(BARE);
    const result = applyWorkflowEnvironments(
      facts([
        paused(TEST_RUN),
        paused(LIVE_RUN),
        paused(HOOKED),
        {
          ...approved,
          item: { ...approved.item, approval: { version: 3, environment: "dev" } },
        },
      ]),
      [schedule(TEST_RUN, "dev", true), schedule(LIVE_RUN, "prod", true)],
      new Set([HOOKED]),
    );
    expect(environments(result)).toEqual(["dev", "prod", "prod", "dev"]);
  });

  test("an item without schedule, hook or approval keeps no environment and others stay as read", () => {
    const connector: Candidate = {
      source: "connectors",
      item: {
        ...paused(BARE).item,
        id: "connector:1",
        kind: "connector",
        subject: { kind: "connector", id: "1", name: "Mail", environment: "dev" },
      },
    };
    const result = applyWorkflowEnvironments(
      facts([paused(BARE), connector]),
      [schedule(TEST_RUN, "prod", true)],
      new Set(),
    );
    expect(environments(result)).toEqual([undefined, "dev"]);
  });
});
