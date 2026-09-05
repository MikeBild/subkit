import { describe, expect, test } from "bun:test";
import { ContextSnapshotSchema } from "./schemas.ts";

const resourceSchema = ContextSnapshotSchema.shape.persisted_resources.element;
const legacyResource = {
  kind: "workflow",
  id: "workflow",
  slug: "example",
  name: "Example",
  version_id: "version-1",
  version: 1,
  environment: null,
  saved_at: "2026-01-01T00:00:00.000Z",
};

describe("context snapshot persisted resource contract", () => {
  test("preserves exact draft and active version boundaries for cockpit reload", () => {
    const draft = {
      ...legacyResource,
      draft_version_id: "version-1",
      current_version_id: "older-active-version",
      persistence_kind: "draft" as const,
    };
    expect(resourceSchema.parse(draft)).toEqual(draft);
    expect(resourceSchema.parse({ ...draft, current_version_id: null })).toEqual({
      ...draft,
      current_version_id: null,
    });
  });

  test("accepts historical snapshots without inventing an observed draft base", () => {
    expect(resourceSchema.parse(legacyResource)).toEqual(legacyResource);
    expect(resourceSchema.parse(legacyResource)).not.toHaveProperty("draft_version_id");
    expect(resourceSchema.parse(legacyResource)).not.toHaveProperty("persistence_kind");
  });

  test("rejects an unknown persistence kind", () => {
    expect(
      resourceSchema.safeParse({ ...legacyResource, persistence_kind: "authorized" }).success,
    ).toBe(false);
  });
});
