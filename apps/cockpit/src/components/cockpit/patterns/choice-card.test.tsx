import { describe, expect, test } from "bun:test";
import { ChoiceCard } from "./choice-card";
import { DIALOG_FRAME, FILLED_DESTRUCTIVE } from "./form-dialog";
import { render } from "./test-utils";

describe("P14 ChoiceCard", () => {
  test("a full-width button with title and one line", () => {
    const html = render(
      <ChoiceCard
        icon={<svg />}
        title="Im Chat beschreiben"
        line="SubKit entwirft ihn aus deiner Beschreibung."
        onSelect={() => {}}
        testId="way-chat"
      />,
    );
    expect(html).toMatch(/<button[^>]*type="button"[^>]*w-full/);
    expect(html).toContain('data-slot="choice-card"');
    expect(html).toContain('data-testid="way-chat"');
    expect(html).toContain("Im Chat beschreiben");
    expect(html).toContain("SubKit entwirft ihn aus deiner Beschreibung.");
  });
});

describe("P13/P14 dialog frame", () => {
  test("under 640px a dialog is a full-width sheet from the bottom edge", () => {
    for (const rule of ["max-sm:bottom-0", "max-sm:w-full", "max-sm:max-w-full", "max-sm:top-auto"])
      expect(DIALOG_FRAME.split(" ")).toContain(rule);
  });

  test("the verb that removes is filled red", () => {
    expect(FILLED_DESTRUCTIVE.split(" ")).toContain("bg-destructive");
  });
});
