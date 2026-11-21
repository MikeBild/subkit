import { describe, expect, test } from "bun:test";
import { RESOURCE_CHANGE_TYPES } from "../pubsub/resource-changes.ts";
import {
  COCKPIT_STREAM_FAMILIES,
  cockpitEventTouchesAttention,
  projectCockpitEvent,
  projectCockpitPayload,
} from "./cockpit-stream.ts";

const WORKFLOW = "11111111-1111-4111-8111-111111111111";
const CONNECTOR = "33333333-3333-4333-8333-333333333333";
const CANDIDATE = "88888888-8888-4888-8888-888888888888";
const TASK = "55555555-5555-4555-8555-555555555555";
const DEVICE = "66666666-6666-4666-8666-666666666666";
const EXECUTION = "77777777-7777-4777-8777-777777777777";
const CONFIRMATION = "99999999-9999-4999-8999-999999999999";
const COMMAND = "a".repeat(64);

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

  test("a finished connector sign-in carries its outcome and a known reason, nothing else", () => {
    expect(
      projectCockpitEvent({
        type: "connector.oauth.signin_finished",
        payload: {
          connector_id: CONNECTOR,
          connector_slug: "gmail",
          outcome: "failed",
          reason: "provider_error",
        },
      }),
    ).toEqual({
      connector_id: CONNECTOR,
      attention_id: `connector:${CONNECTOR}`,
      outcome: "failed",
      reason: "provider_error",
    });
    expect(
      projectCockpitEvent({
        type: "connector.oauth.signin_finished",
        payload: { connector_id: CONNECTOR, outcome: "succeeded", reason: "<script>" },
      }),
    ).toEqual({
      connector_id: CONNECTOR,
      attention_id: `connector:${CONNECTOR}`,
      outcome: "succeeded",
    });
    expect(
      projectCockpitEvent({
        type: "connector.oauth.callback_failed",
        payload: { connector_id: CONNECTOR, outcome: "failed" },
      }),
    ).toEqual({ connector_id: CONNECTOR, attention_id: `connector:${CONNECTOR}` });
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

describe("device and local confirmation stream families", () => {
  const typesFor = (permission: string) =>
    COCKPIT_STREAM_FAMILIES.filter(
      (family) => family.permission === permission && family.channel === "resource.lifecycle",
    ).flatMap((family) => family.types ?? []);

  test("device changes reach device readers only", () => {
    expect(typesFor("device:read")).toEqual([
      "device.online",
      "device.offline",
      "device.command",
      "device.session_ended",
    ]);
  });

  test("a run waiting for its device reaches run readers", () => {
    expect(typesFor("execution:read")).toEqual(["execution.waiting_for_device"]);
  });

  test("a requested confirmation reaches only people who may confirm", () => {
    expect(typesFor("local:confirm")).toEqual(["local.confirmation_requested"]);
  });

  test("every resource change type has a family besides the audit log", () => {
    const covered = new Set(
      COCKPIT_STREAM_FAMILIES.filter((family) => family.permission !== "audit:read").flatMap(
        (family) => family.types ?? [],
      ),
    );
    expect(RESOURCE_CHANGE_TYPES.filter((type) => !covered.has(type))).toEqual([]);
  });

  test("device, command and confirmation ids leave the engine, a full sha256 included", () => {
    expect(
      projectCockpitPayload({
        device_id: DEVICE,
        command_id: COMMAND,
        confirmation_id: CONFIRMATION,
        execution_id: EXECUTION,
        relative_path: "Rechnungen/2026.pdf",
        device_label: "MacBook Pro (Mike)",
      }),
    ).toEqual({
      execution_id: EXECUTION,
      device_id: DEVICE,
      command_id: COMMAND,
      confirmation_id: CONFIRMATION,
    });
  });

  test("a device going on or off line names its attention item", () => {
    for (const type of ["device.online", "device.offline"])
      expect(projectCockpitEvent({ type, payload: { device_id: DEVICE } }).attention_id).toBe(
        `device:${DEVICE}`,
      );
    expect(
      projectCockpitEvent({ type: "device.command", payload: { device_id: DEVICE } }).attention_id,
    ).toBeUndefined();
  });

  test("command progress leaves the attention list untouched, a waiting run does not", () => {
    expect(cockpitEventTouchesAttention("device.command")).toBe(false);
    for (const type of [
      "device.online",
      "device.offline",
      "local.confirmation_requested",
      "execution.waiting_for_device",
    ])
      expect(cockpitEventTouchesAttention(type)).toBe(true);
  });
});
