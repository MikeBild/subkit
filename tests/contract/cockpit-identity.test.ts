// The identity question, driven — not read.
//
// The rule this file obeys: a guard that checks TEXT instead of EFFECT is not a
// guard. A sister repo pinned its identity rule as "the line is present"; an
// implementation that left the line in place and asked the wrong document
// passed 12/0 with the hole fully open. So `identityProblem` is imported and
// fed the cases it exists to reject.
//
// tests/contract/ because CI's shard job runs `apps packages` only
// (LOCAL-SK-SCRIPTS-TESTS-NICHT-IN-CI). `bun run test:contract` runs this.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedIdentity,
  IDENTITY_META,
  identityProblem,
  markerIn,
} from "../../scripts/lib/cockpit-identity.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const baseUrl = "http://127.0.0.1:4175";

/** The five documents a sweep can meet on a port. */
const shell = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;
const fixtures = {
  ours: readFileSync(join(root, "apps/cockpit/index.html"), "utf8"),
  sister: shell(`<title>WorkKit</title><meta name="${IDENTITY_META}" content="WorkKit" />`),
  beforeTheMarker: shell("<title>SubKit Cockpit</title>"),
  empty: "",
  vitePlaceholder: shell("<title>Vite App</title>"),
};

describe("the visual sweep asks whose console it is photographing", () => {
  const expected = expectedIdentity();

  test("the definition site names the console exactly once", () => {
    expect(expected, "apps/cockpit/index.html carries the marker").toBe("SubKit");
    expect([...fixtures.ours.matchAll(new RegExp(`name="${IDENTITY_META}"`, "g"))]).toHaveLength(1);
  });

  test("our own served document passes", () => {
    expect(identityProblem({ served: fixtures.ours, expected, baseUrl })).toBeNull();
  });

  test("a sister console is named, not merely rejected", () => {
    const problem = identityProblem({ served: fixtures.sister, expected, baseUrl });
    expect(problem).toContain("this is not SubKit but WorkKit");
    expect(problem).toContain(baseUrl);
  });

  test("a build from before the marker is rejected, with its title", () => {
    // The 13-day-old orphan on 4080 was exactly this: no marker at all.
    const problem = identityProblem({ served: fixtures.beforeTheMarker, expected, baseUrl });
    expect(problem).toContain("carries no");
    expect(problem).toContain('Its title reads "SubKit Cockpit"');
  });

  test("an empty and a placeholder document are rejected too", () => {
    expect(identityProblem({ served: fixtures.empty, expected, baseUrl })).toContain(
      "(no <title>)",
    );
    expect(identityProblem({ served: fixtures.vitePlaceholder, expected, baseUrl })).toContain(
      'Its title reads "Vite App"',
    );
  });

  test("a lost marker is a finding about THIS repository", () => {
    // Not "foreign document" about our own console — the direction a sister repo
    // got backwards.
    const problem = identityProblem({ served: fixtures.ours, expected: null, baseUrl });
    expect(problem).toContain("a finding about THIS repository");
    expect(markerIn(shell(""))).toBeNull();
  });

  test("the sweep asks before it launches a browser", () => {
    // A lock against silent removal, not a guard — the guard is the six cases
    // above. Order matters: asking afterwards costs a whole sweep first.
    const source = readFileSync(join(root, "scripts/verify-cockpit-visual.mjs"), "utf8");
    const ask = source.indexOf("await assertStandIsOurs();");
    const launch = source.indexOf("await chromium.launch(");
    expect(ask, "the sweep calls the assert").toBeGreaterThan(0);
    expect(ask).toBeLessThan(launch);
  });
});
