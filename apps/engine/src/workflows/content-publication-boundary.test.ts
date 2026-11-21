import { describe, expect, test } from "bun:test";
import type { MaterializedRequest } from "../execution/prepared-request.ts";
import {
  assertContentRelease,
  assertContentRevision,
  ContentReleaseBoundarySchema,
  type ContentRevisionReceipt,
  contentPublicationShape,
  inspectContentRevisionRequest,
  inspectContentRevisionResponse,
  supportsContentPublication,
} from "./content-publication-boundary.ts";
import { WorkflowDefSchema } from "./types.ts";

const origin = "https://content.example.test";
const itemA = "00000000-0000-4000-8000-000000000001";
const itemB = "00000000-0000-4000-8000-000000000002";
const revisionA = "00000000-0000-4000-8000-000000000011";
const revisionB = "00000000-0000-4000-8000-000000000012";
const site = "00000000-0000-4000-8000-000000000021";
const revisionBoundary = {
  kind: "content_revision" as const,
  origin,
  item_ids: [itemA, itemB],
  max_bytes: 100,
};
const releaseBoundary = {
  kind: "content_release" as const,
  origin,
  site_id: site,
  reason: "Weekly update",
  sources: [{ step_id: "update", item_ids: [itemA, itemB] }],
};
function revision(overrides: Partial<MaterializedRequest> = {}): MaterializedRequest {
  return {
    method: "PUT",
    url: `${origin}/v1/content/${itemA}/revisions`,
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
    body: "# Project\nUpdated stats",
    ...overrides,
  };
}
function release(overrides: Partial<MaterializedRequest> = {}): MaterializedRequest {
  return {
    method: "POST",
    url: `${origin}/v1/sites/${site}/releases`,
    headers: { "Content-Type": "application/json" },
    body: { revision_ids: [revisionA, revisionB], reason: "Weekly update" },
    ...overrides,
  };
}
const receipts: ContentRevisionReceipt[] = [
  { step_id: "update", origin, item_id: itemA, revision_id: revisionA },
  { step_id: "update", origin, item_id: itemB, revision_id: revisionB },
];

test("only the documented authored revision shape can acquire a reusable boundary", () => {
  const request = {
    id: "update",
    connector_id: site,
    kind: "request",
    method: "PUT",
    path: "/v1/content/${item.item_id}/revisions",
    body: "${item.markdown}",
    headers: { "Content-Type": "text/markdown" },
  };
  const parsed = (change: Record<string, unknown> = {}) => {
    const step = WorkflowDefSchema.parse({ name: "Boundary", steps: [{ ...request, ...change }] })
      .steps[0]!;
    if (step.kind !== "request") throw new Error("expected request");
    return step;
  };
  const shape = contentPublicationShape(parsed(), origin);
  expect(shape?.kind).toBe("content_revision");
  expect(supportsContentPublication(parsed(), revisionBoundary, shape?.target ?? null)).toBe(true);
  for (const change of [
    { method: "DELETE" },
    { headers: { "Content-Type": "application/json" } },
    { headers: { "Content-Type": "text/markdown", "X-HTTP-Method-Override": "DELETE" } },
    { path: "https://${input.host}/v1/content/${item.item_id}/revisions" },
    { query: { publish: "true" } },
    { headers: { "Content-Type": "${input.type}" } },
  ])
    expect(contentPublicationShape(parsed(change), origin)).toBeNull();
  expect(
    supportsContentPublication(
      parsed(),
      { ...revisionBoundary, origin: "https://other.example.test" },
      shape?.target ?? null,
    ),
  ).toBe(false);
});

describe("bounded markdown revision", () => {
  test("allows changing content for each fixed approved member", () => {
    for (const item of [itemA, itemB]) {
      expect(() =>
        assertContentRevision(
          revisionBoundary,
          revision({
            url: `${origin}/v1/content/${item}/revisions`,
            body: "New report",
          }),
        ),
      ).not.toThrow();
    }
  });
  test("bounds UTF-8 bytes rather than character count", () => {
    expect(inspectContentRevisionRequest(revision({ body: "ä" }))?.bytes).toBe(2);
    expect(() =>
      assertContentRevision(revisionBoundary, revision({ body: "ä".repeat(51) })),
    ).toThrow();
  });
  test.each([
    { method: "DELETE" },
    { url: `${origin}/v1/content/${site}/revisions` },
    { url: `https://other.example.test/v1/content/${itemA}/revisions` },
    { url: `${origin}/v1/content/${itemA}/revisions?publish=true` },
    { url: `${origin}/v1/content/${itemA}/revisions#ignored` },
    { url: `${origin}/v1/content/${itemA}/other/../revisions` },
    { url: `${origin}/v1/content/${itemA}/%72evisions` },
    { url: `https://user@content.example.test/v1/content/${itemA}/revisions` },
    { headers: { "Content-Type": "text/markdown", "X-HTTP-Method-Override": "DELETE" } },
    { headers: { "Content-Type": "text/markdown", "content-type": "application/json" } },
    { headers: { "Content-Type": "multipart/form-data" } },
    { headers: { "Content-Type": "text/markdown", Host: "other.example.test" } },
    { body: { markdown: "body" } },
    { body: "" },
    { unsupported_body: true },
  ] as Partial<MaterializedRequest>[])("rejects a material deviation %j", (change) => {
    expect(() => assertContentRevision(revisionBoundary, revision(change))).toThrow();
  });
  test("rejects malformed or ambiguous approved membership", () => {
    for (const item_ids of [[], [itemB, itemA], [itemA, itemA]])
      expect(() => assertContentRevision({ ...revisionBoundary, item_ids }, revision())).toThrow();
    expect(() => assertContentRevision(revisionBoundary, undefined)).toThrow();
  });
});

