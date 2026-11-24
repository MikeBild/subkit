import { describe, expect, test } from "bun:test";
import { applyResponseFilters, ResponseFilterFailError } from "../execution/response-filter.ts";
import { compileRequestBoundary } from "../workflows/request-boundary.ts";
import type { RequestStep } from "../workflows/types.ts";
import { bindRecipe } from "./recipe-binding.ts";
import { getBuiltinTemplate } from "./templates.ts";

describe("slack recipes (#591)", () => {
  const placeholder = "00000000-0000-0000-0000-000000000000";
  const slack = getBuiltinTemplate("slack")!;
  const requestSteps = slack.recipes.flatMap((recipe) =>
    (recipe.workflow.steps as RequestStep[])
      .filter((step) => step.kind === "request")
      .map((step) => ({ recipe, step, name: `${recipe.slug}/${step.id}` })),
  );

  test("every slack request step binds the slack connector instead of a bare url", () => {
    expect(requestSteps.map((entry) => entry.name).sort()).toEqual([
      "add-reaction/react",
      "auth-test/auth",
      "channel-history/hist",
      "create-channel/create",
      "invite-user/inv",
      "list-channels/list",
      "list-users/list",
      "post-message/post",
      "post-then-pause-then-edit/edit",
      "post-then-pause-then-edit/post",
      "team-info/team",
      "upload-file/up",
    ]);
    const outcomes = requestSteps.map(({ recipe, step, name }) => ({
      name,
      connector_id: step.connector_id,
      url: step.url ?? null,
      required: recipe.required_connectors.map((r) => [r.placeholder, r.template]),
      refusal: compileRequestBoundary(step, slack.base_url).refusal ?? null,
    }));
    expect(outcomes).toEqual(
      outcomes.map((outcome) => ({
        ...outcome,
        connector_id: placeholder,
        url: null,
        required: [[placeholder, "slack"]],
        refusal: null,
      })),
    );
  });

  test("the channel history read approves any channel identifier", () => {
    const history = requestSteps.find((entry) => entry.name === "channel-history/hist")!;
    expect(history.step.boundary?.variables).toEqual({ "input.channel": { class: "identifier" } });
  });

  test("a slack error envelope fails every request step while a success passes", () => {
    for (const { step, name } of requestSteps) {
      expect({
        name,
        thrown: (() => {
          try {
            applyResponseFilters(step.response_filters, { ok: false, error: "not_authed" });
            return null;
          } catch (error) {
            return error instanceof ResponseFilterFailError;
          }
        })(),
      }).toEqual({ name, thrown: true });
      const success = { ok: true, channel: { id: "C123", name: "ops" }, ts: "1714000000.000100" };
      expect(applyResponseFilters(step.response_filters, success)).toEqual(success);
    }
  });

  test("installing a slack recipe binds the one enabled slack connector", () => {
    const connectorId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const templates = new Map([["slack", { name: "Slack", base_url: slack.base_url }]]);
    for (const recipe of slack.recipes) {
      const bound = bindRecipe(
        recipe,
        [
          {
            id: connectorId,
            slug: "slack-ops",
            display_name: "Slack ops",
            template_slug: "slack",
            enabled: true,
          },
        ],
        templates,
      );
      expect(bound.connectors.map((c) => [c.template, c.connector_id])).toEqual([
        ["slack", connectorId],
      ]);
      const ids = (bound.workflow.steps as RequestStep[])
        .filter((step) => step.kind === "request")
        .map((step) => step.connector_id);
      expect(ids.every((id) => id === connectorId)).toBe(true);
    }
  });
});
