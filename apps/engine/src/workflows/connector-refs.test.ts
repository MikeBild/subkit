import { describe, expect, test } from "bun:test";
import { connectorReferencesForDefinition, placeholderSlugsIn } from "./connector-refs.ts";

describe("placeholderSlugsIn", () => {
  test("extracts the slug from the documented base_url placeholder", () => {
    expect(placeholderSlugsIn("${connector.gmail.base_url}/messages")).toEqual(["gmail"]);
  });

  test("accepts the full validator slug charset", () => {
    expect(placeholderSlugsIn("${connector.my_api-v2.base_url}/x")).toEqual(["my_api-v2"]);
  });

  test("finds a placeholder that is not at the start of the url", () => {
    expect(placeholderSlugsIn("https://proxy/?to=${connector.stripe.base_url}")).toEqual([
      "stripe",
    ]);
  });

  test("counts a non-base_url property as a reference too", () => {
    expect(placeholderSlugsIn("${connector.notion.api_version}")).toEqual(["notion"]);
  });

  test("returns each slug once, in first-seen order", () => {
    expect(
      placeholderSlugsIn("${connector.b.base_url}/x/${connector.a.base_url}/${connector.b.token}"),
    ).toEqual(["b", "a"]);
  });

  test("ignores urls with no placeholder", () => {
    expect(placeholderSlugsIn("https://api.example.com/v1/things")).toEqual([]);
    expect(placeholderSlugsIn("")).toEqual([]);
  });

  test("does not match a malformed placeholder", () => {
    expect(placeholderSlugsIn("${connector..base_url}")).toEqual([]);
    expect(placeholderSlugsIn("${connectors.gmail.base_url}")).toEqual([]);
    expect(placeholderSlugsIn("${env.gmail.base_url}")).toEqual([]);
  });
});

describe("connectorReferencesForDefinition", () => {
  const active = { id: "active-id", slug: "active", name: "Active", deleted_at: null };
  const deleted = {
    id: "deleted-id",
    slug: "deleted",
    name: "Deleted",
    deleted_at: new Date("2000-01-01T00:00:00Z"),
  };

  test("keeps deleted and missing references distinct per step", () => {
    const references = connectorReferencesForDefinition(
      {
        steps: [
          { id: "read", connector_id: active.id, url: "${connector.active.base_url}" },
          { id: "write", connector_id: deleted.id },
          { id: "unknown", connector_id: "outside-tenant" },
          { id: "placeholder", url: "${connector.deleted.base_url}" },
        ],
      },
      [active, deleted],
    );
    expect(references).toEqual([
      {
        step_id: "read",
        connector_id: active.id,
        slug: "active",
        name: "Active",
        reason: "available",
      },
      {
        step_id: "write",
        connector_id: deleted.id,
        slug: "deleted",
        name: "Deleted",
        reason: "deleted",
      },
      {
        step_id: "unknown",
        connector_id: "outside-tenant",
        slug: null,
        name: null,
        reason: "missing",
      },
      {
        step_id: "placeholder",
        connector_id: deleted.id,
        slug: "deleted",
        name: "Deleted",
        reason: "deleted",
      },
    ]);
  });

  test("a reused slug resolves to the active connector while an old id stays deleted", () => {
    const replacement = { ...active, slug: deleted.slug };
    expect(
      connectorReferencesForDefinition(
        {
          steps: [
            { id: "old", connector_id: deleted.id },
            { id: "current", url: "${connector.deleted.base_url}" },
          ],
        },
        [replacement, deleted],
      ).map((reference) => reference.reason),
    ).toEqual(["deleted", "available"]);
  });

  test("does not invent references from malformed definitions or body payloads", () => {
    expect(connectorReferencesForDefinition(null, [active])).toEqual([]);
    expect(
      connectorReferencesForDefinition(
        { steps: [{ id: "transform", body: { connector_id: active.id } }] },
        [active],
      ),
    ).toEqual([]);
  });
});

test("collects request steps referenced by branch and parallel control flow", () => {
  const connector = {
    id: "connector",
    slug: "nested",
    name: "Nested",
    deleted_at: new Date("2000-01-01T00:00:00Z"),
  };
  const references = connectorReferencesForDefinition(
    {
      steps: [
        { id: "request", kind: "request", connector_id: connector.id },
        {
          id: "branch",
          kind: "branch",
          when: "true",
          then_steps: ["request"],
          else_steps: ["request"],
        },
        { id: "parallel", kind: "parallel", branches: [["branch"], ["request"]] },
      ],
    },
    [connector],
  );
  expect(references).toEqual([
    {
      step_id: "request",
      connector_id: connector.id,
      slug: "nested",
      name: "Nested",
      reason: "deleted",
    },
  ]);
});
