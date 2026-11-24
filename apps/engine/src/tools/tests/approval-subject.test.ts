import { describe, expect, test } from "bun:test";
import { ApprovalSubjectSchema, workflowSubjectChanges } from "../approval-subject.ts";

describe("workflowSubjectChanges", () => {
  test("records proposed name, slug and lifecycle in a stable order", () => {
    expect(
      workflowSubjectChanges({
        id: "00000000-0000-4000-8000-000000000001",
        lifecycle: "archived",
        slug: "invoice-sync-v2",
        name: "Invoice sync (new)",
      }),
    ).toEqual([
      { field: "name", to: "Invoice sync (new)" },
      { field: "slug", to: "invoice-sync-v2" },
      { field: "lifecycle", to: "archived" },
    ]);
  });

  test("scrubs a proposed description and records a cleared one as empty", () => {
    const [long] = workflowSubjectChanges({
      description: `token sk-ant-${"a".repeat(40)} ${"x".repeat(400)}`,
    });
    expect(long?.field).toBe("description");
    expect(long?.to).toEndWith("x".repeat(400));
    expect(long?.to).not.toContain("sk-ant-aaaa");
    expect(workflowSubjectChanges({ description: "" })).toEqual([{ field: "description", to: "" }]);
  });

  test("preserves the full proposed description beyond the preview limit", () => {
    const description = `${"x".repeat(160)} Remaining changes require review.`;
    expect(workflowSubjectChanges({ description })).toEqual([
      { field: "description", to: description },
    ]);
  });

  test("ignores non-string and unknown fields", () => {
    expect(workflowSubjectChanges({ name: 42, steps: [], lifecycle: null })).toEqual([]);
  });

  test("the subject schema rejects unknown fields", () => {
    expect(
      ApprovalSubjectSchema.safeParse({
        resource_type: "workflow",
        resource_id: "00000000-0000-4000-8000-000000000001",
        current_name: null,
        current_slug: null,
        changes: [],
        extra: true,
      }).success,
    ).toBe(false);
  });
});
