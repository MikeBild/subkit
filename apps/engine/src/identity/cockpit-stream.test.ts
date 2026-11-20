import { describe, expect, test } from "bun:test";
import { cockpitEventTouchesAttention, projectCockpitEvent } from "./cockpit-stream.ts";

const WORKFLOW = "11111111-1111-4111-8111-111111111111";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CANDIDATE = "88888888-8888-4888-8888-888888888888";
const TASK = "55555555-5555-4555-8555-555555555555";

describe("cockpit stream notification target", () => {
  test("a connector notification names the attention item of its connector", () => {
    for (const type of ["connector.auth_failed", "connector.health_changed"])
      expect(
        projectCockpitEvent({
          type,
          payload: {
            connector_id: CONNECTOR,
            connector_slug: "hubspot",
            reason: "token expired",
            reauth_url: "https://subkit.example/reauth",
          },
        }),
      ).toEqual({ connector_id: CONNECTOR, attention_id: `connector:${CONNECTOR}` });
  });

  test("a repair notification names the attention item of its workflow", () => {
    for (const type of ["patch.proposed", "patch.applied"])
      expect(
        projectCockpitEvent({
          type,
          payload: {
            patch_candidate_id: CANDIDATE,
            workflow_id: WORKFLOW,
            classification: "schema_drift",
          },
        }),
      ).toEqual({
        workflow_id: WORKFLOW,
        patch_candidate_id: CANDIDATE,
        attention_id: `workflow:${WORKFLOW}`,
      });
  });

  test("stays id-only: no title, reason or address leaves the engine", () => {
    const projected = projectCockpitEvent({
      type: "connector.auth_failed",
      payload: { connector_id: CONNECTOR, connector_slug: "hubspot", reason: "boom" },
    });
    expect(Object.keys(projected).sort()).toEqual(["attention_id", "connector_id"]);
  });

  test("an event without its subject id or of another kind gets no target", () => {
    expect(projectCockpitEvent({ type: "connector.auth_failed", payload: {} })).toEqual({});
    expect(
      projectCockpitEvent({
        type: "connector.auth_failed",
        payload: { connector_id: "not an id" },
      }),
    ).toEqual({});
    expect(
      projectCockpitEvent({ type: "workflow.changed", payload: { workflow_id: WORKFLOW } }),
    ).toEqual({ workflow_id: WORKFLOW });
  });

  test("task, schedule and connector changes name their attention item as well", () => {
    for (const type of ["task.changed", "task.grant_changed", "task_run.changed"])
      expect(projectCockpitEvent({ type, payload: { task_id: TASK } }).attention_id).toBe(
        `task:${TASK}`,
      );
    expect(
      projectCockpitEvent({
        type: "workflow.automation_changed",
        payload: { workflow_id: WORKFLOW },
      }).attention_id,
    ).toBe(`workflow:${WORKFLOW}`);
    for (const type of ["connector.credential_changed", "connector.oauth.callback_failed"])
      expect(projectCockpitEvent({ type, payload: { connector_id: CONNECTOR } }).attention_id).toBe(
        `connector:${CONNECTOR}`,
      );
  });

  test("only the progress of a run leaves the attention list untouched", () => {
    for (const type of [
      "execution.queued",
      "execution.started",
      "execution.running",
      "execution.step.started",
      "execution.step.finished",
      "execution.abort_requested",
    ])
      expect(cockpitEventTouchesAttention(type)).toBe(false);
    for (const type of [
      "execution.failed",
      "execution.succeeded",
      "connector.auth_failed",
      "patch.proposed",
      "task_run.changed",
      "settings.changed",
    ])
      expect(cockpitEventTouchesAttention(type)).toBe(true);
  });
});
