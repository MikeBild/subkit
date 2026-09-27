import { describe, expect, test } from "bun:test";
import { distinctStatus, metricOffersDrilldown } from "./overview-model";

const at = (path: string) => ({ path });

describe("the way in from a number", () => {
  test("a number that counted something offers the engine's way in", () => {
    expect(
      metricOffersDrilldown({ value: 3, drilldown: at("/cockpit/decisions?bucket=blocked") }),
    ).toBe(true);
  });

  test("a tile standing at zero offers none", () => {
    // The live defect: "production incidents: 0" with a link to 977 rows.
    expect(
      metricOffersDrilldown({ value: 0, drilldown: at("/cockpit/decisions?bucket=blocked") }),
    ).toBe(false);
  });

  test("an unreadable value is unknown, not empty, and still offers none", () => {
    expect(metricOffersDrilldown({ value: null, drilldown: at("/cockpit/runs") })).toBe(false);
    expect(metricOffersDrilldown({ value: undefined, drilldown: at("/cockpit/runs") })).toBe(false);
  });

  test("an unreadable value that is red keeps its way to the cause", () => {
    // Blocked work makes the state critical with no score when nothing ran.
    expect(
      metricOffersDrilldown({
        value: null,
        severity: "critical",
        drilldown: at("/cockpit/decisions?bucket=blocked"),
      }),
    ).toBe(true);
    expect(
      metricOffersDrilldown({ value: null, severity: "urgent", drilldown: at("/cockpit/runs") }),
    ).toBe(true);
    expect(
      metricOffersDrilldown({ value: null, severity: "unknown", drilldown: at("/cockpit/runs") }),
    ).toBe(false);
    // A counted zero never links, however it is coloured.
    expect(
      metricOffersDrilldown({
        kind: "count",
        value: 0,
        severity: "critical",
        drilldown: at("/cockpit/runs"),
      }),
    ).toBe(false);
  });

  test("a ratio, score or duration at zero is the worst state, not nothing, and leads to its cause", () => {
    // Execution success 0 %, connector health 0 %, repair rate 0 %, health
    // score 0: each is red, and a red tile keeps its way to the cause (§1).
    for (const kind of ["ratio", "score", "duration"]) {
      expect(
        metricOffersDrilldown({
          kind,
          value: 0,
          severity: "critical",
          drilldown: at("/cockpit/connectors?health=not_ok"),
        }),
      ).toBe(true);
    }
    // The zero rule is about counts only, and an untyped metric is a count.
    expect(metricOffersDrilldown({ kind: "count", value: 0, drilldown: at("/cockpit/runs") })).toBe(
      false,
    );
    expect(metricOffersDrilldown({ value: 0, drilldown: at("/cockpit/runs") })).toBe(false);
    // Still no way in without a path.
    expect(metricOffersDrilldown({ kind: "ratio", value: 0, drilldown: at(" ") })).toBe(false);
  });

  test("no path is no way in, whatever the value", () => {
    expect(metricOffersDrilldown({ value: 5, drilldown: at("") })).toBe(false);
    expect(metricOffersDrilldown({ value: 5, drilldown: at("   ") })).toBe(false);
    expect(metricOffersDrilldown({ value: 5, drilldown: null })).toBe(false);
    expect(metricOffersDrilldown({ value: 5 })).toBe(false);
  });

  test("a ratio above zero leads to what the engine points it at", () => {
    // The decided repairs behind the repair rate — the engine's own address.
    expect(
      metricOffersDrilldown({
        value: 0.4,
        drilldown: at(
          "/cockpit/audit?scope=all&action=patch_candidate.approved,patch_candidate.auto_applied,patch_candidate.rejected",
        ),
      }),
    ).toBe(true);
  });
});

describe("distinctStatus", () => {
  test("a status line that repeats the value is dropped", () => {
    // "Betriebszustand: Gesund / Gesund" and "Datenstand: Aktuell / Aktuell".
    expect(distinctStatus("Gesund", "Gesund")).toBeUndefined();
    expect(distinctStatus("Aktuell", " Aktuell ")).toBeUndefined();
  });

  test("a status line that adds a fact stays", () => {
    expect(distinctStatus("3 h", "Veraltet")).toBe("Veraltet");
  });

  test("no status is no status", () => {
    expect(distinctStatus("12", undefined)).toBeUndefined();
  });
});
