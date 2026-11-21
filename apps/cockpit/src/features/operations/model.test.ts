import { describe, expect, test } from "bun:test";
import {
  approvalBounds,
  approvalLimits,
  CONNECTOR_DOTS_MAX,
  connectorDots,
  costTrend,
  dateInDays,
  daysLeft,
  durationBars,
  grantLimits,
  limitedGrant,
  limitsProblem,
  localDay,
  needVisual,
  operatingTone,
  renewalSource,
  runFailureKind,
  runFailureRows,
  runGraphSteps,
  runResultMarkdown,
  runTone,
  runTrend,
  successTrend,
} from "./model";

const now = new Date(2026, 10, 20, 12);
const bucket = (ts: string, executions: number) => ({
  ts,
  executions,
  duration_ms: { p50: 0, p95: 0, max: 0, sum: 0, count: executions },
});

describe("KPI trends", () => {
  test("runs add up every group per bucket, oldest first", () => {
    const stats = {
      groups: [
        {
          key: {},
          buckets: [bucket("2026-11-20T02:00", 3), bucket("2026-11-20T01:00", 1)],
          totals: {},
        },
        { key: {}, buckets: [bucket("2026-11-20T01:00", 2)], totals: {} },
      ],
    } as never;
    expect(runTrend(stats)).toEqual([3, 3]);
  });

  test("a single bucket draws no line", () => {
    expect(
      runTrend({ groups: [{ key: {}, buckets: [bucket("a", 4)], totals: {} }] } as never),
    ).toBe(null);
    expect(runTrend(null)).toBe(null);
  });

  test("success rate counts only finished runs and skips empty buckets", () => {
    const stats = {
      groups: [
        { key: { status: "succeeded" }, buckets: [bucket("1", 3), bucket("2", 1)], totals: {} },
        { key: { status: "failed" }, buckets: [bucket("1", 1), bucket("2", 1)], totals: {} },
        { key: { status: "running" }, buckets: [bucket("3", 5)], totals: {} },
      ],
    } as never;
    expect(successTrend(stats)).toEqual([75, 50]);
  });

  test("cost sums priced amounts and treats unpriced buckets as zero", () => {
    const stats = {
      groups: [
        {
          key: {},
          buckets: [
            { ts: "1", cost: { amount: 1.5 } },
            { ts: "2" },
            { ts: "3", cost: { amount: 0.25 } },
          ],
        },
      ],
    } as never;
    expect(costTrend(stats)).toEqual([1.5, 0, 0.25]);
  });
});

describe("connector dots", () => {
  test("one dot per connector: healthy, limited, needs sign-in", () => {
    expect(connectorDots({ enabled: 5, notOk: 2, needsReauth: 1 })).toEqual([
      "success",
      "success",
      "success",
      "warning",
      "danger",
    ]);
  });

  test("no connector, no dots", () => {
    expect(connectorDots({ enabled: 0, notOk: 0, needsReauth: 0 })).toEqual([]);
  });

  test("many connectors keep their proportions within twelve dots and never hide a problem", () => {
    const dots = connectorDots({ enabled: 40, notOk: 1, needsReauth: 1 });
    expect(dots.length).toBeLessThanOrEqual(CONNECTOR_DOTS_MAX);
    expect(dots).toContain("danger");
  });
});

describe("needs you", () => {
  test("a stopped workflow is red, an expiring approval amber, a proposal blue", () => {
    expect(needVisual("execution_authority_unavailable")).toEqual({
      tone: "danger",
      icon: "approval",
    });
    expect(needVisual("approval_expiring")).toEqual({ tone: "warning", icon: "expiry" });
    expect(needVisual("patch_proposed")).toEqual({ tone: "info", icon: "proposal" });
    expect(needVisual("needs_reauth").icon).toBe("connector");
    expect(needVisual("schedule_auto_paused")).toEqual({ tone: "danger", icon: "paused" });
  });

  test("a second approval someone asked for reads as an approval to give", () => {
    expect(needVisual("pair_approval_requested")).toEqual({ tone: "info", icon: "approval" });
  });

  test("an unknown reason still gets a calm look", () => {
    expect(needVisual("something_new")).toEqual({ tone: "info", icon: "proposal" });
  });
});

