import { describe, expect, test } from "bun:test";
import confirmationDiscipline from "./content/confirmation-discipline.md" with { type: "text" };

describe("confirmation-discipline skill body — hard-rule pins", () => {
  test("names the audited yolo exception instead of claiming the gate cannot be bypassed", () => {
    expect(confirmationDiscipline).toMatch(
      /Dangerous tools \(delete_\*, revoke_\*, approve_\*\) STILL require an explicit `ask_user_confirm` in every mode except `yolo`, where the bypass is audited/,
    );
    expect(confirmationDiscipline).not.toContain("cannot be bypassed by permission_mode");
  });

  test("keeps the other permission modes on the structured gate", () => {
    expect(confirmationDiscipline).toMatch(/`auto`, `ask` and `plan` cannot skip that gate/);
  });
});
