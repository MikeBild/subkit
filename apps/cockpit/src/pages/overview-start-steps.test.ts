import { describe, expect, test } from "bun:test";
import type { Bootstrap } from "@/api/client";
import { translate } from "@/lib/i18n";
import { startSteps } from "./overview-start-steps";

const OWNER = [
  "connector:write",
  "conversation:write",
  "workflow:read",
  "identity:write",
  "api_key:read",
  "mcp_oauth_client:read",
];

function session(
  permissions: string[],
  done: Partial<Bootstrap["start_steps"]> = {},
): Pick<Bootstrap, "start_steps" | "permissions"> {
  return {
    permissions,
    start_steps: {
      hidden: false,
      connector: false,
      workflow: false,
      run: false,
      people: false,
      client: false,
      ...done,
    },
  };
}

describe("the first steps on the overview", () => {
  test("an owner sees five steps in the decided order, each leading to its place", () => {
    const steps = startSteps(session(OWNER));
    expect(steps.map((step) => step.id)).toEqual([
      "connector",
      "workflow",
      "run",
      "people",
      "client",
    ]);
    expect(steps.map((step) => step.href)).toEqual([
      "/connectors",
      "/chat/new",
      "/workflows",
      "/people",
      "/api-access?section=clients",
    ]);
    expect(steps.map((step) => translate("de", step.title))).toEqual([
      "Einen Dienst verbinden",
      "Ersten Workflow beschreiben",
      "Einmal ausprobieren",
      "Kolleginnen und Kollegen einladen",
      "Claude oder die Kommandozeile verbinden",
    ]);
  });

  test("the done flags come from the session, never from the browser", () => {
    const steps = startSteps(session(OWNER, { connector: true, run: true }));
    expect(steps.map((step) => step.done)).toEqual([true, false, true, false, false]);
  });

  test("a step the person may not perform is left out", () => {
    const member = startSteps(session(["conversation:write", "workflow:read", "api_key:read"]));
    expect(member.map((step) => step.id)).toEqual(["workflow", "run", "client"]);
    expect(member.at(-1)?.href).toBe("/api-access?section=keys");
  });

  test("reading connections alone does not open the API access step", () => {
    expect(startSteps(session(["connection:read"]))).toEqual([]);
  });
});