describe("runs", () => {
  test("one tone per outcome", () => {
    expect(runTone("running")).toBe("info");
    expect(runTone("failed")).toBe("danger");
    expect(runTone("cancelled")).toBe("neutral");
    expect(runTone("succeeded")).toBe("success");
  });

  test("duration bars take the newest twelve finished runs, latest last", () => {
    const run = (s: number, ms: number) => ({
      started_at: new Date(s).toISOString(),
      finished_at: new Date(s + ms).toISOString(),
    });
    expect(
      durationBars([run(3000, 300), { started_at: "x", finished_at: null }, run(1000, 100)]),
    ).toEqual([100, 300]);
    expect(durationBars(Array.from({ length: 20 }, (_, i) => run(i * 1000, i))).length).toBe(12);
  });
});

describe("approval expiry", () => {
  test("counts calendar days", () => expect(daysLeft("2026-11-23", now)).toBe(3));
  test("reads an ISO instant by its date", () =>
    expect(daysLeft("2026-11-21T08:00:00.000Z", now)).toBe(1));
  test("builds a date three days ahead", () => expect(dateInDays(3, now)).toBe("2026-11-23"));
});

describe("approval limits", () => {
  test("a new approval holds until revoked, without a run limit", () => {
    expect(approvalLimits(null, now)).toEqual({
      validity: "revoked",
      until: "2026-12-20",
      maxRuns: null,
    });
  });

  test("renewing keeps the validity type and the run limit", () => {
    expect(approvalLimits({ valid_until: "2026-11-22T00:00:00Z", max_runs: 10 }, now)).toEqual({
      validity: "date",
      until: "2026-12-20",
      maxRuns: 10,
    });
  });

  test("until revoked stores no end", () => {
    expect(approvalBounds({ validity: "revoked", until: "", maxRuns: 5 }, now)).toEqual({
      ok: true,
      validUntil: null,
      maxRuns: 5,
    });
  });

  test("a date ends at the end of that local day", () => {
    const bounds = approvalBounds({ validity: "date", until: "2026-11-23", maxRuns: null }, now);
    expect(bounds.ok).toBe(true);
    if (bounds.ok) expect(bounds.validUntil).toBe(new Date(2026, 10, 23, 23, 59, 59).toISOString());
  });

  test("today is allowed, the past and an empty date are not", () => {
    expect(approvalBounds({ validity: "date", until: "2026-11-20", maxRuns: null }, now).ok).toBe(
      true,
    );
    expect(approvalBounds({ validity: "date", until: "2026-11-19", maxRuns: null }, now)).toEqual({
      ok: false,
      problem: "date_past",
    });
    expect(approvalBounds({ validity: "date", until: "", maxRuns: null }, now)).toEqual({
      ok: false,
      problem: "date_missing",
    });
  });

  test("the run limit is a whole number from 1 to 10,000, as the engine accepts", () => {
    for (const maxRuns of [0, 1.5, 10_001])
      expect(approvalBounds({ validity: "revoked", until: "", maxRuns }, now)).toEqual({
        ok: false,
        problem: "runs_invalid",
      });
  });
});

describe("grant limits for reviews, task grants and renewals", () => {
  test("a stored grant shows its own end date and run limit", () => {
    const end = new Date(2026, 11, 3, 23, 59, 59).toISOString();
    expect(grantLimits({ valid_until: end, max_runs: 4 }, now)).toEqual({
      validity: "date",
      until: "2026-12-03",
      maxRuns: 4,
    });
    expect(grantLimits({ valid_until: null }, now)).toEqual(approvalLimits(null, now));
    expect(localDay("soon")).toBeNull();
  });

  test("a suggested grant takes the chosen limits or nothing when they are invalid", () => {
    const suggested = { environment: "prod" as const, valid_from: "2026-11-20T11:00:00Z" };
    expect(limitedGrant(suggested, { validity: "revoked", until: "", maxRuns: null }, now)).toEqual(
      { ...suggested, valid_until: null, max_runs: null },
    );
    expect(
      limitedGrant(suggested, { validity: "date", until: "2026-11-27", maxRuns: 3 }, now),
    ).toEqual({
      ...suggested,
      valid_until: new Date(2026, 10, 27, 23, 59, 59).toISOString(),
      max_runs: 3,
    });
    expect(
      limitedGrant(suggested, { validity: "date", until: "2026-11-01", maxRuns: null }, now),
    ).toBeNull();
    expect(
      limitedGrant(
        { ...suggested, valid_from: "soon" },
        { validity: "revoked", until: "", maxRuns: null },
        now,
      ),
    ).toBeNull();
  });

  test("a problem names what to fix, valid limits have none", () => {
    expect(limitsProblem({ validity: "date", until: "", maxRuns: null }, now)).toBe("date_missing");
    expect(limitsProblem({ validity: "revoked", until: "", maxRuns: 0 }, now)).toBe("runs_invalid");
    expect(limitsProblem({ validity: "revoked", until: "", maxRuns: null }, now)).toBeNull();
  });

  test("a renewal starts from the newest live approval in the same environment", () => {
    const base = { valid_until: null, max_runs: null, revoked_at: null };
    const rows = [
      { ...base, id: "old", execution_environment: "prod", created_at: "2026-10-01T00:00:00Z" },
      {
        ...base,
        id: "revoked",
        execution_environment: "prod",
        created_at: "2026-11-01T00:00:00Z",
        revoked_at: "2026-11-02T00:00:00Z",
      },
      { ...base, id: "dev", execution_environment: "dev", created_at: "2026-11-10T00:00:00Z" },
    ];
    expect(renewalSource(rows, "prod")?.id).toBe("old");
    expect(renewalSource(rows, "dev")?.id).toBe("dev");
    expect(renewalSource([rows[1]!], "prod")?.id).toBe("revoked");
    expect(renewalSource(null, "prod")).toBeNull();
    expect(renewalSource(rows, "test")).toBeNull();
  });
});

