import { describe, expect, test } from "bun:test";
import { hasRuntimeValue, supportsReadQuery } from "../workflows/report-delivery-boundary.ts";
import { compileRequestBoundary } from "../workflows/request-boundary.ts";
import type { RequestStep } from "../workflows/types.ts";
import { getSolutionRecipe } from "./solutions.ts";
import { getBuiltinTemplate } from "./templates.ts";

describe("drive solution request boundaries (#588)", () => {
  test("every runtime request step of the Drive solution is covered by a boundary or the read query", () => {
    const recipe = getSolutionRecipe("invoice-attachments-to-drive")!;
    const outcomes = (recipe.workflow.steps as RequestStep[])
      .filter((step) => step.kind === "request" && hasRuntimeValue(step))
      .map((step) => {
        const template = recipe.required_connectors.find(
          (required) => required.placeholder === step.connector_id,
        )?.template;
        const baseUrl = template ? (getBuiltinTemplate(template)?.base_url ?? null) : null;
        const refusal = compileRequestBoundary(step, baseUrl).refusal ?? null;
        const readQuery = refusal === "no_boundary" && !step.boundary && supportsReadQuery(step);
        return { step: step.id, refusal: readQuery ? null : refusal };
      });
    expect(outcomes.map((outcome) => outcome.step)).toEqual([
      "list_messages",
      "fetch_message",
      "download_attachment",
      "find_folder",
      "create_folder",
      "upload_file",
    ]);
    expect(outcomes).toEqual(outcomes.map((outcome) => ({ ...outcome, refusal: null })));
  });
});
