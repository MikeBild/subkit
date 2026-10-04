import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  formatRunDuration,
  isExecutionRecord,
  previewText,
  requestSourceLabel,
  runAuthorityFacts,
  runCostFacts,
  runDurationMs,
  runName,
  runOverlayFromUrl,
  runOverlaySearch,
} from "@/pages/runs-model";

const t = (key: Parameters<typeof translate>[1]) => translate("en", key);

describe("run authority evidence", () => {
  test("durable preparation is identified in both locales without claiming a live grant", () => {
    for (const locale of ["en", "de"] as const) {
      const local = (key: Parameters<typeof translate>[1]) => translate(locale, key);
      const facts = runAuthorityFacts(
        {
          execution_authority_id: null,
          workflow_version_id: "reviewed-version",
          hold_writes: true,
        },
        local,
      );
      expect(facts[0]).toEqual([local("runs.boundary"), local("runs.preparationDescription")]);
      expect(facts).toContainEqual([
        local("authority.usedByRun"),
        local("authority.noStoredBinding"),
      ]);
    }
  });
  test("shows only the authority and version stored on the exact execution", () => {
    expect(
      runAuthorityFacts(
        {
          execution_authority_id: "historical-authority",
          workflow_version_id: "historical-version",
        },
        t,
      ),
    ).toEqual([
      ["Authority recorded for this run", "historical-authority"],
      ["Exact workflow version", "historical-version"],
    ]);
  });
  test("does not reinterpret unbound runs as approved or unauthorized", () => {
    expect(
      runAuthorityFacts({ execution_authority_id: null, workflow_version_id: null }, t),
    ).toEqual([["Authority recorded for this run", "No execution-authority binding recorded"]]);
  });
  test("shortens the two identifiers a person actually gets, and keeps them copyable", () => {
    const authority = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
    const version = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const facts = runAuthorityFacts(
      { execution_authority_id: authority, workflow_version_id: version },
      t,
    );
    expect(facts).toEqual([
      ["Authority recorded for this run", "018f4b4a…", authority],
      ["Exact workflow version", "7c9e6679…", version],
    ]);
    for (const [, shown] of facts) {
      expect(shown).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });
  test("a value that was never shortened is not given a tooltip of itself", () => {
    const [authority, version] = runAuthorityFacts(
      { execution_authority_id: "historical-authority", workflow_version_id: "historical-version" },
      t,
    );
    expect(authority).toHaveLength(2);
    expect(version).toHaveLength(2);
  });
  test("localizes the absence of stored evidence without translating identifiers", () => {
    const de = (key: Parameters<typeof translate>[1]) => translate("de", key);
    expect(
      runAuthorityFacts({ execution_authority_id: null, workflow_version_id: "exact-id" }, de),
    ).toEqual([
      [
        "Für diesen Run gespeicherte Freigabe",
        "Keine Bindung an eine Ausführungsfreigabe gespeichert",
      ],
      ["Exakte Workflow-Version", "exact-id"],
    ]);
  });
});

function run(patch: Record<string, unknown> = {}) {
  return {
    id: "run",
    workflow_id: null,
    workflow_name: null,
    workflow_version_id: null,
    execution_authority_id: null,
    source_kind: "saved" as const,
    source_ref: null,
    status: "succeeded",
    request_source: "api",
    parent_execution_id: null,
    started_at: "2026-08-10T08:00:00.000Z",
    finished_at: "2026-08-10T08:00:05.000Z",
    created_at: "2026-08-10T08:00:00.000Z",
    ...patch,
  };
}

describe("run duration", () => {
  test("has no duration while the run has not finished", () => {
    expect(runDurationMs(run({ finished_at: null }))).toBeNull();
    expect(runDurationMs(run({ started_at: null }))).toBeNull();
  });

  test("never reports a negative duration", () => {
    expect(
      runDurationMs(
        run({ started_at: "2026-08-10T08:00:05.000Z", finished_at: "2026-08-10T08:00:00.000Z" }),
      ),
    ).toBeNull();
  });

  test("measures the distance between the two timestamps", () => {
    expect(runDurationMs(run())).toBe(5_000);
  });

  test("carries 119.6 seconds into two minutes rather than one minute sixty", () => {
    expect(formatRunDuration("en", 119_600)).toBe("2m 0s");
  });

  test("keeps sub-second runs in milliseconds and short runs in tenths", () => {
    expect(formatRunDuration("en", 640)).toBe("640 ms");
    expect(formatRunDuration("en", 5_000)).toBe("5.0 s");
  });
});

describe("run naming and request source", () => {
  test("falls back to the kind of run when no workflow name exists", () => {
    expect(runName(run({ workflow_name: null, source_kind: "draft" }), t)).toBe(
      translate("en", "runs.sourceKind.draft"),
    );
  });

  test("prefers the workflow name", () => {
    expect(runName(run({ workflow_name: "Monthly report" }), t)).toBe("Monthly report");
  });

  test("names known request sources and shows an unnamed one as the machine value", () => {
    expect(requestSourceLabel("scheduler", t)).toEqual({
      text: translate("en", "runs.source.scheduler"),
      machine: false,
    });
    expect(requestSourceLabel("carrier-pigeon", t)).toEqual({
      text: "carrier-pigeon",
      machine: true,
    });
  });
});

describe("what a run consumed", () => {
  const de = (key: Parameters<typeof translate>[1]) => translate("de", key);

  test("a run that never called a model contributes nothing, not a row of zeros", () => {
    expect(runCostFacts({ llm: { calls: 0 }, external: { cost_usd: 0 } }, t, "en")).toEqual([]);
  });

  test("an absent or unrecognised payload contributes nothing", () => {
    for (const bad of [null, undefined, "nope", 42, {}]) {
      expect(runCostFacts(bad, t, "en")).toEqual([]);
    }
  });

  test("names the tokens, the calls and the cache share", () => {
    const facts = runCostFacts(
      { llm: { calls: 7, weighted_tokens: 58_472, cache_read_pct: 62 }, external: {} },
      t,
      "en",
    );
    expect(facts.map(([label]) => label)).toEqual([
      translate("en", "runs.cost.tokens"),
      translate("en", "runs.cost.calls"),
      translate("en", "runs.cost.cacheRead"),
    ]);
    expect(facts[0]?.[1]).toBe("58,472");
    expect(facts[2]?.[1]).toBe("62%");
  });

  test("reads the cache share as the 0-100 the contract declares", () => {
    expect(runCostFacts({ llm: { calls: 1, cache_read_pct: 1 } }, t, "en")[2]?.[1]).toBe("1%");
    expect(runCostFacts({ llm: { calls: 1, cache_read_pct: 62 } }, t, "en")[2]?.[1]).toBe("62%");
    expect(runCostFacts({ llm: { calls: 1, cache_read_pct: 100 } }, t, "en")[2]?.[1]).toBe("100%");
    expect(runCostFacts({ llm: { calls: 1, cache_read_pct: 0 } }, t, "en")[2]?.[1]).toBe("0%");
  });

  test("money appears only when money was spent", () => {
    expect(runCostFacts({ llm: { calls: 3 }, external: { cost_usd: 0 } }, t, "en")).toHaveLength(2);
    const paid = runCostFacts({ llm: { calls: 3 }, external: { cost_usd: 0.1834 } }, t, "en");
    expect(paid.at(-1)?.[0]).toBe(translate("en", "runs.cost.external"));
    expect(paid.at(-1)?.[1]).toContain("0.1834");
  });

  test("formats in the reader's language", () => {
    const facts = runCostFacts({ llm: { calls: 1, weighted_tokens: 58_472 } }, de, "de");
    expect(facts[0]?.[1]).toBe("58.472");
  });
});

describe("the run sheets an address opens", () => {
  const ID = "018f4b4a-6d33-7b3a-9c2d-123456789abc";

  test("reads one run and the list of all runs out of the query", () => {
    expect(runOverlayFromUrl(`?run=${ID}`)).toEqual({ list: false, runId: ID });
    expect(runOverlayFromUrl("?runs=all&status=failed")).toEqual({ list: true, runId: null });
    expect(runOverlayFromUrl(`?runs=all&run=${ID}`)).toEqual({ list: true, runId: ID });
  });

  test("an address without them opens nothing", () => {
    expect(runOverlayFromUrl("")).toEqual({ list: false, runId: null });
    expect(runOverlayFromUrl("?runs=some")).toEqual({ list: false, runId: null });
    expect(runOverlayFromUrl("?run=a%20b").runId).toBeNull();
  });

  test("opening and closing keeps the page's own parameters", () => {
    expect(runOverlaySearch("?review=x", { list: false, runId: ID })).toBe(`?review=x&run=${ID}`);
    expect(runOverlaySearch(`?review=x&run=${ID}`, { list: false, runId: null })).toBe("?review=x");
    expect(runOverlaySearch("?runs=all&status=failed", { list: true, runId: ID })).toBe(
      `?runs=all&status=failed&run=${ID}`,
    );
  });

  test("closing the list drops the narrowing it read", () => {
    expect(
      runOverlaySearch("?runs=all&status=failed&workflow_id=w&tab=x", {
        list: false,
        runId: null,
      }),
    ).toBe("?tab=x");
  });
});

describe("previewText — what a step left behind", () => {
  test("the text column's JSON-null literal is not a result", () => {
    expect(previewText("null")).toBeNull();
    expect(previewText("  null  ")).toBeNull();
    expect(previewText("undefined")).toBeNull();
  });

  test("the whole coalesce a failed step produces yields nothing", () => {
    const step = { output_preview: null, result_preview: "null" };
    expect(previewText(step.output_preview ?? step.result_preview)).toBeNull();
  });

  test("absent and empty previews stay absent", () => {
    expect(previewText(null)).toBeNull();
    expect(previewText(undefined)).toBeNull();
    expect(previewText("")).toBeNull();
    expect(previewText("   ")).toBeNull();
  });

  test("a real result survives, JSON and text alike", () => {
    expect(previewText({ ok: true })).toBe('{\n  "ok": true\n}');
    expect(previewText("delivered")).toBe("delivered");
    expect(previewText(false)).toBe("false");
    expect(previewText(0)).toBe("0");
  });

  test("content that merely mentions null is kept", () => {
    expect(previewText("null was returned by the upstream API")).toBe(
      "null was returned by the upstream API",
    );
    expect(previewText({ value: null })).toBe('{\n  "value": null\n}');
  });
});

describe("isExecutionRecord — what came back with a 200", () => {
  test("the courtesy 200 that crashed the page is refused", () => {
    expect(isExecutionRecord({ items: [] })).toBe(false);
    expect(isExecutionRecord({})).toBe(false);
    expect(isExecutionRecord(null)).toBe(false);
    expect(isExecutionRecord(undefined)).toBe(false);
    expect(isExecutionRecord("<!doctype html>")).toBe(false);
    expect(isExecutionRecord([])).toBe(false);
  });

  test("a half-shaped answer is not an execution either", () => {
    expect(isExecutionRecord({ id: "run-1" })).toBe(false);
    expect(isExecutionRecord({ status: "succeeded" })).toBe(false);
    expect(isExecutionRecord({ id: 7, status: "succeeded" })).toBe(false);
  });

  test("the engine's own record is accepted", () => {
    expect(isExecutionRecord(run())).toBe(true);
    expect(isExecutionRecord({ id: "run-1", status: "failed" })).toBe(true);
  });
});
