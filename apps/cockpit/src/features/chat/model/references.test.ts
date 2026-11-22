import { describe, expect, test } from "bun:test";
import { collectReferencedResources, namedResources } from "./references";

describe("namedResources", () => {
  test("an id is named by the resource it belongs to, not by the name the draft targets", () => {
    const named = namedResources({
      target: { kind: "workflow", id: "workflow-growth", name: "uptime-finding-triage" },
      created: [],
      referenced: [
        {
          type: "workflow",
          id: "workflow-growth",
          label: "Mission Cockpit weekly growth report",
          at: "2026-09-01T10:00:00Z",
          unresolved: false,
        },
      ],
    });
    expect(named.get("workflow-growth")?.label).toBe("Mission Cockpit weekly growth report");
  });

  test("a created resource outranks the target, and an unresolved reference names nothing", () => {
    const named = namedResources({
      target: { kind: "workflow", id: "workflow-1", name: "draft name" },
      created: [{ kind: "workflow", id: "workflow-1", name: "Saved report", slug: "saved-report" }],
      referenced: [
        {
          type: "connector",
          id: "connector-1",
          label: "gone",
          at: "2026-09-01T10:00:00Z",
          unresolved: true,
        },
      ],
    });
    expect(named.get("workflow-1")?.label).toBe("Saved report");
    expect(named.has("connector-1")).toBe(false);
  });
});

describe("collectReferencedResources", () => {
  test("deduplicates by type and id while the latest occurrence owns the label and state", () => {
    const resources = collectReferencedResources([
      {
        role: "user",
        created_at: "2026-09-01T10:00:00Z",
        parts: [
          {
            type: "text",
            text: "first",
            references: [{ type: "workflow", id: "workflow-1", label: "old name" }],
          },
        ],
      },
      {
        role: "assistant",
        created_at: "2026-09-01T11:00:00Z",
        parts: [
          {
            type: "text",
            references: [{ type: "connector", id: "ignored", label: "assistant ref" }],
          },
        ],
      },
      {
        role: "user",
        created_at: "2026-09-02T10:00:00Z",
        parts: [
          {
            type: "text",
            text: "again",
            references: [
              { type: "workflow", id: "workflow-1", label: "customer sync" },
              { type: "connector", id: "connector-1", label: "CRM" },
            ],
            unresolved_references: [{ type: "connector", id: "connector-1", label: "CRM" }],
          },
        ],
      },
    ]);

    expect(resources).toEqual([
      {
        type: "connector",
        id: "connector-1",
        label: "CRM",
        at: "2026-09-02T10:00:00Z",
        unresolved: true,
      },
      {
        type: "workflow",
        id: "workflow-1",
        label: "customer sync",
        at: "2026-09-02T10:00:00Z",
        unresolved: false,
      },
    ]);
  });

  test("keeps a missing reference visible even when it is only in the unresolved subset", () => {
    expect(
      collectReferencedResources([
        {
          role: "user",
          created_at: "2026-09-03T10:00:00Z",
          parts: [
            {
              unresolved_references: [
                { type: "workflow", id: "workflow-missing", label: "retired workflow" },
              ],
            },
          ],
        },
      ]),
    ).toEqual([
      {
        type: "workflow",
        id: "workflow-missing",
        label: "retired workflow",
        at: "2026-09-03T10:00:00Z",
        unresolved: true,
      },
    ]);
  });

  test("keeps a collected item reference with its readable label", () => {
    expect(
      collectReferencedResources([
        {
          role: "user",
          created_at: "2026-10-10T10:00:00Z",
          parts: [
            {
              references: [
                {
                  type: "intake_item",
                  id: "item-1",
                  label: "Vier-Spuren",
                },
              ],
            },
          ],
        },
      ]),
    ).toEqual([
      {
        type: "intake_item",
        id: "item-1",
        label: "Vier-Spuren",
        at: "2026-10-10T10:00:00Z",
        unresolved: false,
      },
    ]);
  });
});
