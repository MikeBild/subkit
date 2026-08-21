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

/** The documents a sweep can meet on a port. */
const shell = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;

/**
 * A shell in the shape of a REAL one: prose first, and the prose quotes the
 * stamp as an example before the document carries its own.
 *
 * The minimal shells below are the easy half. In all of them the marker is the
 * first thing in the file that looks like one, which is the single case the
 * first-hit reader got right — six green rejections, hole wide open. A built
 * WorkKit console whose comment quoted `content="SubKit"` passed the sweep at
 * exit 0 and produced 296 screenshots of a foreign cockpit.
 *
 * The prose is invented here, its POSITION is not: the last test below holds
 * this fixture against the real document, so the shape cannot drift into one
 * that no console has.
 */
const withProse = (example: string, head: string) =>
  shell(`<!--\n      Whose console this is. The line reads:\n\n${example}\n    -->\n    ${head}`);

const fixtures = {
  ours: readFileSync(join(root, "apps/cockpit/index.html"), "utf8"),
  sister: shell(`<title>WorkKit</title><meta name="${IDENTITY_META}" content="WorkKit" />`),
  beforeTheMarker: shell("<title>SubKit Cockpit</title>"),
  empty: "",
  vitePlaceholder: shell("<title>Vite App</title>"),
  // The stand the counter-check served on 4175: a real built cockpit, stamped
  // WorkKit, with our own name quoted in the comment above the stamp.
  sisterQuotingUs: withProse(
    `      <meta name="${IDENTITY_META}" content="SubKit" />`,
    `<meta name="${IDENTITY_META}" content="WorkKit" /><title>WorkKit Cockpit</title>`,
  ),
  // The 13-day-old orphan, but with prose that names the marker it lacks.
  beforeTheMarkerQuotingIt: withProse(
    `      <meta name="${IDENTITY_META}" content="SubKit" />`,
    "<title>WorkKit Cockpit</title>",
  ),
  // Same trap one line down: the title is what the rejection sentence PRINTS.
  titleOnlyInProse: withProse(
    "      <title>SubKit Cockpit</title>",
    "<title>WorkKit Cockpit</title>",
  ),
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

  test("a marker quoted in prose is not the document's marker", () => {
    // The whole finding in one line: before the fix this returned "SubKit".
    expect(markerIn(fixtures.sisterQuotingUs)).toBe("WorkKit");
    expect(markerIn(fixtures.beforeTheMarkerQuotingIt)).toBeNull();

    const problem = identityProblem({ served: fixtures.sisterQuotingUs, expected, baseUrl });
    expect(problem).toContain("this is not SubKit but WorkKit");
  });

  test("a build from before the marker is not rescued by prose about it", () => {
    const problem = identityProblem({
      served: fixtures.beforeTheMarkerQuotingIt,
      expected,
      baseUrl,
    });
    expect(problem).toContain("carries no");
    expect(problem).toContain('Its title reads "WorkKit Cockpit"');
  });

  test("the console is named by its own title, not by one quoted in prose", () => {
    const problem = identityProblem({ served: fixtures.titleOnlyInProse, expected, baseUrl });
    expect(problem).toContain('Its title reads "WorkKit Cockpit"');
    expect(problem).not.toContain("SubKit Cockpit");
  });

  test("an unterminated comment leaves no readable stamp", () => {
    // A document whose markup cannot be delimited must come out as "not
    // identified" rather than as a guess — the way a browser reads it.
    expect(markerIn(`<!-- <meta name="${IDENTITY_META}" content="SubKit" />`)).toBeNull();
  });

  test("the prose fixtures have the shape the real shell has", () => {
    // Without this the prose fixtures would be a shape invented for the test.
    // The real shell puts a comment ahead of its stamp; so do they.
    const comment = fixtures.ours.indexOf("<!--");
    const stamp = fixtures.ours.indexOf(`name="${IDENTITY_META}"`);
    expect(comment, "the real shell carries a comment").toBeGreaterThan(-1);
    expect(comment, "and it stands ahead of the stamp").toBeLessThan(stamp);
    expect(fixtures.sisterQuotingUs.indexOf("<!--")).toBeLessThan(
      fixtures.sisterQuotingUs.indexOf(`content="WorkKit"`),
    );
  });

  test("the sweep asks before it launches a browser", () => {
    // A lock against silent removal, not a guard — the guard is the driven
    // cases above. Order matters: asking afterwards costs a whole sweep first.
    const source = readFileSync(join(root, "scripts/verify-cockpit-visual.mjs"), "utf8");
    const ask = source.indexOf("await assertStandIsOurs();");
    const launch = source.indexOf("await chromium.launch(");
    expect(ask, "the sweep calls the assert").toBeGreaterThan(0);
    expect(ask).toBeLessThan(launch);
  });
});
