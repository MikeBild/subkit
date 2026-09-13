// Ink-component coverage for StarterActions + the persona-scoped
// action picker.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_STARTER_ACTIONS,
  StarterActions,
  starterActionsForPersona,
} from "../repl/starter-actions.tsx";
import { renderInk } from "./helpers/ink.tsx";

describe("StarterActions (component)", () => {
  test("default actions render keys 1..5", async () => {
    const ui = renderInk(<StarterActions />);
    try {
      await ui.waitFor((t) => t.includes("5."));
      const txt = ui.text();
      for (const k of ["1.", "2.", "3.", "4.", "5."]) expect(txt).toContain(k);
      expect(txt).toContain("Resume recent");
      expect(txt).toContain("Inspect tenant state");
    } finally {
      ui.unmount();
    }
  });

  test("custom actions prop replaces the defaults", async () => {
    const ui = renderInk(
      <StarterActions
        actions={[
          { key: "a", label: "Alpha", detail: "first" },
          { key: "b", label: "Bravo", detail: "second" },
        ]}
      />,
    );
    try {
      await ui.waitFor((t) => t.includes("a."));
      const txt = ui.text();
      expect(txt).toContain("Alpha");
      expect(txt).toContain("Bravo");
      expect(txt).not.toContain("Resume recent");
    } finally {
      ui.unmount();
    }
  });

  test("portal persona swaps the tenant-state action for accessible-work", () => {
    const actions = starterActionsForPersona("portal");
    expect(actions[3]?.label).toBe("Check accessible work");
  });

  test("enduser persona behaves the same as portal", () => {
    const a = starterActionsForPersona("enduser");
    const b = starterActionsForPersona("portal");
    expect(a).toEqual(b);
  });

  test("admin persona gets the default action list", () => {
    expect(starterActionsForPersona("admin")).toEqual(DEFAULT_STARTER_ACTIONS);
  });
});
