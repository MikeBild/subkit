import { describe, expect, test } from "bun:test";
import { evaluateJsBody } from "../conversations/js-transform-eval.ts";
import { planStateWrite } from "../execution/state-write-plan.ts";
import { pruneScopeForJs } from "../sandboxes/quickjs/scope-references.ts";
import { getBuiltinTemplate, loadBuiltinTemplates } from "./templates.ts";

describe("stateful recipes — paths match the request step output (#534)", () => {
  const transformCode = (templateSlug: string, recipeSlug: string) => {
    const recipe = getBuiltinTemplate(templateSlug)!.recipes.find((r) => r.slug === recipeSlug)!;
    const steps = recipe.workflow.steps as Array<{ kind: string; expression?: string }>;
    return steps.find((step) => step.kind === "transform")!.expression!;
  };
  const runTransform = (code: string, scope: Record<string, unknown>, workflowInput: unknown) =>
    evaluateJsBody({ code, scope: pruneScopeForJs(code, scope).scope, input: workflowInput });
  const isoInDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
  const deal = (id: string, dealstage: string, closedate: string) => ({
    id,
    properties: { dealname: `deal-${id}`, dealstage, closedate },
  });

  test("hubspot postmortem sweep returns only closed-lost deals due within N days", async () => {
    const outcome = await runTransform(
      transformCode("hubspot", "postmortem-due-in-n-days-via-state"),
      {
        deals_due: {
          results: [
            deal("1", "closedlost", isoInDays(2)),
            deal("2", "closedwon", isoInDays(2)),
            deal("3", "closedlost", isoInDays(30)),
          ],
        },
        $state: { last_postmortem_swept_at: null },
      },
      { days: 7 },
    );
    expect(outcome.ok).toBe(true);
    const value = (outcome as { value: { deals_in_window: number; deals: { id: string }[] } })
      .value;
    expect(value.deals_in_window).toBe(1);
    expect(value.deals.map((d) => d.id)).toEqual(["1"]);
  });

  test("intercom nurture and stripe incremental transforms read the body directly", async () => {
    const intercom = await runTransform(
      transformCode("intercom", "trial-nurture-day-1-3-7-14-via-state"),
      { due_contacts: { type: "list", data: [{ id: "c1" }, { id: "c2" }] } },
      null,
    );
    expect(intercom.ok).toBe(true);
    expect((intercom as { value: { due_count: number } }).value.due_count).toBe(2);
    const stripe = await runTransform(
      transformCode("stripe", "incremental-charges-via-state"),
      {
        list_new: {
          object: "list",
          data: [
            { id: "ch_new", amount: 300 },
            { id: "ch_old", amount: 200 },
          ],
        },
      },
      null,
    );
    expect(stripe.ok).toBe(true);
    expect((stripe as { value: unknown }).value).toMatchObject({
      new_count: 2,
      newest_id: "ch_new",
      window_amount: 500,
    });
  });

  test("no recipe reads a response envelope or writes an unresolvable state path", () => {
    const offenders = loadBuiltinTemplates().flatMap((template) =>
      template.recipes.flatMap((recipe) =>
        (recipe.workflow.steps as Array<Record<string, unknown>>).flatMap((step) => {
          const where = `${template.slug}/${recipe.slug}/${step.id}`;
          const expression = typeof step.expression === "string" ? step.expression : "";
          const valuePath = (step.state_write as { value_path?: string } | undefined)?.value_path;
          return [
            ...(/input\.scope\.[A-Za-z0-9_$]+\??\.(body|headers)\b|\['_state'\]/.test(expression)
              ? [`${where}: expression reads a response envelope`]
              : []),
            ...(valuePath && (/^(headers|body)\./.test(valuePath) || valuePath.includes("["))
              ? [`${where}: value_path ${valuePath}`]
              : []),
          ];
        }),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("stripe incremental recipe keeps its watermark on an empty page (#541)", () => {
  const stateWrite = () => {
    const recipe = getBuiltinTemplate("stripe")!.recipes.find(
      (r) => r.slug === "incremental-charges-via-state",
    )!;
    const steps = recipe.workflow.steps as Array<{
      id: string;
      state_write?: { key: string; value_path: string };
    }>;
    return steps.find((step) => step.id === "list_new")!.state_write!;
  };

  test("an empty page skips the write", () => {
    expect(planStateWrite({ object: "list", data: [] }, stateWrite().value_path)).toEqual({
      write: false,
    });
  });

  test("a non-empty page writes the newest charge id", () => {
    const page = { object: "list", data: [{ id: "ch_new" }, { id: "ch_old" }] };
    expect(planStateWrite(page, stateWrite().value_path)).toEqual({ write: true, value: "ch_new" });
  });

  test("an explicit null at the path is still written", () => {
    expect(planStateWrite({ data: [{ id: null }] }, stateWrite().value_path)).toEqual({
      write: true,
      value: null,
    });
  });
});
