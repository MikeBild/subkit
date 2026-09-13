// Unit tests for detectCountInconsistencies — the deterministic count checks
// added to the chat critic. Regression guard for a bulk-delete summary where
// the assistant claimed "3 Workflows / 5 total" over a 2-workflow tenant and a
// self-contradictory "5 = 2+2" final tally, and the critic passed it with
// confidence 1.

import { describe, expect, test } from "bun:test";

import { detectCountInconsistencies } from "../count-consistency.ts";

const codes = (t: string) => detectCountInconsistencies(t).map((i) => i.kind);

describe("A — arithmetic (total ≠ sum of + parts)", () => {
  test("real final tally: '5 … : 2 Workflows + 2 Connectors' → arithmetic", () => {
    const t = "Fertig. Alle 5 Acme-Ferries-Ressourcen gelöscht: 2 Workflows + 2 Connectors.";
    expect(codes(t)).toContain("arithmetic");
  });

  test("consistent total in parens '5 … (3 Workflows + 2 Connectors)' → no flag", () => {
    const t = "Alle 5 Acme-Ferries-Ressourcen (3 Workflows + 2 Connectors) wirklich löschen?";
    expect(detectCountInconsistencies(t)).toHaveLength(0);
  });

  test("three parts that don't sum: '10 items: 3 a + 3 b + 2 c' → arithmetic", () => {
    expect(codes("Deleted 10 items: 3 workflows + 3 connectors + 2 schedules")).toContain(
      "arithmetic",
    );
  });

  test("English '6 things = 2 apples + 4 oranges' consistent → no flag", () => {
    expect(detectCountInconsistencies("6 things = 2 apples + 4 oranges")).toHaveLength(0);
  });

  test("prose 'released 3 months and 1 week ago' (no + notation) → no false positive", () => {
    expect(detectCountInconsistencies("version 2 (released 3 months and 1 week ago)")).toHaveLength(
      0,
    );
  });

  test("plain number, no breakdown → no flag", () => {
    expect(detectCountInconsistencies("You have 27 workflows in this tenant.")).toHaveLength(0);
  });
});

describe("B — over-enumeration (stated count > substantive bullets)", () => {
  const acmeMsg = [
    "Du möchtest alle Acme-Ferries-Ressourcen löschen. Das sind 3 Workflows und 2 Connectors:",
    "",
    "Workflows:",
    "• acme-ferries-daily-cabin-price-check",
    "• acme-ferries-daily-cabin-price-check-rpc",
    "• (keine weiteren mit acme-ferries im Namen)",
    "",
    "Connectors:",
    "• acme-ferries-web",
    "• acme-ferries-booking-rpc",
  ].join("\n");

  test("real summary: '3 Workflows' over 2 real + 1 hedge bullet → over_enumeration", () => {
    expect(codes(acmeMsg)).toContain("over_enumeration");
  });

  test("the matching '2 Connectors' section (2 real bullets) does NOT add an issue", () => {
    const issues = detectCountInconsistencies(acmeMsg);
    // exactly one over_enumeration (workflows), connectors are consistent
    expect(issues.filter((i) => i.kind === "over_enumeration")).toHaveLength(1);
  });

  test("honest list: '2 Workflows' over exactly 2 bullets → no flag", () => {
    const t = "Found 2 Workflows:\n• alpha\n• beta";
    expect(detectCountInconsistencies(t)).toHaveLength(0);
  });

  test("truncation qualifier 'Top 5 repos' over 3 bullets → no false positive", () => {
    const t = "Top 5 repos:\n• a\n• b\n• c";
    expect(detectCountInconsistencies(t)).toHaveLength(0);
  });

  test("'showing 3' qualifier → no false positive", () => {
    const t = "Here are the workflows (showing 3):\n• a\n• b";
    expect(detectCountInconsistencies(t)).toHaveLength(0);
  });

  test("under-claim 'here are 2 of your workflows' over 3 bullets → no flag (legit)", () => {
    const t = "Here are 2 workflows:\n• a\n• b\n• c";
    expect(detectCountInconsistencies(t)).toHaveLength(0);
  });

  test("no bullet list at all → no flag", () => {
    expect(detectCountInconsistencies("I deleted 3 workflows for you.")).toHaveLength(0);
  });
});

describe("clean real-world messages stay quiet", () => {
  for (const t of [
    "Done. The workflow ran and returned 12 rows.",
    "Connectors (13 total):\n• github\n• notion\n• supabase-rest",
    "I found 3 connectors:\n• github\n• notion\n• gmail",
    "Your tenant has 27 workflows and 13 connectors.",
  ]) {
    test(JSON.stringify(t.slice(0, 40)), () => {
      expect(detectCountInconsistencies(t)).toHaveLength(0);
    });
  }
});
