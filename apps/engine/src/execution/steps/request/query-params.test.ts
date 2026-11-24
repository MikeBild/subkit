import { describe, expect, test } from "bun:test";
import { getBuiltinTemplate } from "../../../connectors/templates.ts";
import type { Db } from "../../../db/client.ts";
import type { ResolverContext } from "../../../llm/substitution/resolver.ts";
import { resolveRequestQuery } from "./query-params.ts";

const resolverContext = (state: Record<string, unknown>): ResolverContext => ({
  tenant_id: "t",
  environment: "dev",
  db: {} as Db,
  input: { name: "Ada" },
  scope: { $state: state },
});

describe("resolveRequestQuery", () => {
  test("omits a whole-value placeholder that resolves to null (#541)", async () => {
    const query = { limit: 100, starting_after: "${state.cursor}" };
    const result = await resolveRequestQuery(query, resolverContext({ cursor: null }));
    expect(result.value).toEqual({ limit: 100 });
    expect(result.omitted).toEqual(["starting_after"]);
  });

  test("sends the cursor once state is set", async () => {
    const query = { limit: 100, starting_after: "${state.cursor}" };
    const result = await resolveRequestQuery(query, resolverContext({ cursor: "ch_1" }));
    expect(result.value).toEqual({ limit: 100, starting_after: "ch_1" });
    expect(result.omitted).toEqual([]);
  });

  test("keeps embedded placeholders and literal empty strings", async () => {
    const query = { q: "name:${state.cursor}", empty: "", who: "${input.name}" };
    const result = await resolveRequestQuery(query, resolverContext({ cursor: null }));
    expect(result.value).toEqual({ q: "name:", empty: "", who: "Ada" });
  });

  test("stripe incremental recipe sends no empty cursor on its first run", async () => {
    const recipe = getBuiltinTemplate("stripe")!.recipes.find(
      (candidate) => candidate.slug === "incremental-charges-via-state",
    )!;
    const step = recipe.workflow.steps[0] as {
      query: Record<string, unknown>;
      state_read: { into_var: string; default_value: unknown };
      state_write: { value_path: string };
    };
    const result = await resolveRequestQuery(
      step.query,
      resolverContext({ [step.state_read.into_var]: step.state_read.default_value }),
    );
    expect(Object.values(result.value)).not.toContain("");
    expect(step.query.ending_before).toBe("${state.last_synced_charge_id}");
    expect(step.state_write.value_path).toBe("body.data[0].id");
  });
});
