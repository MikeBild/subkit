import { describe, expect, test } from "bun:test";
import { collectReferencedResources } from "./chat-references";

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
});
