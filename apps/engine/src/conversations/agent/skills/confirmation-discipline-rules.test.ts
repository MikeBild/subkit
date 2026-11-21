import { describe, expect, test } from "bun:test";
import confirmationDiscipline from "./content/confirmation-discipline.md" with { type: "text" };

describe("confirmation-discipline skill body — hard-rule pins", () => {
  test("dangerous tools always ask, with no mode that bypasses the gate", () => {
    expect(confirmationDiscipline).toMatch(
      /Dangerous tools \(delete_\*, revoke_\*, approve_\*\) ALWAYS require an explicit `ask_user_confirm`; nothing skips that gate/,
    );
    expect(confirmationDiscipline).not.toContain("yolo");
    expect(confirmationDiscipline).not.toContain("permission_mode");
  });
});
