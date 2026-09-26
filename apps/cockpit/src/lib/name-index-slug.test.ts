// The chat said what a run was called in machine terms.
//
// A run is announced as `wf_<slug>`, and the slug is deliberately not
// humanised: turning `ga4-daily-report` into "Ga4 Daily Report" reads like a
// mangling of a name rather than a name. But the workflow HAS a name — the
// cockpit already loads it — so the honest move is to resolve the slug, not to
// dress it up.

import { expect, test } from "bun:test";
import { resolveWorkflowNameBySlug } from "./name-index";

const catalogue = [
  { slug: "ga4-daily-report", name: "Daily traffic report" },
  { slug: "radar-collect-weekly", name: "radar-collect-weekly" },
  { slug: "no-name", name: null },
];

test("a slug is answered with the name its author gave it", () => {
  expect(resolveWorkflowNameBySlug(catalogue, "ga4-daily-report")).toBe("Daily traffic report");
});

test("nothing better than the slug means the slug stands", () => {
  // Unknown slug: the caller keeps what it has rather than inventing a prettier
  // one. An answer nobody asked for is worse than a plain one.
  expect(resolveWorkflowNameBySlug(catalogue, "never-heard-of-it")).toBeNull();
  // A name equal to the slug adds nothing, so it is not offered as an
  // improvement — that would just look like a change with no content.
  expect(resolveWorkflowNameBySlug(catalogue, "radar-collect-weekly")).toBeNull();
  expect(resolveWorkflowNameBySlug(catalogue, "no-name")).toBeNull();
});
