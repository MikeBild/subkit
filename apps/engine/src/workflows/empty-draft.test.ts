import { describe, expect, test } from "bun:test";
import { authorityRejection } from "../api/operations/workflow-authorities.ts";
import type { Executor } from "../db/client.ts";
import { diagnoseWorkflow } from "./gate-diagnosis.ts";
import { executableDefinition, hasNoSteps } from "./stored-definition.ts";

const WORKFLOW = "4871b9b9-d523-4c9b-a9e4-786c9af2d424";
const DRAFT = "2f3ca500-7e94-4cf2-a4d2-9333c0cd87dc";
const unusedDb = {} as Executor;

describe("a draft with no steps yet", () => {
  test("counts as having no steps, unlike a missing or filled step list", () => {
    expect(hasNoSteps({ name: "Returns intake", steps: [] })).toBe(true);
    expect(hasNoSteps({ name: "Returns intake" })).toBe(false);
    expect(hasNoSteps({ name: "Returns intake", steps: [{ id: "a" }] })).toBe(false);
    expect(hasNoSteps(null)).toBe(false);
  });

  test("has nothing to diagnose and reads no further history", async () => {
    const diagnosis = await diagnoseWorkflow(unusedDb, "tenant", WORKFLOW, "dev", {
      workflow: { current_version_id: null, draft_version_id: DRAFT },
      definition: { name: "Returns intake", steps: [] },
    });
    expect(diagnosis).toEqual({
      workflow_id: WORKFLOW,
      workflow_version_id: DRAFT,
      environment: "dev",
      is_current: false,
      diagnoses: [],
    });
  });

  test("an authority preview of it is refused with 409, not a server error", () => {
    let thrown: unknown = null;
    try {
      executableDefinition({ name: "Returns intake", steps: [] });
    } catch (error) {
      thrown = error;
    }
    expect(authorityRejection(thrown)).toMatchObject({
      status: 409,
      code: "workflow_version_invalid",
    });
  });
});
