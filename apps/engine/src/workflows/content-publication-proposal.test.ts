import { expect, test } from "bun:test";
import { contentPublicationLabels, revisionStepOwnsRow } from "./content-publication-proposal.ts";

test("publication labels cannot add members or expose other schedule input", () => {
  const approved = "00000000-0000-4000-8000-000000000001";
  const unknown = "00000000-0000-4000-8000-000000000002";
  const manifest = {
    effects: [
      {
        step_id: "update",
        content_publication: {
          kind: "content_revision",
          origin: "https://content.example.test",
          item_ids: [approved],
          max_bytes: 100,
        },
      },
    ],
  };
  expect(
    contentPublicationLabels(manifest, [
      {
        config: [
          { item_id: approved, repo: "project-a", password: "not-for-display" },
          { item_id: unknown, repo: "unapproved-project" },
        ],
        token: "not-for-display",
      },
    ]),
  ).toEqual([{ id: approved, label: "project-a" }]);
  expect(
    contentPublicationLabels(manifest, [
      { config: [{ item_id: approved, repo: "x".repeat(121) }] },
    ]),
  ).toEqual([]);
  expect(
    contentPublicationLabels({}, [{ config: [{ item_id: approved, repo: "project-a" }] }]),
  ).toEqual([]);
});

test("loop evidence belongs only to its exact authored step", () => {
  for (const key of ["update", "update[0]", "update[1][23]"])
    expect(revisionStepOwnsRow("update", key)).toBe(true);
  for (const key of ["updates", "update[other]", "update[-1]", "update[0]suffix", "other[0]"])
    expect(revisionStepOwnsRow("update", key)).toBe(false);
});