describe("the run's Markdown result", () => {
  test("shows only when the engine stored one, with its truncation flag", () => {
    expect(
      runResultMarkdown({ result_markdown: "# Done", result_markdown_truncated: false }),
    ).toEqual({ text: "# Done", truncated: false });
    expect(
      runResultMarkdown({ result_markdown: "x", result_markdown_truncated: true })?.truncated,
    ).toBe(true);
    expect(runResultMarkdown({ result_markdown: null })).toBeNull();
    expect(runResultMarkdown({ result_markdown: "  " })).toBeNull();
    expect(runResultMarkdown({})).toBeNull();
    expect(runResultMarkdown(null)).toBeNull();
  });
});

describe("workflow status pill", () => {
  test("each operating status has one tone, unknown ones stay neutral", () => {
    expect(operatingTone("active")).toBe("success");
    expect(operatingTone("waiting_approval")).toBe("warning");
    expect(operatingTone("unapproved")).toBe("warning");
    expect(operatingTone("failing")).toBe("danger");
    expect(operatingTone("stopped")).toBe("danger");
    expect(operatingTone("repair_required")).toBe("danger");
    expect(operatingTone("disabled")).toBe("neutral");
    expect(operatingTone("unknown")).toBe("neutral");
  });
});

describe("run step graph", () => {
  test("finished steps are done, the live one active, a failed one stays open", () => {
    expect(
      runGraphSteps(
        [
          { step_key: "read", status: "succeeded" },
          { step_key: "write", status: "failed" },
        ],
        null,
      ).map((step) => [step.name, step.state]),
    ).toEqual([
      ["read", "done"],
      ["write", "pending"],
    ]);
  });

  test("a running run shows the steps still to come", () => {
    const graph = runGraphSteps(
      [
        { step_key: "read", status: "succeeded" },
        { step_key: "post", status: "running" },
      ],
      3,
    );
    expect(graph.map((step) => step.state)).toEqual(["done", "active", "pending"]);
    expect(graph[2]?.name).toBeNull();
  });

  test("a succeeded run without step records shows its planned steps as done", () => {
    expect(runGraphSteps([], 2, true).map((step) => step.state)).toEqual(["done", "done"]);
  });

  test("no planned count adds nothing", () => {
    expect(runGraphSteps([], null)).toEqual([]);
    expect(runGraphSteps([{ step_key: "a", status: "succeeded" }], 0)).toHaveLength(1);
  });
});

describe("run failure notice", () => {
  const labels = { runId: "Run-ID", step: "Schritt", code: "Code", finished: "Beendet" };
  test("names run, failing step, cause and end time", () => {
    expect(
      runFailureRows(
        { runId: "r1", stepKey: "fetch", cause: "auth_failed", finishedAt: "2026-11-20T13:00:00Z" },
        labels,
        () => "20.11.2026, 14:00",
      ),
    ).toEqual([
      ["Run-ID", "r1"],
      ["Schritt", "fetch"],
      ["Code", "auth_failed"],
      ["Beendet", "20.11.2026, 14:00"],
    ]);
  });

  test("leaves out what is not known", () => {
    expect(
      runFailureRows({ runId: "r1", stepKey: null, cause: "ok", finishedAt: null }, labels, String),
    ).toEqual([["Run-ID", "r1"]]);
  });

  test("the kind is the cause, or the status when there is none", () => {
    expect(runFailureKind("auth_failed", "failed")).toBe("auth_failed");
    expect(runFailureKind(null, "failed")).toBe("failed");
    expect(runFailureKind("ok", "timed_out")).toBe("timed_out");
  });
});
