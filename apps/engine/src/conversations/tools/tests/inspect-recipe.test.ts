// Unit tests for the inspect_recipe conversation tool.
//
// The tool is read-only and free of side effects, so we invoke
// `execute` with a stub context and assert the returned shape. This
// is the same payload the LLM sees on the tool_result message.

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../index.ts";
import { inspectRecipeTool } from "../inspect-recipe.ts";

const STUB_CTX = {} as ToolContext;

describe("inspect_recipe — tool metadata contract", () => {
  test("is read-only (tenant_read) so it cannot trigger a confirmation dialog", () => {
    expect(inspectRecipeTool.category).toBe("tenant_read");
  });

  test("description directs the model to call before clone, not after", () => {
    expect(inspectRecipeTool.description).toMatch(/before cloning/i);
    // start_workflow_from_recipe is referenced in important_notes + use_case;
    // the description is intentionally tight on tokens.
    expect(inspectRecipeTool.use_case).toMatch(/start_workflow_from_recipe/i);
  });
});

describe("inspect_recipe — execute", () => {
  test("returns description + step summary + F1 metadata for a known recipe", async () => {
    const result = await inspectRecipeTool.execute(STUB_CTX, {
      template_slug: "stripe",
      recipe_slug: "list-customers",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    expect(data.template_slug).toBe("stripe");
    expect(data.recipe_slug).toBe("list-customers");
    expect(typeof data.title).toBe("string");
    expect(typeof data.description).toBe("string");
    expect(data.category).toBe("payments");
    expect(Array.isArray(data.tags)).toBe(true);
    expect(["beginner", "intermediate", "advanced"]).toContain(data.difficulty as string);
    expect(typeof data.estimated_setup_minutes).toBe("number");
    expect(Array.isArray(data.prerequisites)).toBe(true);
    expect(Array.isArray(data.intent_keywords)).toBe(true);
    expect(Array.isArray(data.required_connectors)).toBe(true);
    expect(typeof data.version).toBe("string");
    expect(data.author).toBe("subkit-builtin");
    expect(typeof data.step_count).toBe("number");
    expect(Array.isArray(data.step_summary)).toBe(true);
    // Step summary carries kind + id but never the workflow body itself.
    const steps = data.step_summary as Array<{ id: string; kind: string }>;
    for (const s of steps) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.kind).toBe("string");
    }
  });

  test("rejects unknown template with the standard error_code", async () => {
    const result = await inspectRecipeTool.execute(STUB_CTX, {
      template_slug: "definitely-not-a-template",
      recipe_slug: "x",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("connector_template_unknown");
  });

  test("rejects unknown recipe and surfaces the available recipe slugs", async () => {
    const result = await inspectRecipeTool.execute(STUB_CTX, {
      template_slug: "stripe",
      recipe_slug: "absolutely-not-a-recipe",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("connector_recipe_unknown");
    const data = result.data as { available_recipes: string[] };
    expect(Array.isArray(data.available_recipes)).toBe(true);
    expect(data.available_recipes).toContain("list-customers");
  });
});
