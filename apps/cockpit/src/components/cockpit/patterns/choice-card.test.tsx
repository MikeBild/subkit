import { describe, expect, test } from "bun:test";
import { ChoiceCards } from "./choice-card";
import { DIALOG_BODY, DIALOG_FRAME, dialogWidthClass, FILLED_DESTRUCTIVE } from "./dialog-frame";
import { render } from "./test-utils";

describe("P22 ChoiceCards", () => {
  const items = [
    {
      icon: <svg />,
      title: "Im Chat beschreiben",
      line: "SubKit entwirft ihn aus deiner Beschreibung.",
      onSelect() {},
      testId: "way-chat",
    },
    {
      icon: <svg />,
      title: "Von Hand anlegen",
      line: "Name, Auslöser und Kategorie.",
      onSelect() {},
      testId: "way-manual",
    },
  ];

  test("equal full-width buttons, each titled and described by its own words", () => {
    const html = render(<ChoiceCards items={items} />);
    expect(html.match(/<button[^>]*type="button"/g)?.length).toBe(2);
    expect(html).toMatch(/data-slot="choices"[^>]*/);
    expect(html).toContain("sm:grid-cols-2");
    for (const item of items) {
      expect(html).toContain(`data-testid="${item.testId}"`);
      expect(html).toContain(item.title);
      expect(html).toContain(item.line);
    }
    expect(html).toContain("aria-labelledby=");
    expect(html).toContain("aria-describedby=");
  });
});

describe("P13/P14 dialog anatomy", () => {
  test("two widths, 512px and 576px", () => {
    expect(dialogWidthClass("default")).toBe("sm:max-w-lg");
    expect(dialogWidthClass("wide")).toBe("sm:max-w-xl");
  });

  test("under 640px a dialog is a full-width sheet from the bottom edge", () => {
    for (const rule of ["max-sm:bottom-0", "max-sm:w-full", "max-sm:max-w-full", "max-sm:top-auto"])
      expect(DIALOG_FRAME.split(" ")).toContain(rule);
  });

  test("the body scrolls, and a segmented choice in it spans the field width", () => {
    expect(DIALOG_BODY.split(" ")).toContain("overflow-auto");
    expect(DIALOG_BODY).toContain("[&_[data-slot=segmented-control]]:w-full");
  });

  test("the verb that removes is filled red", () => {
    expect(FILLED_DESTRUCTIVE.split(" ")).toContain("bg-destructive");
  });
});
