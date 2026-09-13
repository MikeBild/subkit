import { describe, expect, test } from "bun:test";

import { translate } from "@/lib/i18n";
import {
  formatRunDuration,
  requestSourceLabel,
  runAuthorityFacts,
  runDurationMs,
  runName,
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
  test("does not reinterpret legacy runs as approved or unauthorized", () => {
    expect(
      runAuthorityFacts({ execution_authority_id: null, workflow_version_id: null }, t),
    ).toEqual([["Authority recorded for this run", "No execution-authority binding recorded"]]);
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

  test("names known request sources and admits when a source is unknown", () => {
    expect(requestSourceLabel("scheduler", t)).toBe(translate("en", "runs.source.scheduler"));
    expect(requestSourceLabel("carrier-pigeon", t)).toBe(translate("en", "common.unknown"));
  });
});
