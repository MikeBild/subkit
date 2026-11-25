import { describe, expect, test } from "bun:test";
import {
  type ConnectorWizard,
  type ConnectorWizardEvent,
  connectorWizardReducer,
} from "./connector-wizard";

type Fields = { name: string; headers: Record<string, string> };
type Step = "service" | "signin";
type Wizard = ConnectorWizard<Fields, Step, string>;
type Event = ConnectorWizardEvent<Fields, Step, string>;

const fresh: Wizard = { step: "service", error: null, fields: { name: "", headers: {} } };
const run = (events: Event[], from: Wizard = fresh) =>
  events.reduce<Wizard>(connectorWizardReducer, from);

describe("connector wizard", () => {
  test("editing a field keeps the step and the error", () => {
    const next = run([
      { type: "fail", error: "Name missing" },
      { type: "edit", key: "name", value: "CRM" },
    ]);
    expect(next).toEqual({
      step: "service",
      error: "Name missing",
      fields: { name: "CRM", headers: {} },
    });
  });

  test("a field can be updated from its current value", () => {
    const next = run([
      { type: "edit", key: "headers", value: { "X-Api-Key": "a" } },
      { type: "edit", key: "headers", value: (current) => ({ ...current, "X-Tenant": "b" }) },
    ]);
    expect(next.fields.headers).toEqual({ "X-Api-Key": "a", "X-Tenant": "b" });
  });

  test("an unchanged value returns the same state", () => {
    expect(connectorWizardReducer(fresh, { type: "edit", key: "name", value: "" })).toBe(fresh);
  });

  test("moving to another step clears the error", () => {
    const next = run([
      { type: "fail", error: "Pick a service" },
      { type: "go", step: "signin" },
    ]);
    expect(next.step).toBe("signin");
    expect(next.error).toBeNull();
  });

  test("reset replaces the whole draft", () => {
    const dirty = run([
      { type: "edit", key: "name", value: "CRM" },
      { type: "go", step: "signin" },
    ]);
    expect(run([{ type: "reset", to: fresh }], dirty)).toBe(fresh);
  });
});
