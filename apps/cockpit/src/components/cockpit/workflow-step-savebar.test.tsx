import { expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { StepSaveBarView } from "@/features/workflows/ui/workflow-step-editor";

const noop = () => {};

function bar(conflict: boolean, locale: "de" | "en" = "de") {
  return render(
    <StepSaveBarView
      changes={2}
      conflict={conflict}
      pending={false}
      onSave={noop}
      onDiscard={noop}
      onReload={noop}
    />,
    locale,
  );
}

test("a conflicting save keeps the bar open with reload as its only action", () => {
  const html = bar(true);
  expect(html).toContain('data-state="conflict"');
  expect(html).toContain("Inzwischen wurde eine neuere Version");
  expect(html).toContain('data-testid="step-savebar-reload"');
  expect(html).toContain("Neu laden");
  expect(html).not.toContain('data-testid="step-savebar-save"');
  expect(html).not.toContain('data-testid="step-savebar-discard"');
  expect(bar(true, "en")).toContain("Reload");
});

test("unsaved changes without a conflict offer save and discard", () => {
  const html = bar(false);
  expect(html).toContain('data-state="dirty"');
  expect(html).toContain("2 ungespeicherte Änderungen");
  expect(html).toContain('data-testid="step-savebar-save"');
  expect(html).toContain('data-testid="step-savebar-discard"');
  expect(html).not.toContain('data-testid="step-savebar-reload"');
});