describe("raw revision receipts", () => {
  test("records only successful immutable revision creation", () => {
    for (const body of [{ id: revisionA }, { revision: { id: revisionA, item_id: itemA } }])
      expect(
        inspectContentRevisionResponse({
          step_id: "update",
          request: revision(),
          status: 201,
          body,
        }),
      ).toEqual(receipts[0]!);
  });
  test.each([
    { status: 200, body: { id: revisionA } },
    { status: 500, body: { id: revisionA } },
    { status: 201, body: { id: revisionA, revision: { id: revisionB } } },
    { status: 201, body: { id: revisionA, item_id: itemB } },
    { status: 201, body: { revision: { id: revisionA, item_id: itemB } } },
    { status: 201, body: { data: { id: revisionA } } },
    { status: 201, body: { id: "invented" } },
  ])("rejects incomplete or conflicting receipt %j", (response) => {
    expect(
      inspectContentRevisionResponse({ step_id: "update", request: revision(), ...response }),
    ).toBeNull();
  });
});

describe("bounded release with same-run driver receipts", () => {
  test("publishes exactly the fixed batch; body ordering is irrelevant", () => {
    expect(() => assertContentRelease(releaseBoundary, release(), receipts)).not.toThrow();
    expect(() =>
      assertContentRelease(
        releaseBoundary,
        release({
          body: JSON.stringify({ reason: "Weekly update", revision_ids: [revisionB, revisionA] }),
        }),
        receipts,
      ),
    ).not.toThrow();
  });
  test.each([
    { revision_ids: [revisionA], reason: "Weekly update" },
    { revision_ids: [revisionA, revisionA], reason: "Weekly update" },
    { revision_ids: [revisionA, site], reason: "Weekly update" },
    { revision_ids: [revisionA, revisionB, site], reason: "Weekly update" },
    { revision_ids: [revisionA, revisionB], reason: "Other publication" },
    { revision_ids: [revisionA, revisionB], reason: "Weekly update", retire_item_ids: [itemA] },
    { revision_ids: [revisionA, revisionB], reason: "Weekly update", retire_item_ids: [] },
    { revision_ids: [revisionA, revisionB], reason: "Weekly update", force: true },
  ])("rejects extra effects, foreign revisions and partial batches %j", (body) => {
    expect(() => assertContentRelease(releaseBoundary, release({ body }), receipts)).toThrow();
  });
  test("requires every approved member's actual receipt", () => {
    for (const evidence of [
      [],
      receipts.slice(0, 1),
      [...receipts, receipts[0]!],
      [receipts[0]!, { ...receipts[1]!, step_id: "invented" }],
      [receipts[0]!, { ...receipts[1]!, origin: "https://other.example.test" }],
      [receipts[0]!, { ...receipts[1]!, revision_id: revisionA }],
    ])
      expect(() => assertContentRelease(releaseBoundary, release(), evidence)).toThrow();
  });
  test("unrelated receipts do not extend authority", () => {
    const unrelated = { ...receipts[0]!, step_id: "other", item_id: site };
    expect(() =>
      assertContentRelease(releaseBoundary, release(), [...receipts, unrelated]),
    ).not.toThrow();
    expect(() =>
      assertContentRelease(
        releaseBoundary,
        release({
          body: { reason: "Weekly update", revision_ids: [revisionA, revisionB, site] },
        }),
        [...receipts, unrelated],
      ),
    ).toThrow();
  });
  test("cannot switch website, origin, method, body type or headers", () => {
    const changes: Partial<MaterializedRequest>[] = [
      { method: "PUT" },
      { url: `${origin}/v1/sites/${itemA}/releases` },
      { url: `https://other.example.test/v1/sites/${site}/releases` },
      { url: `${origin}/v1/sites/${site}/releases?retire=true` },
      { headers: { "Content-Type": "application/json", "X-Method-Override": "DELETE" } },
      { headers: { "Content-Type": "text/plain" } },
      { unsupported_body: true },
      { body: "{" },
    ];
    for (const change of changes)
      expect(() => assertContentRelease(releaseBoundary, release(change), receipts)).toThrow();
  });
  test("rejects duplicate source steps or overlapping batches in the authority", () => {
    expect(
      ContentReleaseBoundarySchema.safeParse({
        ...releaseBoundary,
        sources: [...releaseBoundary.sources, ...releaseBoundary.sources],
      }).success,
    ).toBe(false);
    expect(
      ContentReleaseBoundarySchema.safeParse({
        ...releaseBoundary,
        sources: [...releaseBoundary.sources, { step_id: "other", item_ids: [itemA] }],
      }).success,
    ).toBe(false);
  });
});
